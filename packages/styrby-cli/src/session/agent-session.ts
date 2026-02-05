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
  /** Machine ID (for Realtime presence) */
  machineId: string;
  /** Machine name for display */
  machineName: string;
  /** Supabase client */
  supabase: SupabaseClient;
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

      this.log('Starting session', {
        agent: this.config.agent,
        cwd: this.config.cwd,
      });

      // Connect to Realtime for mobile relay
      await this.connectRelay();

      // Spawn the agent process
      await this.spawnAgent();

      this.setState('running');
      this.log('Session started');
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

    // Connect
    await this.relay.connect();
    this.log('Relay connected');

    // Update presence with session info
    await this.relay.updatePresence({
      active_agent: this.config.agent,
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
          session_id: this.config.machineId, // Using machine ID as session ID for now
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
