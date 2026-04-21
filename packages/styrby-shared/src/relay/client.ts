/**
 * Styrby Relay Client
 *
 * Manages Supabase Realtime channel connection for CLI ↔ Mobile communication.
 * Handles message sending, presence tracking, and reconnection logic.
 */

import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import type {
  RelayMessage,
  PresenceState,
  DeviceType,
  RelayChannelEvents,
  AgentType,
} from './types.js';
import { getChannelName, createBaseMessage, RelayMessageSchema } from './types.js';

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration passed to `RelayClient` (or `createRelayClient`) to establish
 * a Supabase Realtime channel connection between the CLI and the mobile app.
 *
 * WHY both `deviceId` and `userId`: The relay channel is scoped to a user
 * (`relay:{userId}`), but multiple devices per user can be simultaneously
 * connected (e.g., a developer's laptop CLI and their iPad). `deviceId` is
 * the presence key that distinguishes each participant within the channel.
 *
 * WHY `channelSuffix` is optional: It was added in SEC-RELAY-001 to prevent
 * channel enumeration attacks by anyone who knows only the user's UUID. Older
 * CLI and mobile clients that pre-date this fix connect without a suffix.
 * The optional field maintains backward compatibility while new clients
 * always provide one.
 */
export interface RelayClientConfig {
  /** Supabase client instance */
  supabase: SupabaseClient;
  /** User ID to connect as */
  userId: string;
  /** Device ID (machine_id or device_id) */
  deviceId: string;
  /** Device type */
  deviceType: DeviceType;
  /** Human-readable device name */
  deviceName?: string;
  /** Platform (darwin, linux, windows, ios, android) */
  platform?: string;
  /** Heartbeat interval in ms (default: 15000) */
  heartbeatInterval?: number;
  /** Connection timeout in ms (default: 45000) */
  connectionTimeout?: number;
  /** Enable debug logging */
  debug?: boolean;
  /**
   * Optional 16-char hex suffix derived from the shared pairing secret via
   * `deriveChannelSuffix`. When present, the channel name becomes
   * `relay:{userId}:{channelSuffix}`, preventing attackers who know only the
   * userId UUID from subscribing to the channel (SEC-RELAY-001).
   *
   * Falls back to `relay:{userId}` when omitted for backward compatibility
   * with older clients that pre-date this security fix.
   */
  channelSuffix?: string;
}

/**
 * Current state of the relay WebSocket connection, emitted via the
 * `RelayClient` event system and used to drive connection-status UI
 * in both the mobile app and the web dashboard.
 *
 * State transitions:
 * ```
 * disconnected → connecting → connected
 *                    ↓               ↓ (channel error or heartbeat failure)
 *                  error ←── reconnecting ←── connected
 * ```
 *
 * 'reconnecting' differs from 'connecting' in that it signals an automatic
 * retry after an unexpected drop rather than an intentional initial connect.
 * The mobile UI shows different copy for each ("Connecting..." vs.
 * "Connection lost, retrying...").
 */
export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error';

// ============================================================================
// Event Emitter (minimal implementation)
// ============================================================================

type EventCallback<T> = (data: T) => void;
type EventMap = { [key: string]: unknown };

class EventEmitter<Events extends EventMap> {
  private listeners: Map<string, Set<EventCallback<unknown>>> = new Map();

  on<K extends keyof Events & string>(event: K, callback: EventCallback<Events[K]>): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback as EventCallback<unknown>);
  }

  off<K extends keyof Events & string>(event: K, callback: EventCallback<Events[K]>): void {
    this.listeners.get(event)?.delete(callback as EventCallback<unknown>);
  }

  emit<K extends keyof Events & string>(event: K, data: Events[K]): void {
    this.listeners.get(event)?.forEach((cb) => cb(data));
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}

// ============================================================================
// Relay Client
// ============================================================================

/**
 * Relay client for CLI ↔ Mobile communication
 */
export class RelayClient extends EventEmitter<RelayChannelEvents> {
  private config: Required<Omit<RelayClientConfig, 'channelSuffix'>> & Pick<RelayClientConfig, 'channelSuffix'>;
  private channel: RealtimeChannel | null = null;
  private state: ConnectionState = 'disconnected';
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  // WHY: No maxReconnectAttempts cap. A developer working from a coffee shop
  // may lose wifi for 3+ days (e.g., travelling). Capping at 10 attempts
  // (~5 min) permanently silences the mobile link until they manually restart
  // the daemon. Unbounded retry keeps the link alive across arbitrarily long
  // offline periods. The ONLY unrecoverable condition is a 401/403 auth error
  // (token revoked) — everything else, including network outages and transient
  // Supabase 5xx errors, retries forever with 60s-capped exponential backoff.
  private presenceState: PresenceState | null = null;
  private connectedDevices: Map<string, PresenceState> = new Map();

  constructor(config: RelayClientConfig) {
    super();
    this.config = {
      heartbeatInterval: 15000,
      connectionTimeout: 45000,
      debug: false,
      deviceName: config.deviceType === 'cli' ? 'CLI' : 'Mobile',
      platform: 'unknown',
      ...config,
    };
  }

  // --------------------------------------------------------------------------
  // Connection Management
  // --------------------------------------------------------------------------

  /**
   * Connect to the relay channel
   */
  async connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') {
      this.log('Already connected or connecting');
      return;
    }

    this.setState('connecting');

    try {
      const channelName = getChannelName(this.config.userId, this.config.channelSuffix);

      this.channel = this.config.supabase.channel(channelName, {
        config: {
          presence: { key: this.config.deviceId },
          broadcast: { self: false }, // Don't receive own broadcasts
        },
      });

      // Set up event handlers
      this.setupChannelHandlers();

      // Subscribe to channel
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Connection timeout'));
        }, this.config.connectionTimeout);

        this.channel!.subscribe(async (status, err) => {
          if (status === 'SUBSCRIBED') {
            clearTimeout(timeout);
            await this.trackPresence();
            resolve();
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            clearTimeout(timeout);
            // WHY: Supabase Realtime surfaces 401/403 as a CHANNEL_ERROR with
            // an error object whose message contains the HTTP status code.
            // We detect auth failures here so scheduleReconnect() can stop
            // retrying permanently rather than looping forever on a revoked token.
            const isAuthError = err != null && (
              String(err).includes('401') ||
              String(err).includes('403') ||
              String(err).toLowerCase().includes('unauthorized') ||
              String(err).toLowerCase().includes('forbidden')
            );
            const channelErr = new Error(`Channel error: ${status}`);
            (channelErr as Error & { isAuthError?: boolean }).isAuthError = isAuthError;
            reject(channelErr);
          }
        });
      });

      this.setState('connected');
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      this.emit('subscribed', undefined);
      this.log('Connected to relay channel');
    } catch (error) {
      const isAuthError = (error as Error & { isAuthError?: boolean }).isAuthError === true;
      this.setState('error');
      // WHY: For auth errors we delegate the error emit to scheduleReconnect()
      // which also halts retries and produces the AUTH_ERROR code. Emitting
      // here too would produce a duplicate event. For non-auth errors we emit
      // a generic connection-failed event and then schedule the next retry.
      if (!isAuthError) {
        this.emit('error', {
          message: error instanceof Error ? error.message : 'Connection failed',
        });
      }
      this.scheduleReconnect(isAuthError);
    }
  }

  /**
   * Disconnect from the relay channel
   */
  async disconnect(): Promise<void> {
    this.stopHeartbeat();

    if (this.channel) {
      await this.channel.unsubscribe();
      this.config.supabase.removeChannel(this.channel);
      this.channel = null;
    }

    this.setState('disconnected');
    this.connectedDevices.clear();
    this.presenceState = null;
    this.emit('closed', { reason: 'manual disconnect' });
    this.log('Disconnected from relay channel');
  }

  /**
   * Get current connection state
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.state === 'connected';
  }

  // --------------------------------------------------------------------------
  // Messaging
  // --------------------------------------------------------------------------

  /**
   * Send a message to the relay channel
   */
  async send(message: Omit<RelayMessage, 'id' | 'timestamp' | 'sender_device_id' | 'sender_type'>): Promise<void> {
    if (!this.isConnected() || !this.channel) {
      throw new Error('Not connected to relay channel');
    }

    const fullMessage = {
      ...createBaseMessage(this.config.deviceId, this.config.deviceType),
      ...message,
    } as RelayMessage;

    await this.channel.send({
      type: 'broadcast',
      event: 'message',
      payload: fullMessage,
    });

    this.log('Sent message:', fullMessage.type);
  }

  /**
   * Send a chat message to an agent
   */
  async sendChat(content: string, agent: AgentType, sessionId?: string): Promise<void> {
    await this.send({
      type: 'chat',
      payload: { content, agent, session_id: sessionId },
    });
  }

  /**
   * Send a permission response to the CLI.
   *
   * @param requestId - The `request_id` from the corresponding PermissionRequestMessage
   * @param requestNonce - The `nonce` echoed from the PermissionRequestMessage (replay protection)
   * @param approved - Whether the user granted permission
   * @param options - Optional modified args and remember preference
   */
  async sendPermissionResponse(
    requestId: string,
    requestNonce: string,
    approved: boolean,
    options?: { modifiedArgs?: Record<string, unknown>; remember?: boolean }
  ): Promise<void> {
    await this.send({
      type: 'permission_response',
      payload: {
        request_id: requestId,
        approved,
        modified_args: options?.modifiedArgs,
        remember: options?.remember,
        // WHY: Echo the nonce from the request so the CLI can bind this response
        // to exactly one pending request and reject replays (SEC-RELAY-003).
        request_nonce: requestNonce,
      },
    });
  }

  /**
   * Send a command
   */
  async sendCommand(
    action: 'cancel' | 'interrupt' | 'new_session' | 'switch_agent' | 'end_session' | 'sync_history' | 'ping',
    params?: Record<string, unknown>
  ): Promise<void> {
    await this.send({
      type: 'command',
      payload: { action, params },
    });
  }

  // --------------------------------------------------------------------------
  // Presence
  // --------------------------------------------------------------------------

  /**
   * Get list of connected devices
   */
  getConnectedDevices(): PresenceState[] {
    return Array.from(this.connectedDevices.values());
  }

  /**
   * Check if a specific device type is online
   */
  isDeviceTypeOnline(type: DeviceType): boolean {
    return Array.from(this.connectedDevices.values()).some((d) => d.device_type === type);
  }

  /**
   * Update presence state (e.g., when switching agents or sessions)
   */
  async updatePresence(update: Partial<Pick<PresenceState, 'active_agent' | 'session_id'>>): Promise<void> {
    if (!this.channel || !this.presenceState) return;

    this.presenceState = { ...this.presenceState, ...update };
    await this.channel.track(this.presenceState);
    this.log('Updated presence:', update);
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  private setState(state: ConnectionState): void {
    this.state = state;
  }

  private setupChannelHandlers(): void {
    if (!this.channel) return;

    // Handle incoming messages
    this.channel.on('broadcast', { event: 'message' }, ({ payload }) => {
      // WHY: Supabase Realtime delivers broadcast payloads as `unknown`. We
      // validate with Zod before treating the data as a typed RelayMessage.
      // This prevents malformed or malicious broadcasts from corrupting state
      // or reaching application code without validation (SEC-RELAY-002).
      const result = RelayMessageSchema.safeParse(payload);
      if (!result.success) {
        console.warn('[Relay] Dropped malformed message:', result.error.issues);
        return;
      }
      const message = result.data;
      this.log('Received message:', message.type);
      this.emit('message', message);
    });

    // Handle presence sync (initial state)
    this.channel.on('presence', { event: 'sync' }, () => {
      const state = this.channel!.presenceState<PresenceState>();
      this.connectedDevices.clear();

      Object.values(state).forEach((presences) => {
        presences.forEach((presence) => {
          if (presence.device_id !== this.config.deviceId) {
            this.connectedDevices.set(presence.device_id, presence);
          }
        });
      });

      this.log('Presence synced, devices:', this.connectedDevices.size);
    });

    // Handle presence join
    this.channel.on('presence', { event: 'join' }, ({ newPresences }) => {
      newPresences.forEach((p) => {
        const presence = p as unknown as PresenceState;
        if (presence.device_id !== this.config.deviceId) {
          this.connectedDevices.set(presence.device_id, presence);
          this.emit('presence_join', presence);
          this.log('Device joined:', presence.device_type, presence.device_id);
        }
      });
    });

    // Handle presence leave
    this.channel.on('presence', { event: 'leave' }, ({ leftPresences }) => {
      leftPresences.forEach((p) => {
        const presence = p as unknown as PresenceState;
        this.connectedDevices.delete(presence.device_id);
        this.emit('presence_leave', { device_id: presence.device_id });
        this.log('Device left:', presence.device_id);
      });
    });
  }

  private async trackPresence(): Promise<void> {
    if (!this.channel) return;

    this.presenceState = {
      device_id: this.config.deviceId,
      device_type: this.config.deviceType,
      user_id: this.config.userId,
      device_name: this.config.deviceName,
      platform: this.config.platform,
      online_at: new Date().toISOString(),
    };

    await this.channel.track(this.presenceState);
    this.log('Tracking presence');
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();

    this.heartbeatTimer = setInterval(async () => {
      if (this.isConnected()) {
        try {
          await this.sendCommand('ping');
        } catch {
          this.log('Heartbeat failed, reconnecting...');
          this.scheduleReconnect();
        }
      }
    }, this.config.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Schedule an automatic reconnect attempt with capped exponential backoff.
   *
   * WHY no cap on attempts: see the class-level comment on `reconnectAttempts`.
   * WHY 60s max delay (raised from 30s): unbounded retry means the backoff
   * settles at its ceiling permanently. 30s was acceptable for 10 attempts
   * but is unnecessarily aggressive over days of network outage — 60s halves
   * the steady-state reconnect traffic against Supabase infra.
   *
   * @param isAuthError - When true, the error is unrecoverable (401/403) and
   *   retrying will never succeed. Emits `error` with code AUTH_ERROR and stops.
   */
  private scheduleReconnect(isAuthError = false): void {
    // WHY: 401/403 means the token is revoked or invalid. Retrying will always
    // fail and would spam Supabase auth logs. Surface it as a fatal error so
    // the daemon can notify the user to re-authenticate.
    if (isAuthError) {
      this.log('Auth error (401/403) — stopping reconnect. Re-authenticate to restore connection.');
      this.setState('error');
      this.emit('error', {
        message: 'Authentication failed (401/403). Run "styrby onboard" to re-authenticate.',
        code: 'AUTH_ERROR',
      });
      return;
    }

    this.setState('reconnecting');
    this.reconnectAttempts++;

    // Exponential backoff: 1s, 2s, 4s, 8s... capped at 60s.
    // WHY 60s ceiling (up from 30s): With unbounded retries the backoff stays
    // at its ceiling indefinitely. 60s is less aggressive on infra during long
    // outages while still recovering promptly from short drops.
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 60_000);
    this.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.emit('reconnecting', { attempt: this.reconnectAttempts, delayMs: delay });

    setTimeout(() => {
      this.connect();
    }, delay);
  }

  private log(...args: unknown[]): void {
    if (this.config.debug) {
      console.log('[Relay]', ...args);
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a relay client instance
 */
export function createRelayClient(config: RelayClientConfig): RelayClient {
  return new RelayClient(config);
}
