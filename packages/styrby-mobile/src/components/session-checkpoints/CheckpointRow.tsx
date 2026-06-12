/**
 * CheckpointRow — a single checkpoint item with metadata + restore/delete.
 *
 * Extracted from SessionCheckpoints.tsx (Cluster A2 split). Pure presentational.
 *
 * @module components/session-checkpoints/CheckpointRow
 */

import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { SessionCheckpoint } from 'styrby-shared';
import { formatCheckpointTime } from './checkpoint-format';

/** Props for a single checkpoint row. */
export interface CheckpointRowProps {
  checkpoint: SessionCheckpoint;
  isDeleting: boolean;
  isRestoring: boolean;
  onDelete: (cp: SessionCheckpoint) => void;
  onRestore: (cp: SessionCheckpoint) => void;
}

/**
 * Render a single checkpoint item with name, metadata, and action buttons.
 *
 * @param props - Row props.
 */
export function CheckpointRow({
  checkpoint,
  isDeleting,
  isRestoring,
  onDelete,
  onRestore,
}: CheckpointRowProps) {
  return (
    <View className="mb-2 rounded-2xl bg-zinc-900 border border-zinc-800 p-3">
      {/* Name + description */}
      <View className="flex-row items-start justify-between">
        <View className="flex-1 pr-2">
          <Text className="text-white text-sm font-semibold" numberOfLines={1}>
            {checkpoint.name}
          </Text>
          {checkpoint.description ? (
            <Text className="text-zinc-500 text-xs mt-0.5" numberOfLines={2}>
              {checkpoint.description}
            </Text>
          ) : null}
        </View>

        {/* Delete button */}
        <Pressable
          onPress={() => onDelete(checkpoint)}
          disabled={isDeleting}
          className="p-1 rounded-lg active:opacity-60"
          accessibilityRole="button"
          accessibilityLabel={`Delete checkpoint ${checkpoint.name}`}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          {isDeleting ? (
            <ActivityIndicator size="small" color="#71717a" />
          ) : (
            <Ionicons name="trash-outline" size={16} color="#ef4444" />
          )}
        </Pressable>
      </View>

      {/* Metadata row */}
      <View className="flex-row items-center mt-2 gap-3">
        <View className="flex-row items-center gap-1">
          <Ionicons name="list-outline" size={11} color="#71717a" />
          <Text className="text-zinc-600 text-xs">Msg {checkpoint.messageSequenceNumber}</Text>
        </View>

        {checkpoint.contextSnapshot.totalTokens > 0 && (
          <View className="flex-row items-center gap-1">
            <Ionicons name="analytics-outline" size={11} color="#71717a" />
            <Text className="text-zinc-600 text-xs">
              {checkpoint.contextSnapshot.totalTokens.toLocaleString()} tokens
            </Text>
          </View>
        )}

        <View className="flex-row items-center ml-auto gap-1">
          <Ionicons name="time-outline" size={11} color="#71717a" />
          <Text className="text-zinc-600 text-xs">{formatCheckpointTime(checkpoint.createdAt)}</Text>
        </View>
      </View>

      {/* Restore button */}
      <Pressable
        onPress={() => onRestore(checkpoint)}
        disabled={isRestoring}
        className="mt-2 flex-row items-center justify-center bg-zinc-800 rounded-xl py-2 active:opacity-70"
        accessibilityRole="button"
        accessibilityLabel={`Restore to checkpoint ${checkpoint.name}`}
      >
        {isRestoring ? (
          <ActivityIndicator size="small" color="#f97316" />
        ) : (
          <>
            <Ionicons name="git-branch-outline" size={14} color="#f97316" />
            <Text className="text-orange-400 text-xs font-medium ml-1">Restore to here</Text>
          </>
        )}
      </Pressable>
    </View>
  );
}
