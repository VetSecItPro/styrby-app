/**
 * Connection Status Component
 *
 * Displays the current connection state to the CLI via a colored indicator dot.
 * Shows different states: connected (green), connecting (yellow pulse),
 * disconnected (gray), error (red), and CLI offline (yellow).
 *
 * @module components/ConnectionStatus
 */

import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { ConnectionState, PresenceState } from 'styrby-shared';

// ============================================================================
// Types
// ============================================================================

/**
 * Props for the ConnectionStatus component.
 */
export interface ConnectionStatusProps {
  /** Current relay connection state */
  connectionState: ConnectionState;
  /** Whether the device has network connectivity */
  isOnline: boolean;
  /** Whether the CLI is connected to the relay */
  isCliOnline: boolean;
  /** Number of messages waiting in offline queue */
  pendingQueueCount: number;
  /** Connected CLI device info (if available) */
  cliDevice?: PresenceState | null;
  /** Callback when pressed (e.g., to show connection details) */
  onPress?: () => void;
}

// ============================================================================
// Status Configuration
// ============================================================================

/**
 * Configuration for each connection state.
 */
const STATUS_CONFIG: Record<
  ConnectionState | 'cli_offline' | 'no_network',
  {
    label: string;
    color: string;
    icon: keyof typeof Ionicons.glyphMap;
    pulse: boolean;
  }
> = {
  connected: {
    label: 'Connected',
    color: '#22c55e', // green-500
    icon: 'checkmark-circle',
    pulse: false,
  },
  connecting: {
    label: 'Connecting',
    color: '#eab308', // yellow-500
    icon: 'sync',
    pulse: true,
  },
  reconnecting: {
    label: 'Reconnecting',
    color: '#eab308', // yellow-500
    icon: 'sync',
    pulse: true,
  },
  disconnected: {
    label: 'Disconnected',
    color: '#71717a', // zinc-500
    icon: 'cloud-offline',
    pulse: false,
  },
  error: {
    label: 'Connection Error',
    color: '#ef4444', // red-500
    icon: 'alert-circle',
    pulse: false,
  },
  cli_offline: {
    label: 'CLI Offline',
    color: '#eab308', // yellow-500
    icon: 'desktop-outline',
    pulse: false,
  },
  no_network: {
    label: 'No Network',
    color: '#71717a', // zinc-500
    icon: 'wifi-outline',
    pulse: false,
  },
};

// ============================================================================
// Component
// ============================================================================

/**
 * Displays the current connection status with a colored dot indicator.
 *
 * The component shows:
 * - A colored dot indicating connection health
 * - Status label text
 * - Optional pending queue count badge
 * - CLI device name when connected
 *
 * @param props - Component props
 * @returns React element
 *
 * @example
 * <ConnectionStatus
 *   connectionState="connected"
 *   isOnline={true}
 *   isCliOnline={true}
 *   pendingQueueCount={0}
 *   onPress={() => showConnectionDetails()}
 * />
 */
export function ConnectionStatus({
  connectionState,
  isOnline,
  isCliOnline,
  pendingQueueCount,
  cliDevice,
  onPress,
}: ConnectionStatusProps) {
  // Determine the effective status to display
  const getEffectiveStatus = (): keyof typeof STATUS_CONFIG => {
    if (!isOnline) {
      return 'no_network';
    }
    if (connectionState === 'connected' && !isCliOnline) {
      return 'cli_offline';
    }
    return connectionState;
  };

  const effectiveStatus = getEffectiveStatus();
  const config = STATUS_CONFIG[effectiveStatus];

  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      className="flex-row items-center px-3 py-2 rounded-lg bg-zinc-900/50"
      style={{
        borderWidth: 1,
        borderColor: `${config.color}30`,
      }}
    >
      {/* Status Indicator Dot */}
      <View className="relative">
        <View
          className="w-3 h-3 rounded-full"
          style={{ backgroundColor: config.color }}
        />
        {config.pulse && (
          <View
            className="absolute inset-0 w-3 h-3 rounded-full animate-ping"
            style={{ backgroundColor: config.color, opacity: 0.5 }}
          />
        )}
      </View>

      {/* Status Text */}
      <View className="ml-2 flex-1">
        <Text
          className="text-sm font-medium"
          style={{ color: config.color }}
          numberOfLines={1}
        >
          {config.label}
        </Text>
        {effectiveStatus === 'connected' && cliDevice?.device_name && (
          <Text className="text-xs text-zinc-500" numberOfLines={1}>
            {cliDevice.device_name}
          </Text>
        )}
      </View>

      {/* Pending Queue Badge */}
      {pendingQueueCount > 0 && (
        <View className="ml-2 px-2 py-0.5 rounded-full bg-yellow-500/20">
          <Text className="text-xs text-yellow-500 font-medium">
            {pendingQueueCount} queued
          </Text>
        </View>
      )}

      {/* Expand Icon */}
      {onPress && (
        <Ionicons
          name="chevron-forward"
          size={16}
          color="#71717a"
          style={{ marginLeft: 4 }}
        />
      )}
    </Pressable>
  );
}

// ============================================================================
// Compact Variant
// ============================================================================

/**
 * A compact version of ConnectionStatus showing only the dot indicator.
 * Useful for headers and compact spaces.
 *
 * @param props - Component props (same as ConnectionStatus)
 * @returns React element
 *
 * @example
 * <ConnectionStatusDot
 *   connectionState="connected"
 *   isOnline={true}
 *   isCliOnline={true}
 * />
 */
export function ConnectionStatusDot({
  connectionState,
  isOnline,
  isCliOnline,
  onPress,
}: Pick<ConnectionStatusProps, 'connectionState' | 'isOnline' | 'isCliOnline' | 'onPress'>) {
  const getEffectiveStatus = (): keyof typeof STATUS_CONFIG => {
    if (!isOnline) {
      return 'no_network';
    }
    if (connectionState === 'connected' && !isCliOnline) {
      return 'cli_offline';
    }
    return connectionState;
  };

  const effectiveStatus = getEffectiveStatus();
  const config = STATUS_CONFIG[effectiveStatus];

  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      className="p-2 rounded-full"
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
    >
      <View className="relative">
        <View
          className="w-3 h-3 rounded-full"
          style={{ backgroundColor: config.color }}
        />
        {config.pulse && (
          <View
            className="absolute inset-0 w-3 h-3 rounded-full animate-ping"
            style={{ backgroundColor: config.color, opacity: 0.5 }}
          />
        )}
      </View>
    </Pressable>
  );
}
