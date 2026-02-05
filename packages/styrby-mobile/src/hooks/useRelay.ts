/**
 * Relay Connection Hook
 *
 * Manages the connection to the Supabase Realtime relay channel.
 * Integrates with the offline queue for resilience.
 *
 * Lifecycle:
 * 1. On mount, loads pairing info from SecureStore
 * 2. If pairing info exists and network is available, auto-connects
 * 3. Monitors network state and app foreground/background transitions
 * 4. Queues messages offline and flushes them when reconnected
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import NetInfo from '@react-native-community/netinfo';
import {
  createRelayClient,
  type RelayClient,
  type RelayMessage,
  type PresenceState,
  type ConnectionState,
  type EnqueueOptions,
} from 'styrby-shared';
import { supabase } from '../lib/supabase';
import { offlineQueue } from '../services/offline-queue';

// ============================================================================
// Dev-Only Logger
// ============================================================================

/**
 * Development-only logger that suppresses output in production.
 * WHY: Prevents sensitive relay data from appearing in production logs.
 */
const logger = {
  log: (...args: unknown[]) => { if (__DEV__) console.log('[Relay]', ...args); },
  error: (...args: unknown[]) => { if (__DEV__) console.error('[Relay]', ...args); },
  warn: (...args: unknown[]) => { if (__DEV__) console.warn('[Relay]', ...args); },
};

// ============================================================================
// Storage Keys
// ============================================================================

const STORAGE_KEYS = {
  /** Key for persisted pairing info (shared with pairing service) */
  PAIRING_INFO: 'styrby_pairing_info',
  /** Key for this device's unique relay identifier */
  DEVICE_ID: 'styrby_device_id',
};

// ============================================================================
// Types
// ============================================================================

/**
 * Pairing information stored after a successful QR code pairing.
 * This is the minimal set of data needed to reconnect to the relay channel.
 */
export interface PairingInfo {
  /** User ID of the paired CLI user */
  userId: string;
  /** Machine ID of the paired CLI instance */
  machineId: string;
  /** Human-readable device name from the CLI (e.g., hostname) */
  deviceName: string;
  /** ISO 8601 timestamp when the pairing was completed */
  pairedAt: string;
}

/**
 * Return type of the useRelay hook.
 * Provides connection state, messaging, and pairing management to consumers.
 */
export interface UseRelayReturn {
  /** Current connection state (disconnected, connecting, connected, reconnecting, error) */
  connectionState: ConnectionState;
  /** Whether the relay channel is currently connected */
  isConnected: boolean;
  /** Whether the device has network connectivity */
  isOnline: boolean;
  /** Whether the CLI device is online in the relay channel presence */
  isCliOnline: boolean;
  /** Number of messages waiting in the offline queue */
  pendingQueueCount: number;
  /** Pairing info if the device is paired, null otherwise */
  pairingInfo: PairingInfo | null;
  /** List of devices currently connected to the relay channel */
  connectedDevices: PresenceState[];
  /** Connect to the relay channel (requires pairing info) */
  connect: () => Promise<void>;
  /** Disconnect from the relay channel */
  disconnect: () => Promise<void>;
  /**
   * Send a message through the relay channel.
   * If offline, queues the message for delivery when reconnected.
   *
   * @param message - Message payload (id, timestamp, sender fields are auto-populated)
   * @param options - Optional queue settings (priority, TTL, max retries)
   */
  sendMessage: (
    message: Omit<RelayMessage, 'id' | 'timestamp' | 'sender_device_id' | 'sender_type'>,
    options?: EnqueueOptions
  ) => Promise<void>;
  /**
   * Save pairing info to SecureStore and update hook state.
   * Called by the scan screen after a successful pairing.
   *
   * @param info - Pairing data to persist
   */
  savePairing: (info: PairingInfo) => Promise<void>;
  /**
   * Clear all pairing data, disconnect from relay, and reset state.
   * Called when the user explicitly unpairs from Settings.
   */
  clearPairing: () => Promise<void>;
  /** The most recently received relay message */
  lastMessage: RelayMessage | null;
}

// ============================================================================
// Platform Detection
// ============================================================================

/**
 * Returns the platform string for relay presence tracking.
 * Maps React Native Platform.OS values to the relay protocol's platform strings.
 *
 * @returns Platform identifier string (ios, android, or the raw OS value)
 */
function getDevicePlatform(): string {
  return Platform.OS;
}

// ============================================================================
// Device ID
// ============================================================================

/**
 * Generates a random string using multiple entropy sources.
 * WHY: Single Math.random() is predictable; combined sources improve uniqueness.
 * Note: For security tokens, use expo-crypto. Device IDs are identifiers, not secrets.
 *
 * @returns A 16-character pseudorandom string
 */
function generateSecureId(): string {
  const timestamp = Date.now().toString(36);
  const randomPart1 = Math.random().toString(36).substring(2, 8);
  const randomPart2 = Math.random().toString(36).substring(2, 8);
  const performanceNow = (typeof performance !== 'undefined' && performance.now)
    ? Math.floor(performance.now() * 1000).toString(36)
    : Math.random().toString(36).substring(2, 6);
  return `${timestamp}${randomPart1}${randomPart2}${performanceNow}`.substring(0, 16);
}

/**
 * Retrieves or creates a persistent device ID stored in SecureStore.
 * The device ID uniquely identifies this mobile device in the relay channel's
 * presence system across app restarts.
 *
 * @returns The device ID string (format: "mobile_{16-char-random}")
 */
async function getOrCreateDeviceId(): Promise<string> {
  let deviceId = await SecureStore.getItemAsync(STORAGE_KEYS.DEVICE_ID);

  if (!deviceId) {
    deviceId = `mobile_${generateSecureId()}`;
    await SecureStore.setItemAsync(STORAGE_KEYS.DEVICE_ID, deviceId);
  }

  return deviceId;
}

// ============================================================================
// Hook
// ============================================================================

/**
 * React hook for managing the Supabase Realtime relay connection.
 *
 * Provides:
 * - Connection lifecycle management (connect, disconnect, auto-reconnect)
 * - Presence tracking (which devices are online)
 * - Message sending with offline queue fallback
 * - Pairing state management (save, load, clear)
 *
 * @returns UseRelayReturn object with state and control functions
 *
 * @example
 * function MyComponent() {
 *   const { isConnected, isCliOnline, sendMessage, pairingInfo } = useRelay();
 *
 *   if (!pairingInfo) return <PairPrompt />;
 *   if (!isConnected) return <Connecting />;
 *
 *   return <ChatView onSend={(msg) => sendMessage(msg)} />;
 * }
 */
export function useRelay(): UseRelayReturn {
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [pairingInfo, setPairingInfo] = useState<PairingInfo | null>(null);
  const [connectedDevices, setConnectedDevices] = useState<PresenceState[]>([]);
  const [lastMessage, setLastMessage] = useState<RelayMessage | null>(null);
  const [isOnline, setIsOnline] = useState(true);
  const [pendingQueueCount, setPendingQueueCount] = useState(0);

  const clientRef = useRef<RelayClient | null>(null);
  const deviceIdRef = useRef<string | null>(null);
  const processingQueueRef = useRef(false);

  /**
   * WHY: Track whether we have already attempted an auto-connect for the initial
   * pairing info load. Without this, the auto-connect effect could fire multiple
   * times if pairingInfo is set from both loadPairingInfo and savePairing.
   */
  const autoConnectAttemptedRef = useRef(false);

  // --------------------------------------------------------------------------
  // Mount: Load persisted pairing info and queue stats
  // --------------------------------------------------------------------------

  useEffect(() => {
    loadPairingInfo();
    updateQueueCount();
  }, []);

  // --------------------------------------------------------------------------
  // Auto-connect: When pairing info becomes available, connect to relay
  // --------------------------------------------------------------------------

  /**
   * WHY: Auto-connect when pairing info is loaded from storage on app start.
   * This ensures the mobile device reconnects to the relay channel without
   * requiring the user to manually trigger a connect.
   */
  useEffect(() => {
    if (pairingInfo && isOnline && !clientRef.current?.isConnected() && !autoConnectAttemptedRef.current) {
      autoConnectAttemptedRef.current = true;
      connect().catch((err) => {
        logger.error('Auto-connect failed:', err);
      });
    }
  }, [pairingInfo, isOnline]);

  // --------------------------------------------------------------------------
  // Network monitoring: Reconnect on network recovery, flush offline queue
  // --------------------------------------------------------------------------

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      const wasOffline = !isOnline;
      const nowOnline = state.isConnected ?? false;
      setIsOnline(nowOnline);

      // When coming back online, reconnect and process the queue
      if (wasOffline && nowOnline && pairingInfo) {
        connect().then(() => processOfflineQueue()).catch((err) => {
          logger.error('Reconnect after network recovery failed:', err);
        });
      }
    });
    return () => unsubscribe();
  }, [isOnline, pairingInfo]);

  // --------------------------------------------------------------------------
  // App state: Reconnect on foreground, maintain background connection
  // --------------------------------------------------------------------------

  useEffect(() => {
    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => subscription.remove();
  }, [pairingInfo]);

  /**
   * Handles app state transitions (background/foreground).
   * Reconnects to the relay channel when the app comes to the foreground.
   *
   * @param nextState - The new app state
   */
  const handleAppStateChange = useCallback(
    (nextState: AppStateStatus) => {
      if (nextState === 'active' && pairingInfo) {
        // Reconnect when coming to foreground
        connect();
      }
      // WHY: We do not explicitly disconnect on background. The OS will eventually
      // kill the WebSocket, but staying connected as long as possible means the user
      // sees fresh data immediately when returning to the app.
    },
    [pairingInfo]
  );

  // --------------------------------------------------------------------------
  // Pairing Info Persistence
  // --------------------------------------------------------------------------

  /**
   * Loads pairing info from SecureStore into hook state.
   * Called once on mount to restore pairing state across app restarts.
   */
  const loadPairingInfo = async () => {
    try {
      const stored = await SecureStore.getItemAsync(STORAGE_KEYS.PAIRING_INFO);
      if (stored) {
        const info = JSON.parse(stored) as PairingInfo;
        setPairingInfo(info);
      }
    } catch (error) {
      logger.error('Failed to load pairing info:', error);
    }
  };

  /**
   * Persists pairing info to SecureStore and updates hook state.
   * Resets the auto-connect flag so the new pairing info can trigger a connection.
   *
   * @param info - Pairing data to save
   */
  const savePairing = async (info: PairingInfo) => {
    await SecureStore.setItemAsync(STORAGE_KEYS.PAIRING_INFO, JSON.stringify(info));

    // WHY: Reset auto-connect flag so the effect fires for the new pairing info.
    // This handles the case where the user re-pairs after clearing pairing data.
    autoConnectAttemptedRef.current = false;

    setPairingInfo(info);
  };

  /**
   * Clears all pairing data, disconnects from relay, and resets hook state.
   * Used when the user wants to unpair or re-pair with a different CLI.
   */
  const clearPairing = async () => {
    await disconnect();
    await SecureStore.deleteItemAsync(STORAGE_KEYS.PAIRING_INFO);
    autoConnectAttemptedRef.current = false;
    setPairingInfo(null);
  };

  // --------------------------------------------------------------------------
  // Relay Connection
  // --------------------------------------------------------------------------

  /**
   * Connects to the Supabase Realtime relay channel.
   * Creates a new RelayClient, sets up event handlers, subscribes to the channel,
   * and begins tracking presence.
   *
   * @throws Error if connection times out or channel subscription fails
   */
  const connect = async () => {
    if (!pairingInfo) {
      logger.log('Cannot connect: no pairing info');
      return;
    }

    if (clientRef.current?.isConnected()) {
      logger.log('Already connected');
      return;
    }

    // WHY: Disconnect any stale client before creating a new one to prevent
    // zombie connections from accumulating after re-pair or network recovery.
    if (clientRef.current) {
      try {
        await clientRef.current.disconnect();
      } catch {
        // Ignore disconnect errors for stale clients
      }
      clientRef.current = null;
    }

    try {
      setConnectionState('connecting');

      // Get or create device ID
      if (!deviceIdRef.current) {
        deviceIdRef.current = await getOrCreateDeviceId();
      }

      // Create relay client with platform-aware configuration
      const client = createRelayClient({
        supabase,
        userId: pairingInfo.userId,
        deviceId: deviceIdRef.current,
        deviceType: 'mobile',
        deviceName: 'Mobile App',
        platform: getDevicePlatform(),
        debug: __DEV__,
      });

      // Set up event handlers
      client.on('message', (message) => {
        setLastMessage(message);
      });

      client.on('presence_join', (device) => {
        setConnectedDevices((prev) => [...prev, device]);
      });

      client.on('presence_leave', ({ device_id }) => {
        setConnectedDevices((prev) => prev.filter((d) => d.device_id !== device_id));
      });

      client.on('subscribed', () => {
        setConnectionState('connected');
        setConnectedDevices(client.getConnectedDevices());
        // Process any queued messages that accumulated while disconnected
        processOfflineQueue();
      });

      client.on('error', ({ message }) => {
        logger.error('Relay error:', message);
        setConnectionState('error');
      });

      client.on('closed', () => {
        setConnectionState('disconnected');
        setConnectedDevices([]);
      });

      // Connect to the channel
      await client.connect();
      clientRef.current = client;
    } catch (error) {
      logger.error('Failed to connect:', error);
      setConnectionState('error');
    }
  };

  /**
   * Disconnects from the relay channel and cleans up the client.
   */
  const disconnect = async () => {
    if (clientRef.current) {
      await clientRef.current.disconnect();
      clientRef.current = null;
    }
    setConnectionState('disconnected');
    setConnectedDevices([]);
  };

  // --------------------------------------------------------------------------
  // Offline Queue
  // --------------------------------------------------------------------------

  /**
   * Updates the pending queue count from the offline queue stats.
   */
  const updateQueueCount = async () => {
    try {
      const stats = await offlineQueue.getStats();
      setPendingQueueCount(stats.pending);
    } catch (error) {
      logger.error('Failed to get queue stats:', error);
    }
  };

  /**
   * Processes the offline queue by sending all pending messages through the relay.
   * Uses a processing lock ref to prevent concurrent queue processing.
   */
  const processOfflineQueue = async () => {
    if (processingQueueRef.current) return;
    if (!clientRef.current?.isConnected()) return;

    processingQueueRef.current = true;
    try {
      await offlineQueue.processQueue(async (message) => {
        await clientRef.current!.send(message);
      });
    } catch (error) {
      logger.error('Failed to process offline queue:', error);
    } finally {
      processingQueueRef.current = false;
      await updateQueueCount();
    }
  };

  // --------------------------------------------------------------------------
  // Messaging
  // --------------------------------------------------------------------------

  /**
   * Sends a message through the relay channel, or queues it if offline.
   *
   * @param message - Message payload without auto-generated fields
   * @param options - Optional queue settings for offline delivery
   * @throws Error if not connected and device is online (cannot queue online messages)
   */
  const sendMessage = async (
    message: Omit<RelayMessage, 'id' | 'timestamp' | 'sender_device_id' | 'sender_type'>,
    options?: EnqueueOptions
  ) => {
    // If connected, send directly
    if (clientRef.current?.isConnected()) {
      await clientRef.current.send(message);
      return;
    }

    // Otherwise, queue for later
    if (!isOnline) {
      logger.log('Offline: queuing message for later');
      await offlineQueue.enqueue(message as RelayMessage, options);
      await updateQueueCount();
      return;
    }

    // Not connected but online - try to connect first
    throw new Error('Not connected to relay');
  };

  // --------------------------------------------------------------------------
  // Return
  // --------------------------------------------------------------------------

  return {
    connectionState,
    isConnected: connectionState === 'connected',
    isOnline,
    isCliOnline: connectedDevices.some((d) => d.device_type === 'cli'),
    pendingQueueCount,
    pairingInfo,
    connectedDevices,
    connect,
    disconnect,
    sendMessage,
    savePairing,
    clearPairing,
    lastMessage,
  };
}
