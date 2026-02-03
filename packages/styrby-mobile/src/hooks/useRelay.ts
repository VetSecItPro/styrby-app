/**
 * Relay Connection Hook
 *
 * Manages the connection to the Supabase Realtime relay channel.
 * Integrates with the offline queue for resilience.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
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
// Storage Keys
// ============================================================================

const STORAGE_KEYS = {
  PAIRING_INFO: 'styrby_pairing_info',
  DEVICE_ID: 'styrby_device_id',
};

// ============================================================================
// Types
// ============================================================================

export interface PairingInfo {
  userId: string;
  machineId: string;
  deviceName: string;
  pairedAt: string;
}

export interface UseRelayReturn {
  /** Current connection state */
  connectionState: ConnectionState;
  /** Whether connected to relay */
  isConnected: boolean;
  /** Whether device is online (has network) */
  isOnline: boolean;
  /** Whether CLI is online */
  isCliOnline: boolean;
  /** Number of pending offline messages */
  pendingQueueCount: number;
  /** Pairing info (if paired) */
  pairingInfo: PairingInfo | null;
  /** List of connected devices */
  connectedDevices: PresenceState[];
  /** Connect to relay */
  connect: () => Promise<void>;
  /** Disconnect from relay */
  disconnect: () => Promise<void>;
  /** Send a message (queues if offline) */
  sendMessage: (
    message: Omit<RelayMessage, 'id' | 'timestamp' | 'sender_device_id' | 'sender_type'>,
    options?: EnqueueOptions
  ) => Promise<void>;
  /** Save pairing info */
  savePairing: (info: PairingInfo) => Promise<void>;
  /** Clear pairing info */
  clearPairing: () => Promise<void>;
  /** Last received message */
  lastMessage: RelayMessage | null;
}

// ============================================================================
// Device ID
// ============================================================================

async function getOrCreateDeviceId(): Promise<string> {
  let deviceId = await SecureStore.getItemAsync(STORAGE_KEYS.DEVICE_ID);

  if (!deviceId) {
    deviceId = `mobile_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    await SecureStore.setItemAsync(STORAGE_KEYS.DEVICE_ID, deviceId);
  }

  return deviceId;
}

// ============================================================================
// Hook
// ============================================================================

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

  // Load pairing info on mount
  useEffect(() => {
    loadPairingInfo();
    updateQueueCount();
  }, []);

  // Monitor network state
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      const wasOffline = !isOnline;
      const nowOnline = state.isConnected ?? false;
      setIsOnline(nowOnline);

      // When coming back online, process the queue
      if (wasOffline && nowOnline && pairingInfo) {
        processOfflineQueue();
      }
    });
    return () => unsubscribe();
  }, [isOnline, pairingInfo]);

  // Handle app state changes (background/foreground)
  useEffect(() => {
    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => subscription.remove();
  }, [pairingInfo]);

  const handleAppStateChange = useCallback(
    (nextState: AppStateStatus) => {
      if (nextState === 'active' && pairingInfo) {
        // Reconnect when coming to foreground
        connect();
      } else if (nextState === 'background') {
        // Keep connection alive in background (briefly)
        // The OS will eventually kill it, but we try to stay connected
      }
    },
    [pairingInfo]
  );

  // Load pairing info from secure storage
  const loadPairingInfo = async () => {
    try {
      const stored = await SecureStore.getItemAsync(STORAGE_KEYS.PAIRING_INFO);
      if (stored) {
        const info = JSON.parse(stored) as PairingInfo;
        setPairingInfo(info);
      }
    } catch (error) {
      console.error('Failed to load pairing info:', error);
    }
  };

  // Save pairing info
  const savePairing = async (info: PairingInfo) => {
    await SecureStore.setItemAsync(STORAGE_KEYS.PAIRING_INFO, JSON.stringify(info));
    setPairingInfo(info);
  };

  // Clear pairing info
  const clearPairing = async () => {
    await disconnect();
    await SecureStore.deleteItemAsync(STORAGE_KEYS.PAIRING_INFO);
    setPairingInfo(null);
  };

  // Connect to relay
  const connect = async () => {
    if (!pairingInfo) {
      console.log('Cannot connect: no pairing info');
      return;
    }

    if (clientRef.current?.isConnected()) {
      console.log('Already connected');
      return;
    }

    try {
      setConnectionState('connecting');

      // Get or create device ID
      if (!deviceIdRef.current) {
        deviceIdRef.current = await getOrCreateDeviceId();
      }

      // Create relay client
      const client = createRelayClient({
        supabase,
        userId: pairingInfo.userId,
        deviceId: deviceIdRef.current,
        deviceType: 'mobile',
        deviceName: 'Mobile App',
        platform: 'ios', // TODO: detect platform
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
        // Process any queued messages
        processOfflineQueue();
      });

      client.on('error', ({ message }) => {
        console.error('Relay error:', message);
        setConnectionState('error');
      });

      client.on('closed', () => {
        setConnectionState('disconnected');
        setConnectedDevices([]);
      });

      // Connect
      await client.connect();
      clientRef.current = client;
    } catch (error) {
      console.error('Failed to connect:', error);
      setConnectionState('error');
    }
  };

  // Disconnect from relay
  const disconnect = async () => {
    if (clientRef.current) {
      await clientRef.current.disconnect();
      clientRef.current = null;
    }
    setConnectionState('disconnected');
    setConnectedDevices([]);
  };

  // Update pending queue count
  const updateQueueCount = async () => {
    try {
      const stats = await offlineQueue.getStats();
      setPendingQueueCount(stats.pending);
    } catch (error) {
      console.error('Failed to get queue stats:', error);
    }
  };

  // Process offline queue
  const processOfflineQueue = async () => {
    if (processingQueueRef.current) return;
    if (!clientRef.current?.isConnected()) return;

    processingQueueRef.current = true;
    try {
      await offlineQueue.processQueue(async (message) => {
        await clientRef.current!.send(message);
      });
    } catch (error) {
      console.error('Failed to process offline queue:', error);
    } finally {
      processingQueueRef.current = false;
      await updateQueueCount();
    }
  };

  // Send a message (queues if offline)
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
      console.log('Offline: queuing message for later');
      await offlineQueue.enqueue(message as RelayMessage, options);
      await updateQueueCount();
      return;
    }

    // Not connected but online - try to connect first
    throw new Error('Not connected to relay');
  };

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
