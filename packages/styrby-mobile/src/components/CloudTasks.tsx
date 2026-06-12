/**
 * CloudTasks Component
 *
 * The user's cloud agent task list with real-time status updates (covers the
 * "Cloud Monitoring" and "Code Review From Mobile" premium features). Loads the
 * 25 most recent `cloud_tasks` rows, subscribes to Supabase Realtime for live
 * status, and renders interactive task cards + a detail modal.
 *
 * Cluster A2 split: the data/realtime/tick/cancel logic moved to
 * `./cloud-tasks/useCloudTasks`, and the sub-components / formatters to
 * `./cloud-tasks/*`, keeping this file under the 400-LOC ceiling.
 *
 * TIER GATE (mobile-side): premium-only — callers MUST check the user's tier
 * before rendering this component (a null tier is not sufficient).
 *
 * @module components/CloudTasks
 */

import { View, Text, FlatList, Pressable, Modal, ScrollView, ActivityIndicator, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StatusBadge } from './cloud-tasks/StatusBadge';
import { TaskCard } from './cloud-tasks/TaskCard';
import { formatCost, formatRelativeTime } from './cloud-tasks/task-format';
import { useCloudTasks } from './cloud-tasks/useCloudTasks';

/** Props for the CloudTasks component. */
export interface CloudTasksProps {
  /** Authenticated user's Supabase ID — scopes the query + realtime subscription. */
  userId: string;
  /** Called when the user cancels a queued/running task. */
  onCancelTask?: (taskId: string) => Promise<void>;
}

/**
 * Cloud task list with real-time status updates.
 *
 * @param props - CloudTasksProps.
 */
export function CloudTasks({ userId, onCancelTask }: CloudTasksProps) {
  const {
    tasks,
    isLoading,
    isRefreshing,
    selectedTask,
    setSelectedTask,
    isCancelling,
    handleRefresh,
    handleCancel,
  } = useCloudTasks(userId, onCancelTask);

  if (isLoading) {
    return (
      <View style={{ padding: 16, alignItems: 'center' }}>
        <ActivityIndicator size="small" color="#f97316" />
        <Text style={{ color: '#71717a', marginTop: 8, fontSize: 14 }}>Loading tasks...</Text>
      </View>
    );
  }

  if (tasks.length === 0) {
    return (
      <View style={{ padding: 24, alignItems: 'center' }}>
        <Ionicons name="cloud-outline" size={40} color="#3f3f46" />
        <Text style={{ color: '#71717a', marginTop: 12, fontSize: 14, textAlign: 'center' }}>
          No cloud tasks yet.{'\n'}Use <Text style={{ color: '#f97316' }}>styrby cloud submit</Text> from your CLI to
          queue async agent tasks.
        </Text>
      </View>
    );
  }

  return (
    <>
      <FlatList
        data={tasks}
        keyExtractor={(t) => t.id}
        renderItem={({ item }) => (
          <TaskCard
            task={item}
            onTap={() => setSelectedTask(item)}
            onCancel={
              onCancelTask && (item.status === 'queued' || item.status === 'running')
                ? () => void handleCancel(item.id)
                : undefined
            }
          />
        )}
        contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 8 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} tintColor="#f97316" />}
      />

      {/* Task Detail Modal */}
      <Modal
        visible={selectedTask !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setSelectedTask(null)}
        accessibilityViewIsModal
      >
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: '#18181b', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '80%' }}>
            {/* Modal Header */}
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                padding: 16,
                borderBottomWidth: 1,
                borderBottomColor: '#27272a',
              }}
            >
              {selectedTask && <StatusBadge status={selectedTask.status} />}
              <Text style={{ color: '#71717a', fontSize: 12, marginLeft: 10 }} numberOfLines={1}>
                {selectedTask?.metadata?.gitBranch ?? selectedTask?.agentType}
              </Text>
              <Pressable
                onPress={() => setSelectedTask(null)}
                style={{ marginLeft: 'auto' as never, padding: 4 }}
                accessibilityRole="button"
                accessibilityLabel="Close task detail"
              >
                <Ionicons name="close" size={22} color="#71717a" />
              </Pressable>
            </View>

            <ScrollView style={{ padding: 16 }}>
              {/* Prompt */}
              <Text style={{ color: '#a1a1aa', fontSize: 12, fontWeight: '600', marginBottom: 6, textTransform: 'uppercase' }}>
                Prompt
              </Text>
              <Text style={{ color: 'white', fontSize: 15, lineHeight: 22, marginBottom: 16 }}>
                {selectedTask?.prompt}
              </Text>

              {/* Result */}
              {selectedTask?.result && (
                <>
                  <Text style={{ color: '#a1a1aa', fontSize: 12, fontWeight: '600', marginBottom: 6, textTransform: 'uppercase' }}>
                    Result
                  </Text>
                  <View style={{ backgroundColor: '#27272a', borderRadius: 10, padding: 12, marginBottom: 16 }}>
                    <Text style={{ color: '#d4d4d8', fontSize: 14, lineHeight: 20 }}>{selectedTask.result}</Text>
                  </View>
                </>
              )}

              {/* Error */}
              {selectedTask?.errorMessage && (
                <>
                  <Text style={{ color: '#ef4444', fontSize: 12, fontWeight: '600', marginBottom: 6, textTransform: 'uppercase' }}>
                    Error
                  </Text>
                  <View style={{ backgroundColor: 'rgba(239,68,68,0.1)', borderRadius: 10, padding: 12, marginBottom: 16 }}>
                    <Text style={{ color: '#fca5a5', fontSize: 14, lineHeight: 20 }}>{selectedTask.errorMessage}</Text>
                  </View>
                </>
              )}

              {/* Cost and timestamps */}
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
                {selectedTask?.costUsd !== undefined && (
                  <View>
                    <Text style={{ color: '#71717a', fontSize: 11 }}>Cost</Text>
                    <Text style={{ color: '#22c55e', fontSize: 14, fontWeight: '600' }}>
                      {formatCost(selectedTask.costUsd)}
                    </Text>
                  </View>
                )}
                {selectedTask?.completedAt && (
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ color: '#71717a', fontSize: 11 }}>Completed</Text>
                    <Text style={{ color: '#d4d4d8', fontSize: 14 }}>{formatRelativeTime(selectedTask.completedAt)}</Text>
                  </View>
                )}
              </View>

              {/* Cancel button inside modal for active tasks */}
              {selectedTask && (selectedTask.status === 'queued' || selectedTask.status === 'running') && onCancelTask && (
                <Pressable
                  onPress={() => {
                    void handleCancel(selectedTask.id);
                    setSelectedTask(null);
                  }}
                  disabled={isCancelling === selectedTask.id}
                  style={{
                    marginTop: 8,
                    marginBottom: 16,
                    paddingVertical: 14,
                    borderRadius: 12,
                    backgroundColor: 'rgba(239,68,68,0.1)',
                    borderWidth: 1,
                    borderColor: 'rgba(239,68,68,0.3)',
                    alignItems: 'center',
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel this task"
                >
                  {isCancelling === selectedTask.id ? (
                    <ActivityIndicator size="small" color="#ef4444" />
                  ) : (
                    <Text style={{ color: '#ef4444', fontWeight: '700', fontSize: 15 }}>Cancel Task</Text>
                  )}
                </Pressable>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}
