/**
 * Agent Session Manager
 *
 * Handles spawning AI coding agents (Claude, Codex, Gemini) as subprocesses
 * and relaying their input/output to the Styrby mobile app via Supabase Realtime.
 *
 * ## Architecture
 *
 * ```
 * Phone (Styrby App)
 *       │
 *       │ Supabase Realtime
 *       ▼
 * AgentSession (this module)
 *       │
 *       │ stdin/stdout/stderr
 *       ▼
 * Agent CLI (claude/codex/gemini)
 *       │
 *       │ API calls
 *       ▼
 * AI Provider (Anthropic/OpenAI/Google)
 * ```
 *
 * @module session/agent-session
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/ui/logger';
import {
  type AgentType,
  getAgentStatus,
  getAgentSpawnCommand,
  type AgentStatus,
} from '@/auth/agent-credentials';
import { RelayClient, createRelayClient } from 'styrby-shared';
import { SessionStorage, type SessionStatus } from './session-storage';

// ============================================================================
// Constants
// ============================================================================

/**
 * Minimum offline duration (ms) before a reconnect triggers a push notification.
 *
 * WHY 5 minutes: Short blips (Wi-Fi handoff, sleep/wake, pocket-mode disconnects)
 * resolve within seconds. Notifying for those would be noisy and meaningless.
 * 5 minutes is the threshold where the user has likely switched context — moved
 * away from their desk, gone to a meeting, put the phone down — and genuinely
 * needs a "the daemon is back" signal to know they can resume the session.
 * This matches the industry heuristic used by Slack, GitHub Actions, and
 * other developer tools that suppress flap notifications below 5 minutes.
 */
export const OFFLINE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// ============================================================================
// Types
// ============================================================================

/**
 * Session configuration
 */
export interface SessionConfig {
  /** Agent type to spawn */
  agent: AgentType;
  /** Working directory for the agent */
  cwd: string;
  /** User ID (for Realtime channel) */
  userId: string;
  /**
   * Machine ID — identifies the developer's registered machine.
   *
   * WHY machineId is distinct from sessionId: `machineId` is a durable
   * identifier for a physical or virtual developer workstation (persisted in
   * the `machines` table). `sessionId` identifies a single agent run on that
   * machine (persisted in the `sessions` table). Confusing the two caused a
   * bug where `sendToMobile()` sent `machineId` as `session_id` in relay
   * payloads, so mobile received the machine UUID where it expected a session
   * UUID, breaking resume, history, and scoped notifications.
   */
  machineId: string;
  /** Machine name for display */
  machineName: string;
  /** Supabase client */
  supabase: SupabaseClient;
  /**
   * Optional pre-wired `SessionStorage` instance for DB persistence.
   *
   * When provided, `AgentSession` writes session lifecycle transitions
   * (state, last_seen_at) to Supabase so the mobile app can display accurate
   * connection status and re-attach via `styrby resume`.
   */
  storage?: SessionStorage;
  /** Initial prompt to send (optional) */
  initialPrompt?: string;
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Session state
 */
export type SessionState =
  | 'initializing'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'error';

/**
 * Session statistics
 */
export interface SessionStats {
  /** When session started */
  startedAt: Date;
  /** Total bytes received from agent */
  bytesReceived: number;
  /** Total bytes sent to agent */
  bytesSent: number;
  /** Number of messages from mobile */
  messagesFromMobile: number;
  /** Number of messages to mobile */
  messagesToMobile: number;
}

/**
 * Session events
 */
export interface SessionEvents {
  /** Session state changed */
  stateChange: { state: SessionState; previousState: SessionState };
  /** Output received from agent */
  output: { data: string; stream: 'stdout' | 'stderr' };
  /** Agent process exited */
  exit: { code: number | null; signal: string | null };
  /** Error occurred */
  error: { message: string; error?: Error };
  /** Mobile device connected */
  mobileConnected: { deviceId: string; deviceName?: string };
  /** Mobile device disconnected */
  mobileDisconnected: { deviceId: string };
  /** Message received from mobile */
  messageFromMobile: { content: string };
  /**
   * Daemon reconnected after being offline for longer than OFFLINE_THRESHOLD_MS.
   *
   * WHY: When the relay reconnects after a short blip we stay silent. Only
   * when offline duration exceeds the threshold (5 min by default) do we emit
   * this event, which triggers a push notification so the user knows they can
   * resume their session. See reconnectNotifier.ts for the push logic.
   */
  'reconnected-after-offline': { offlineDurationMs: number };
}

// ============================================================================
// Agent Session Class
// ============================================================================

/**
 * Manages a single agent session.
 *
 * Spawns the agent CLI, connects to Supabase Realtime for mobile relay,
 * and handles bidirectional message flow.
 */
export class AgentSession extends EventEmitter {
  private config: SessionConfig;
  private state: SessionState = 'initializing';
  private process: ChildProcess | null = null;
  private relay: RelayClient | null = null;
  private agentStatus: AgentStatus | null = null;
  private stats: SessionStats;
  private outputBuffer: string = '';

  /**
   * Timestamp set when the relay emits `disconnected`. Cleared (set to null)
   * after a successful reconnect that triggers the push notification.
   *
   * WHY: We only want to notify when the daemon has been offline long enough
   * that the user has likely left context. Recording `disconnected` time lets
   * us measure exact offline duration on `subscribed` so we can suppress
   * ephemeral blips (Wi-Fi handoff, sleep/wake) below OFFLINE_THRESHOLD_MS.
   */
  private lastOfflineAt: Date | null = null;

  /**
   * UUID for this specific agent session run.
   *
   * WHY this field exists: Previously, `sendToMobile()` used
   * `this.config.machineId` as `session_id` in relay payloads. That sent the
   * machine UUID where mobile expected a session UUID, breaking resume,
   * per-session history, and scoped push notifications. `sessionId` is
   * generated fresh at `start()` via `crypto.randomUUID()`, distinct from
   * `machineId` (which identifies the developer's machine, not this run).
   *
   * Set to empty string until `start()` is called so the field is always
   * defined and TypeScript callers do not need null checks.
   */
  private sessionId: string = '';

  constructor(config: SessionConfig) {
    super();
    this.config = config;
    this.stats = {
      startedAt: new Date(),
      bytesReceived: 0,
      bytesSent: 0,
      messagesFromMobile: 0,
      messagesToMobile: 0,
    };
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Start the session.
   *
   * 1. Verifies agent is installed
   * 2. Connects to Supabase Realtime
   * 3. Spawns the agent process
   * 4. Sets up message relay
   */
  async start(): Promise<void> {
    if (this.state !== 'initializing') {
      throw new Error(`Cannot start session in state: ${this.state}`);
    }

    this.setState('starting');

    try {
      // Check agent is installed
      this.agentStatus = await getAgentStatus(this.config.agent);
      if (!this.agentStatus.installed) {
        throw new Error(`${this.agentStatus.name} is not installed`);
      }

      // Generate a real session UUID distinct from the machine ID.
      // WHY: machineId identifies the developer's machine (durable, reused
      // across sessions). sessionId identifies THIS specific agent run.
      // Using machineId as session_id in relay payloads caused mobile to
      // misroute session history, resume, and scoped notifications.
      this.sessionId = crypto.randomUUID();

      this.log('Starting session', {
        agent: this.config.agent,
        cwd: this.config.cwd,
        sessionId: this.sessionId,
      });

      // Connect to Realtime for mobile relay
      await this.connectRelay();

      // Spawn the agent process
      await this.spawnAgent();

      this.setState('running');
      this.log('Session started', { sessionId: this.sessionId });
    } catch (error) {
      this.setState('error');
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.emit('error', { message, error: error instanceof Error ? error : undefined });
      throw error;
    }
  }

  /**
   * Stop the session gracefully.
   */
  async stop(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'stopping') {
      return;
    }

    this.setState('stopping');
    this.log('Stopping session');

    // Kill the agent process
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');

      // Force kill after 5 seconds if still running
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL');
        }
      }, 5000);
    }

    // Disconnect relay
    if (this.relay) {
      await this.relay.disconnect();
      this.relay = null;
    }

    this.setState('stopped');
    this.log('Session stopped');
  }

  /**
   * Send input to the agent.
   *
   * @param input - Text to send to agent's stdin
   */
  sendToAgent(input: string): void {
    if (!this.process || !this.process.stdin) {
      this.log('Cannot send to agent: process not running');
      return;
    }

    this.process.stdin.write(input);
    this.stats.bytesSent += Buffer.byteLength(input);
    this.log('Sent to agent', { bytes: Buffer.byteLength(input) });
  }

  /**
   * Send a line of input to the agent (with newline).
   *
   * @param line - Line to send
   */
  sendLineToAgent(line: string): void {
    this.sendToAgent(line + '\n');
  }

  /**
   * Get current session state.
   */
  getState(): SessionState {
    return this.state;
  }

  /**
   * Get session statistics.
   */
  getStats(): SessionStats {
    return { ...this.stats };
  }

  /**
   * Get agent status.
   */
  getAgentStatus(): AgentStatus | null {
    return this.agentStatus;
  }

  /**
   * Check if mobile is connected.
   */
  isMobileConnected(): boolean {
    return this.relay?.isDeviceTypeOnline('mobile') ?? false;
  }

  /**
   * Get the session UUID for this run.
   *
   * Returns an empty string if called before `start()`.
   * Use this value (not `config.machineId`) wherever a `session_id` FK is
   * expected — relay payloads, Supabase writes, resume tokens.
   */
  getSessionId(): string {
    return this.sessionId;
  }

  // --------------------------------------------------------------------------
  // Private: Relay Connection
  // --------------------------------------------------------------------------

  /**
   * Connect to Supabase Realtime for mobile relay.
   */
  private async connectRelay(): Promise<void> {
    this.relay = createRelayClient({
      supabase: this.config.supabase,
      userId: this.config.userId,
      deviceId: this.config.machineId,
      deviceType: 'cli',
      deviceName: this.config.machineName,
      platform: process.platform,
      debug: this.config.debug,
    });

    // Handle messages from mobile
    this.relay.on('message', (message) => {
      this.handleMobileMessage(message);
    });

    // Handle mobile presence
    this.relay.on('presence_join', (presence) => {
      if (presence.device_type === 'mobile') {
        this.emit('mobileConnected', {
          deviceId: presence.device_id,
          deviceName: presence.device_name,
        });
      }
    });

    this.relay.on('presence_leave', (data) => {
      this.emit('mobileDisconnected', { deviceId: data.device_id });
    });

    // -----------------------------------------------------------------------
    // Persist relay lifecycle transitions to Supabase.
    //
    // WHY: When the daemon disconnects and reconnects, the sessions table row
    // remains stale unless we write the transition. Mobile has no way to tell
    // "agent is back on the same session" vs "brand new session" without an
    // updated status + last_seen_at. These handlers feed `updateState()` so
    // the phone can display accurate connection status ("Reconnecting…",
    // "Session last seen 4 min ago") and `styrby resume` can re-attach to
    // the correct session row.
    // -----------------------------------------------------------------------
    this.relay.on('subscribed', () => {
      this.persistRelayState('running').catch((err) =>
        this.log('Failed to persist relay connected state', { err })
      );

      // Check if we were offline long enough to notify the user.
      // WHY: Only notify when lastOfflineAt is set (i.e. we went through
      // 'disconnected' before this 'subscribed') and the duration exceeds
      // OFFLINE_THRESHOLD_MS. This suppresses ephemeral blips (sleep/wake,
      // Wi-Fi handoff) that resolve in seconds and are meaningless to the user.
      if (this.lastOfflineAt !== null) {
        const offlineDurationMs = Date.now() - this.lastOfflineAt.getTime();
        if (offlineDurationMs > OFFLINE_THRESHOLD_MS) {
          this.emit('reconnected-after-offline', { offlineDurationMs });
        }
        // Reset regardless — each offline window is tracked independently.
        this.lastOfflineAt = null;
      }
    });

    this.relay.on('disconnected', () => {
      // Record disconnect timestamp so we can measure offline duration on
      // the next 'subscribed' event. We intentionally overwrite any previous
      // value: if the relay bounces multiple times while still offline, the
      // first disconnect timestamp is the one that matters for duration.
      if (this.lastOfflineAt === null) {
        this.lastOfflineAt = new Date();
        this.log('Relay disconnected, tracking offline start', {
          lastOfflineAt: this.lastOfflineAt.toISOString(),
        });
      }
    });

    this.relay.on('reconnecting', () => {
      // WHY 'paused': the agent process is still alive; only the relay link
      // is interrupted. "paused" is the closest DB session_status value.
      this.persistRelayState('paused').catch((err) =>
        this.log('Failed to persist relay reconnecting state', { err })
      );
    });

    this.relay.on('error', () => {
      this.persistRelayState('error').catch((err) =>
        this.log('Failed to persist relay error state', { err })
      );
    });

    this.relay.on('closed', () => {
      // 'closed' fires on manual disconnect (stop()). We do NOT call
      // persistRelayState here because stop() already calls SessionStorage
      // methods that transition the session to 'stopped'.
      this.log('Relay closed');
    });

    // Connect
    await this.relay.connect();
    this.log('Relay connected');

    // Update presence with session info — include the real sessionId so
    // mobile presence state reflects the correct session UUID (not machineId).
    await this.relay.updatePresence({
      active_agent: this.config.agent,
      session_id: this.sessionId,
    });
  }

  /**
   * Handle incoming message from mobile.
   */
  private handleMobileMessage(message: { type: string; payload?: unknown }): void {
    this.stats.messagesFromMobile++;

    switch (message.type) {
      case 'chat': {
        const payload = message.payload as { content?: string };
        if (payload?.content) {
          this.emit('messageFromMobile', { content: payload.content });
          this.sendLineToAgent(payload.content);
        }
        break;
      }

      case 'command': {
        const payload = message.payload as { action?: string };
        if (payload?.action === 'cancel' || payload?.action === 'interrupt') {
          // Send Ctrl+C to agent
          if (this.process) {
            this.process.kill('SIGINT');
          }
        } else if (payload?.action === 'end_session') {
          this.stop();
        }
        break;
      }

      default:
        this.log('Unknown message type', { type: message.type });
    }
  }

  /**
   * Send output to mobile via relay.
   */
  private async sendToMobile(content: string, isError: boolean = false): Promise<void> {
    if (!this.relay || !this.relay.isConnected()) {
      return;
    }

    try {
      await this.relay.send({
        type: 'agent_response',
        payload: {
          content,
          agent: this.config.agent,
          // WHY sessionId (not machineId): machineId identifies the developer's
          // machine. sessionId identifies this specific agent run. Previously
          // machineId was sent here, causing mobile to misroute history, resume,
          // and scoped notifications. Fixed in PR-3 (Phase 1.6.2).
          session_id: this.sessionId,
          is_streaming: true,
          is_complete: false,
        },
      });
      this.stats.messagesToMobile++;
    } catch (error) {
      this.log('Failed to send to mobile', { error });
    }
  }

  // --------------------------------------------------------------------------
  // Private: Agent Process
  // --------------------------------------------------------------------------

  /**
   * Spawn the agent CLI process.
   */
  private async spawnAgent(): Promise<void> {
    const { command, args } = getAgentSpawnCommand(this.config.agent, {
      cwd: this.config.cwd,
      interactive: true,
      prompt: this.config.initialPrompt,
    });

    this.log('Spawning agent', { command, args });

    this.process = spawn(command, args, {
      cwd: this.config.cwd,
      env: {
        ...process.env,
        // Force color output for better mobile display
        FORCE_COLOR: '1',
        // Indicate we're running under Styrby
        STYRBY_SESSION: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Handle stdout
    this.process.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      this.stats.bytesReceived += data.length;

      this.emit('output', { data: text, stream: 'stdout' });
      this.sendToMobile(text, false);

      // Buffer output for potential parsing
      this.outputBuffer += text;
      if (this.outputBuffer.length > 10000) {
        this.outputBuffer = this.outputBuffer.slice(-5000);
      }
    });

    // Handle stderr
    this.process.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      this.stats.bytesReceived += data.length;

      this.emit('output', { data: text, stream: 'stderr' });
      this.sendToMobile(text, true);
    });

    // Handle process exit
    this.process.on('exit', (code, signal) => {
      this.log('Agent process exited', { code, signal });
      this.emit('exit', { code, signal });

      if (this.state === 'running') {
        this.setState('stopped');
      }
    });

    // Handle process error
    this.process.on('error', (error) => {
      this.log('Agent process error', { error: error.message });
      this.emit('error', { message: error.message, error });

      if (this.state === 'running' || this.state === 'starting') {
        this.setState('error');
      }
    });
  }

  // --------------------------------------------------------------------------
  // Private: Helpers
  // --------------------------------------------------------------------------

  /**
   * Persist a relay connection state transition to Supabase.
   *
   * Called from relay event listeners (subscribed, reconnecting, error) so
   * the sessions table row stays in sync with the actual connection state.
   * No-ops silently when `config.storage` is not provided or when `sessionId`
   * has not yet been assigned (before `start()` completes).
   *
   * @param state - The `session_status` value to write
   */
  private async persistRelayState(state: SessionStatus): Promise<void> {
    if (!this.config.storage || !this.sessionId) {
      return;
    }

    await this.config.storage.updateState({
      sessionId: this.sessionId,
      state,
      lastSeenAt: new Date().toISOString(),
    });

    this.log('Persisted relay state', { sessionId: this.sessionId, state });
  }

  /**
   * Update session state and emit event.
   */
  private setState(newState: SessionState): void {
    const previousState = this.state;
    this.state = newState;
    this.emit('stateChange', { state: newState, previousState });
  }

  /**
   * Log with session context.
   */
  private log(message: string, data?: Record<string, unknown>): void {
    if (this.config.debug) {
      logger.debug(`[Session:${this.config.agent}] ${message}`, data);
    }
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create and start an agent session.
 *
 * @param config - Session configuration
 * @returns Started agent session
 *
 * @example
 * const session = await createAgentSession({
 *   agent: 'claude',
 *   cwd: process.cwd(),
 *   userId: 'user-123',
 *   machineId: 'machine-456',
 *   machineName: 'MacBook-Pro',
 *   supabase: supabaseClient,
 * });
 *
 * session.on('output', ({ data }) => {
 *   process.stdout.write(data);
 * });
 *
 * // Later...
 * await session.stop();
 */
export async function createAgentSession(
  config: SessionConfig
): Promise<AgentSession> {
  const session = new AgentSession(config);
  await session.start();
  return session;
}

/**
 * Default export
 */
export default {
  AgentSession,
  createAgentSession,
};
