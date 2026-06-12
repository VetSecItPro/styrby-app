/**
 * ProgressBar — estimated-duration progress for a running cloud task.
 *
 * Extracted from CloudTasks.tsx (Cluster A2 split).
 *
 * @module components/cloud-tasks/ProgressBar
 */

import { View } from 'react-native';

/**
 * @param progress - Percentage (0–100) of estimated duration elapsed.
 */
export function ProgressBar({ progress }: { progress: number }) {
  return (
    <View style={{ height: 4, backgroundColor: '#27272a', borderRadius: 2, marginTop: 8, overflow: 'hidden' }}>
      <View style={{ height: 4, width: `${progress}%`, backgroundColor: '#3b82f6', borderRadius: 2 }} />
    </View>
  );
}
