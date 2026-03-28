/**
 * Session Checkpoints Component (Mobile)
 *
 * Displays a list of named checkpoints for a session, with controls to save
 * new checkpoints, restore to a position, and delete existing ones.
 *
 * Designed for the session detail screen. Checkpoints are fetched from and
 * written to Supabase via the shared REST API (same endpoint as Web).
 *
 * WHY: Named checkpoints give users a way to mark "known good" states in long
 * AI coding sessions so they can review or restart from that position.
 * Inspired by Gemini CLI's `/resume save [name]` feature.
 */

import { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  Pressable,
  TextInput,
  FlatList,
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import type { SessionCheckpoint } from 'styrby-shared';

// ============================================================================
// Types
// ============================================================================

/**
 * Props for the SessionCheckpoints component.
 */
interface SessionCheckpointsProps {
  /** Session ID whose checkpoints to display */
  sessionId: string;
  /** Current message count for new checkpoint position */
  currentMessageCount?: number;
  /** Whether the session is currently active */
  isSessionActive?: boolean;
  /**
   * Called when the user taps "Restore" on a checkpoint.
   * The parent screen uses this to filter/scroll messages.
   */
  onRestore?: (checkpoint: SessionCheckpoint) => void;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Formats a checkpoint timestamp into a short readable string.
 *
 * @param isoTimestamp - ISO 8601 timestamp
 * @returns Formatted string like "Mar 27, 2:30 PM"
 */
function formatCheckpointTime(isoTimestamp: string): string {
  return new Date(isoTimestamp).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// ============================================================================
// Sub-components
// ============================================================================

/**
 * Single checkpoint row in the list.
 */
interface CheckpointRowProps {
  checkpoint: SessionCheckpoint;
  isDeleting: boolean;
  isRestoring: boolean;
  onDelete: (cp: SessionCheckpoint) => void;
  onRestore: (cp: SessionCheckpoint) => void;
}

/**
 * Renders a single checkpoint item with name, metadata, and action buttons.
 */
function CheckpointRow({
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
          <Text className="text-zinc-600 text-xs">
            Msg {checkpoint.messageSequenceNumber}
          </Text>
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
          <Text className="text-zinc-600 text-xs">
            {formatCheckpointTime(checkpoint.createdAt)}
          </Text>
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
            <Text className="text-orange-400 text-xs font-medium ml-1">
              Restore to here
            </Text>
          </>
        )}
      </Pressable>
    </View>
  );
}

// ============================================================================
// Main Component
// ============================================================================

/**
 * Displays named checkpoints for a session with save, restore, and delete.
 *
 * @param props - Component props
 * @returns React element for the checkpoint panel
 *
 * @example
 * <SessionCheckpoints
 *   sessionId={session.id}
 *   currentMessageCount={session.message_count}
 *   isSessionActive={false}
 *   onRestore={(cp) => scrollToMessage(cp.messageSequenceNumber)}
 * />
 */
export function SessionCheckpoints({
  sessionId,
  currentMessageCount = 0,
  isSessionActive = false,
  onRestore,
}: SessionCheckpointsProps) {
  const [checkpoints, setCheckpoints] = useState<SessionCheckpoint[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);

  // ──────────────────────────────────────────────────────────────────────────
  // Fetch checkpoints
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Load checkpoints for this session from Supabase.
   *
   * WHY: We query Supabase directly rather than the REST API on mobile
   * because the mobile app already has an authenticated Supabase client
   * with the user's JWT. This avoids an extra HTTP round-trip.
   */
  const fetchCheckpoints = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const { data, error: dbError } = await supabase
        .from('session_checkpoints')
        .select('*')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: false });

      if (dbError) throw dbError;

      const mapped: SessionCheckpoint[] = (data ?? []).map((row) => {
        const snapshot = (row.context_snapshot ?? {}) as {
          totalTokens?: number;
          fileCount?: number;
        };
        return {
          id: row.id as string,
          sessionId: row.session_id as string,
          name: row.name as string,
          description: (row.description as string | null) ?? undefined,
          messageSequenceNumber: (row.message_sequence_number as number) ?? 0,
          contextSnapshot: {
            totalTokens: snapshot.totalTokens ?? 0,
            fileCount: snapshot.fileCount ?? 0,
          },
          createdAt: row.created_at as string,
        };
      });

      setCheckpoints(mapped);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load checkpoints';
      setError(msg);
      if (__DEV__) console.error('[SessionCheckpoints] fetch error:', err);
    } finally {
      setIsLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    fetchCheckpoints();
  }, [fetchCheckpoints]);

  // ──────────────────────────────────────────────────────────────────────────
  // Save checkpoint
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Saves a new checkpoint at the current message position.
   *
   * Validates the name, inserts into Supabase, and refreshes the list.
   */
  const handleSave = useCallback(async () => {
    const trimmedName = newName.trim();

    if (!trimmedName) {
      setSaveError('Name is required');
      return;
    }
    if (trimmedName.length > 80) {
      setSaveError('Name must be 80 characters or fewer');
      return;
    }
    if (!/^[a-zA-Z0-9 \-_.]+$/.test(trimmedName)) {
      setSaveError('Name may only contain letters, numbers, spaces, hyphens, underscores, and dots');
      return;
    }

    setIsSaving(true);
    setSaveError(null);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { error: insertError } = await supabase
        .from('session_checkpoints')
        .insert({
          session_id: sessionId,
          user_id: user.id,
          name: trimmedName,
          description: newDescription.trim() || null,
          message_sequence_number: currentMessageCount,
          context_snapshot: { totalTokens: 0, fileCount: 0 },
        });

      if (insertError) {
        if (insertError.code === '23505') {
          throw new Error(`A checkpoint named "${trimmedName}" already exists`);
        }
        throw insertError;
      }

      setNewName('');
      setNewDescription('');
      setShowSaveModal(false);
      await fetchCheckpoints();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save checkpoint');
      if (__DEV__) console.error('[SessionCheckpoints] save error:', err);
    } finally {
      setIsSaving(false);
    }
  }, [sessionId, newName, newDescription, currentMessageCount, fetchCheckpoints]);

  // ──────────────────────────────────────────────────────────────────────────
  // Delete checkpoint
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Deletes a checkpoint after user confirmation.
   *
   * @param checkpoint - The checkpoint to delete
   */
  const handleDelete = useCallback(
    (checkpoint: SessionCheckpoint) => {
      Alert.alert(
        'Delete Checkpoint',
        `Delete "${checkpoint.name}"? This cannot be undone.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: async () => {
              setDeletingId(checkpoint.id);
              try {
                const { error: deleteError } = await supabase
                  .from('session_checkpoints')
                  .delete()
                  .eq('id', checkpoint.id);

                if (deleteError) throw deleteError;
                setCheckpoints((prev) => prev.filter((c) => c.id !== checkpoint.id));
              } catch (err) {
                Alert.alert(
                  'Delete Failed',
                  err instanceof Error ? err.message : 'Failed to delete checkpoint'
                );
                if (__DEV__) console.error('[SessionCheckpoints] delete error:', err);
              } finally {
                setDeletingId(null);
              }
            },
          },
        ]
      );
    },
    []
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Restore checkpoint
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Invokes the onRestore callback and briefly shows a loading indicator.
   *
   * @param checkpoint - Checkpoint to restore to
   */
  const handleRestore = useCallback(
    (checkpoint: SessionCheckpoint) => {
      setRestoringId(checkpoint.id);
      onRestore?.(checkpoint);
      setTimeout(() => setRestoringId(null), 800);
    },
    [onRestore]
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Render
  // ──────────────────────────────────────────────────────────────────────────

  return (
    <View className="mx-4 mb-4">
      {/* Section header */}
      <View className="flex-row items-center justify-between mb-3">
        <Text className="text-zinc-400 text-xs font-medium uppercase tracking-wide">
          Checkpoints
        </Text>
        <Pressable
          onPress={() => {
            setShowSaveModal(true);
            setSaveError(null);
          }}
          className="flex-row items-center bg-zinc-800 rounded-lg px-2 py-1 active:opacity-70"
          accessibilityRole="button"
          accessibilityLabel="Save new checkpoint"
        >
          <Ionicons name="add" size={14} color="#f97316" />
          <Text className="text-orange-400 text-xs font-medium ml-1">Save</Text>
        </Pressable>
      </View>

      {/* Loading */}
      {isLoading && (
        <View className="items-center py-4">
          <ActivityIndicator size="small" color="#f97316" />
        </View>
      )}

      {/* Error */}
      {error && !isLoading && (
        <View className="rounded-2xl bg-zinc-900 border border-zinc-800 p-3">
          <Text className="text-red-400 text-sm">{error}</Text>
          <Pressable onPress={fetchCheckpoints} className="mt-2 active:opacity-70">
            <Text className="text-orange-400 text-sm">Retry</Text>
          </Pressable>
        </View>
      )}

      {/* Empty state */}
      {!isLoading && !error && checkpoints.length === 0 && (
        <View className="rounded-2xl bg-zinc-900 border border-zinc-800 p-4 items-center">
          <Ionicons name="git-branch-outline" size={28} color="#3f3f46" />
          <Text className="text-zinc-500 text-sm mt-2">No checkpoints yet</Text>
          <Text className="text-zinc-600 text-xs mt-1 text-center">
            Tap Save to mark a position in this session
          </Text>
        </View>
      )}

      {/* Checkpoint list */}
      {!isLoading && checkpoints.length > 0 && (
        <View>
          {checkpoints.map((cp) => (
            <CheckpointRow
              key={cp.id}
              checkpoint={cp}
              isDeleting={deletingId === cp.id}
              isRestoring={restoringId === cp.id}
              onDelete={handleDelete}
              onRestore={handleRestore}
            />
          ))}
        </View>
      )}

      {/* Save modal */}
      <Modal
        visible={showSaveModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowSaveModal(false)}
        accessibilityViewIsModal
      >
        <View className="flex-1 bg-black/60 justify-end">
          <View className="bg-zinc-900 rounded-t-3xl px-4 pt-4 pb-8">
            {/* Handle */}
            <View className="w-10 h-1 bg-zinc-700 rounded-full self-center mb-4" />

            <Text className="text-white text-lg font-semibold mb-4">
              Save Checkpoint
            </Text>

            {/* Name input */}
            <Text className="text-zinc-400 text-sm mb-1">Name</Text>
            <TextInput
              value={newName}
              onChangeText={(t) => {
                setNewName(t);
                setSaveError(null);
              }}
              placeholder="e.g. before-refactor"
              placeholderTextColor="#52525b"
              maxLength={80}
              className="bg-zinc-800 text-white rounded-xl px-4 py-3 mb-3 border border-zinc-700"
              accessibilityLabel="Checkpoint name"
              autoFocus
              returnKeyType="next"
            />

            {/* Description input */}
            <Text className="text-zinc-400 text-sm mb-1">Description (optional)</Text>
            <TextInput
              value={newDescription}
              onChangeText={setNewDescription}
              placeholder="What's working at this point?"
              placeholderTextColor="#52525b"
              className="bg-zinc-800 text-white rounded-xl px-4 py-3 mb-3 border border-zinc-700"
              accessibilityLabel="Checkpoint description"
              returnKeyType="done"
              onSubmitEditing={handleSave}
            />

            {/* Error message */}
            {saveError && (
              <Text className="text-red-400 text-sm mb-3">{saveError}</Text>
            )}

            {/* Current position info */}
            <Text className="text-zinc-600 text-xs mb-4">
              This checkpoint will mark message {currentMessageCount} in the session.
            </Text>

            {/* Action buttons */}
            <Pressable
              onPress={handleSave}
              disabled={isSaving || !newName.trim()}
              className="bg-orange-500 rounded-2xl py-4 items-center mb-3 active:opacity-80 disabled:opacity-50"
              accessibilityRole="button"
              accessibilityLabel={isSaving ? 'Saving checkpoint...' : 'Save checkpoint'}
            >
              {isSaving ? (
                <ActivityIndicator color="white" />
              ) : (
                <Text className="text-white font-semibold">Save Checkpoint</Text>
              )}
            </Pressable>

            <Pressable
              onPress={() => {
                setShowSaveModal(false);
                setSaveError(null);
              }}
              className="bg-zinc-800 rounded-2xl py-4 items-center active:opacity-80"
              accessibilityRole="button"
              accessibilityLabel="Cancel"
            >
              <Text className="text-zinc-300 font-semibold">Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

export default SessionCheckpoints;
