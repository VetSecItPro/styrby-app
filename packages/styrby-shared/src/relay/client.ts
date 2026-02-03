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
import { getChannelName, createBaseMessage } from './types.js';

// ============================================================================
// Configuration
// ============================================================================

/**
 * Relay client configuration
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
}

/**
 * Connection state
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
  private config: Required<RelayClientConfig>;
  private channel: RealtimeChannel | null = null;
  private state: ConnectionState = 'disconnected';
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
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
      const channelName = getChannelName(this.config.userId);

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

        this.channel!.subscribe(async (status) => {
          if (status === 'SUBSCRIBED') {
            clearTimeout(timeout);
            await this.trackPresence();
            resolve();
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            clearTimeout(timeout);
            reject(new Error(`Channel error: ${status}`));
          }
        });
      });

      this.setState('connected');
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      this.emit('subscribed', undefined);
      this.log('Connected to relay channel');
    } catch (error) {
      this.setState('error');
      this.emit('error', {
        message: error instanceof Error ? error.message : 'Connection failed',
      });
      this.scheduleReconnect();
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
   * Send a permission response
   */
  async sendPermissionResponse(
    requestId: string,
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
      const message = payload as RelayMessage;
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

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.log('Max reconnect attempts reached');
      this.emit('error', { message: 'Max reconnect attempts reached' });
      return;
    }

    this.setState('reconnecting');
    this.reconnectAttempts++;

    // Exponential backoff: 1s, 2s, 4s, 8s... up to 30s
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000);
    this.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

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
