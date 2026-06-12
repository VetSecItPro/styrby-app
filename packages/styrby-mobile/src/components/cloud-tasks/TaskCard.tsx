/**
 * TaskCard — a single cloud-task row in the list.
 *
 * Extracted from CloudTasks.tsx (Cluster A2 split).
 *
 * @module components/cloud-tasks/TaskCard
 */

import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { CloudTask } from 'styrby-shared';
import { AGENT_COLORS, STATUS_CONFIG, computeProgress, formatRelativeTime, formatCost } from './task-format';
import { StatusBadge } from './StatusBadge';
import { ProgressBar } from './ProgressBar';

/**
 * @param task - The task to render.
 * @param onTap - Called when the card is tapped (open detail).
 * @param onCancel - Optional cancel handler (active tasks only).
 */
export function TaskCard({
  task,
  onCancel,
  onTap,
}: {
  task: CloudTask;
  onCancel?: () => void;
  onTap: () => void;
}) {
  const agentColor = AGENT_COLORS[task.agentType] ?? '#71717a';
  const isActive = task.status === 'queued' || task.status === 'running';
  const progress = task.status === 'running' ? computeProgress(task.startedAt, task.estimatedDurationMs) : 0;

  return (
    <Pressable
      onPress={onTap}
      style={{
        backgroundColor: '#18181b',
        borderRadius: 12,
        padding: 14,
        marginBottom: 10,
        borderWidth: 1,
        borderColor: '#27272a',
      }}
      accessibilityRole="button"
      accessibilityLabel={`Cloud task: ${task.prompt.slice(0, 60)}. Status: ${STATUS_CONFIG[task.status].label}. Tap to view details.`}
    >
      {/* Header row: agent badge + status + time */}
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
        <View
          style={{
            width: 24,
            height: 24,
            borderRadius: 6,
            backgroundColor: `${agentColor}20`,
            alignItems: 'center',
            justifyContent: 'center',
            marginRight: 8,
          }}
        >
          <Text style={{ color: agentColor, fontSize: 10, fontWeight: '700' }}>
            {task.agentType.slice(0, 2).toUpperCase()}
          </Text>
        </View>

        <StatusBadge status={task.status} />

        <Text style={{ color: '#71717a', fontSize: 12, marginLeft: 'auto' as never }}>
          {formatRelativeTime(task.startedAt)}
        </Text>
      </View>

      {/* Prompt preview */}
      <Text numberOfLines={2} style={{ color: '#e4e4e7', fontSize: 14, lineHeight: 20, marginBottom: 6 }}>
        {task.prompt}
      </Text>

      {/* Metadata row: project/branch + cost + cancel */}
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        {task.metadata?.gitBranch && (
          <View style={{ flexDirection: 'row', alignItems: 'center', marginRight: 12 }}>
            <Ionicons name="git-branch-outline" size={12} color="#71717a" />
            <Text style={{ color: '#71717a', fontSize: 12, marginLeft: 4 }}>{task.metadata.gitBranch}</Text>
          </View>
        )}
        {task.costUsd !== undefined && task.status === 'completed' && (
          <Text style={{ color: '#71717a', fontSize: 12 }}>{formatCost(task.costUsd)}</Text>
        )}

        {isActive && onCancel && (
          <Pressable
            onPress={(e) => {
              e.stopPropagation();
              onCancel();
            }}
            style={{
              marginLeft: 'auto' as never,
              paddingHorizontal: 10,
              paddingVertical: 4,
              borderRadius: 8,
              backgroundColor: '#27272a',
            }}
            accessibilityRole="button"
            accessibilityLabel="Cancel task"
          >
            <Text style={{ color: '#ef4444', fontSize: 12, fontWeight: '600' }}>Cancel</Text>
          </Pressable>
        )}
      </View>

      {/* Progress bar for running tasks with an estimate */}
      {task.status === 'running' && task.estimatedDurationMs && <ProgressBar progress={progress} />}

      {/* Running spinner for tasks without estimates */}
      {task.status === 'running' && !task.estimatedDurationMs && (
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8 }}>
          <ActivityIndicator size="small" color="#3b82f6" />
          <Text style={{ color: '#3b82f6', fontSize: 12, marginLeft: 8 }}>Running…</Text>
        </View>
      )}
    </Pressable>
  );
}
