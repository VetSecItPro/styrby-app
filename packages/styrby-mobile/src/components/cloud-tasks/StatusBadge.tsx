/**
 * StatusBadge — cloud-task status pill.
 *
 * Extracted from CloudTasks.tsx (Cluster A2 split).
 *
 * @module components/cloud-tasks/StatusBadge
 */

import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { CloudTaskStatus } from 'styrby-shared';
import { STATUS_CONFIG } from './task-format';

/**
 * @param status - The status to display.
 */
export function StatusBadge({ status }: { status: CloudTaskStatus }) {
  const cfg = STATUS_CONFIG[status];
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 999,
        backgroundColor: `${cfg.color}20`,
      }}
    >
      <Ionicons name={cfg.icon} size={12} color={cfg.color} />
      <Text style={{ color: cfg.color, fontSize: 12, fontWeight: '600', marginLeft: 4 }}>{cfg.label}</Text>
    </View>
  );
}
