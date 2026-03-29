/**
 * Devices Screen (P12)
 *
 * Lists all paired CLI machines for the current user. Shows platform icons,
 * last-active timestamp, and online/offline status. Users can unpair a device
 * via a trash button (with confirmation alert) or swipe-to-delete gesture.
 *
 * Queries the `machines` table via the useDevices hook.
 * Navigates here from Settings > "Paired Devices" row.
 *
 * @route /devices
 */

import {
  View,
  Text,
  FlatList,
  RefreshControl,
  ActivityIndicator,
  Pressable,
  Alert,
} from 'react-native';
import { useCallback } from 'react';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useDevices } from '../src/hooks/useDevices';
import type { MachineRow } from '../src/hooks/useDevices';
import { formatRelativeTime } from '../src/hooks/useSessions';

// ============================================================================
// Platform Icon Component
// ============================================================================

/**
 * Props for the PlatformIcon component.
 */
interface PlatformIconProps {
  /** Platform string from the machines table ('darwin' | 'linux' | 'win32' | null) */
  platform: string | null;
}

/**
 * Renders an Ionicon appropriate for the machine's platform.
 *
 * - darwin → Apple logo (logo-apple)
 * - linux → terminal icon as proxy
 * - win32 → logo-windows
 * - null / unknown → hardware-chip outline
 *
 * @param platform - Platform identifier from the machines row
 */
function PlatformIcon({ platform }: PlatformIconProps) {
  let iconName: keyof typeof Ionicons.glyphMap = 'hardware-chip-outline';
  let color = '#71717a';

  switch (platform) {
    case 'darwin':
      iconName = 'logo-apple';
      color = '#a1a1aa';
      break;
    case 'linux':
      iconName = 'terminal-outline';
      color = '#f97316';
      break;
    case 'win32':
    case 'win':
      iconName = 'logo-windows';
      color = '#3b82f6';
      break;
  }

  return (
    <View
      className="w-12 h-12 rounded-xl items-center justify-center"
      style={{ backgroundColor: `${color}15` }}
    >
      <Ionicons name={iconName} size={24} color={color} />
    </View>
  );
}

// ============================================================================
// Machine Card Component
// ============================================================================

/**
 * Props for the MachineCard component.
 */
interface MachineCardProps {
  /** Machine row from Supabase */
  machine: MachineRow;
  /** Whether this machine is currently being deleted */
  isDeleting: boolean;
  /** Callback to initiate deletion */
  onDelete: (machine: MachineRow) => void;
}

/**
 * A single paired device card.
 *
 * Displays the platform icon, machine name, hostname, CLI version, and
 * online/offline status badge. A trash button triggers the delete confirmation.
 *
 * @param machine - The machine row to display
 * @param isDeleting - Whether delete is in-flight for this specific machine
 * @param onDelete - Called when the user confirms deletion
 */
function MachineCard({ machine, isDeleting, onDelete }: MachineCardProps) {
  const lastSeenLabel = machine.is_online
    ? 'Online now'
    : machine.last_seen_at
      ? `Last seen ${formatRelativeTime(machine.last_seen_at)}`
      : 'Never seen';

  return (
    <View
      className="mx-4 my-1.5 rounded-2xl bg-background-secondary border border-zinc-800 px-4 py-3"
      accessible
      accessibilityRole="none"
      accessibilityLabel={`${machine.name}, ${lastSeenLabel}`}
    >
      <View className="flex-row items-center">
        {/* Platform icon */}
        <PlatformIcon platform={machine.platform} />

        {/* Machine info */}
        <View className="flex-1 ml-3">
          {/* Name + online indicator */}
          <View className="flex-row items-center mb-0.5">
            <Text className="text-white font-semibold text-base flex-shrink mr-2" numberOfLines={1}>
              {machine.name}
            </Text>
            {machine.is_online && (
              <View className="w-2 h-2 rounded-full bg-green-500" />
            )}
          </View>

          {/* Hostname */}
          {machine.hostname ? (
            <Text className="text-zinc-500 text-xs mb-0.5" numberOfLines={1}>
              {machine.hostname}
            </Text>
          ) : null}

          {/* Status + CLI version row */}
          <View className="flex-row items-center flex-wrap mt-1">
            {/* Status badge */}
            <View
              className="px-2 py-0.5 rounded-full mr-2"
              style={{
                backgroundColor: machine.is_online ? '#22c55e15' : '#71717a15',
              }}
            >
              <Text
                className="text-xs font-medium"
                style={{ color: machine.is_online ? '#22c55e' : '#71717a' }}
              >
                {machine.is_online ? 'Online' : lastSeenLabel}
              </Text>
            </View>

            {/* CLI version */}
            {machine.cli_version ? (
              <Text className="text-zinc-600 text-xs">v{machine.cli_version}</Text>
            ) : null}
          </View>
        </View>

        {/* Trash / delete button */}
        <Pressable
          onPress={() => onDelete(machine)}
          disabled={isDeleting}
          hitSlop={8}
          className="p-2 ml-2"
          accessibilityRole="button"
          accessibilityLabel={`Unpair device ${machine.name}`}
        >
          {isDeleting ? (
            <ActivityIndicator size="small" color="#ef4444" />
          ) : (
            <Ionicons name="trash-outline" size={20} color="#71717a" />
          )}
        </Pressable>
      </View>
    </View>
  );
}

// ============================================================================
// Main Screen
// ============================================================================

/**
 * Devices list screen.
 *
 * Shows all machines paired to the current user's account. Supports
 * pull-to-refresh and per-device unpairing with a confirmation alert.
 *
 * @returns React element
 */
export default function DevicesScreen() {
  const router = useRouter();
  const { machines, isLoading, isRefreshing, error, deletingId, refresh, deleteMachine } =
    useDevices();

  // --------------------------------------------------------------------------
  // Delete handler
  // --------------------------------------------------------------------------

  /**
   * Show a confirmation alert before unpairing a device.
   * On confirm, calls deleteMachine and shows a success/error alert.
   *
   * WHY two-step: Unpairing requires the user to re-run `styrby pair` on
   * that machine. An accidental delete could disrupt an ongoing session.
   *
   * @param machine - The machine the user tapped "trash" on
   */
  const handleDeletePress = useCallback(
    (machine: MachineRow) => {
      Alert.alert(
        'Unpair Device?',
        `This will remove "${machine.name}" from your account. The CLI on that machine will need to re-pair to reconnect.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Unpair',
            style: 'destructive',
            onPress: async () => {
              const success = await deleteMachine(machine.id);
              if (!success) {
                Alert.alert(
                  'Unpair Failed',
                  'Could not remove the device. Please check your connection and try again.',
                );
              }
            },
          },
        ],
      );
    },
    [deleteMachine],
  );

  // --------------------------------------------------------------------------
  // Render: loading
  // --------------------------------------------------------------------------

  if (isLoading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="large" color="#f97316" />
        <Text className="text-zinc-500 mt-4">Loading devices...</Text>
      </View>
    );
  }

  // --------------------------------------------------------------------------
  // Render: error
  // --------------------------------------------------------------------------

  if (error && machines.length === 0) {
    return (
      <View className="flex-1 bg-background items-center justify-center px-6">
        <Ionicons name="alert-circle-outline" size={48} color="#ef4444" />
        <Text className="text-white text-lg font-semibold mt-4">Failed to Load Devices</Text>
        <Text className="text-zinc-500 text-center mt-2">{error}</Text>
        <Pressable
          onPress={refresh}
          className="bg-brand px-6 py-3 rounded-xl mt-6 active:opacity-80"
          accessibilityRole="button"
          accessibilityLabel="Retry loading devices"
        >
          <Text className="text-white font-semibold">Try Again</Text>
        </Pressable>
      </View>
    );
  }

  // --------------------------------------------------------------------------
  // Render: main list
  // --------------------------------------------------------------------------

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="flex-row items-center px-4 py-4 border-b border-zinc-800">
        <Pressable
          onPress={() => router.back()}
          className="mr-3 p-1"
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Go back to settings"
        >
          <Ionicons name="chevron-back" size={24} color="#f97316" />
        </Pressable>
        <View className="flex-1">
          <Text className="text-white text-xl font-bold">Paired Devices</Text>
          <Text className="text-zinc-500 text-sm">
            {machines.length} device{machines.length !== 1 ? 's' : ''} paired
          </Text>
        </View>
      </View>

      <FlatList
        data={machines}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <MachineCard
            machine={item}
            isDeleting={deletingId === item.id}
            onDelete={handleDeletePress}
          />
        )}
        contentContainerStyle={
          machines.length === 0
            ? { flexGrow: 1, paddingVertical: 16 }
            : { paddingVertical: 8 }
        }
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={refresh}
            tintColor="#f97316"
            colors={['#f97316']}
          />
        }
        ListEmptyComponent={
          <View className="flex-1 items-center justify-center py-20 px-6">
            <Ionicons name="hardware-chip-outline" size={52} color="#3f3f46" />
            <Text className="text-zinc-400 font-semibold text-lg mt-4">No Devices Paired</Text>
            <Text className="text-zinc-500 text-center mt-2">
              Run <Text className="text-orange-400 font-mono">styrby pair</Text> in your terminal
              to connect a machine to your account.
            </Text>
          </View>
        }
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}
