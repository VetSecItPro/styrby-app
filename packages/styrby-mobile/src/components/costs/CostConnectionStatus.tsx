/**
 * Small badge showing whether the realtime cost subscription is connected.
 *
 * WHY (vs. components/ConnectionStatus.tsx): That component visualizes the
 * CLI relay connection (multi-state: connected/connecting/error/CLI offline).
 * This one is a tiny binary live/offline indicator scoped to the costs
 * dashboard's realtime cost-record subscription. Different domain, different
 * states, different visual — keeping them separate avoids overloading one
 * component with unrelated responsibilities.
 *
 * @module components/costs/CostConnectionStatus
 */

import { View, Text } from 'react-native';
import type { CostConnectionStatusProps } from '../../types/costs';

/**
 * Renders a green "Live" or orange "Offline" pill for realtime cost data.
 *
 * @param props - {@link CostConnectionStatusProps}
 * @returns Rendered badge
 */
export function CostConnectionStatus({ isConnected }: CostConnectionStatusProps) {
  return (
    <View
      className="flex-row items-center"
      accessibilityLabel={isConnected ? 'Live data connection active' : 'Data connection offline'}
    >
      <View
        className={`w-2 h-2 rounded-full mr-1.5 ${
          isConnected ? 'bg-green-500' : 'bg-orange-500'
        }`}
      />
      <Text className={`text-xs font-medium ${
        isConnected ? 'text-green-500' : 'text-orange-500'
      }`}>
        {isConnected ? 'Live' : 'Offline'}
      </Text>
    </View>
  );
}
