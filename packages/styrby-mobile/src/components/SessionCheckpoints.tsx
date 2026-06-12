/**
 * Session Checkpoints Component (Mobile)
 *
 * Displays a list of named checkpoints for a session, with controls to save
 * new checkpoints, restore to a position, and delete existing ones.
 *
 * Designed for the session detail screen. Checkpoints are fetched from and
 * written to Supabase.
 *
 * Orchestrator only (Cluster A2 split): all CRUD + form state lives in
 * `useSessionCheckpoints`, validation/mapping in `checkpoint-format`, and the
 * row + save sheet in their own sub-components. This file renders the panel.
 *
 * WHY: Named checkpoints give users a way to mark "known good" states in long
 * AI coding sessions so they can review or restart from that position.
 * Inspired by Gemini CLI's `/resume save [name]` feature.
 */

import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSessionCheckpoints } from './session-checkpoints/useSessionCheckpoints';
import { CheckpointRow } from './session-checkpoints/CheckpointRow';
import { SaveCheckpointModal } from './session-checkpoints/SaveCheckpointModal';
import type { SessionCheckpointsProps } from './session-checkpoints/types';

/**
 * Display named checkpoints for a session with save, restore, and delete.
 *
 * @param props - Component props.
 * @returns React element for the checkpoint panel.
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
  // isSessionActive is accepted for API stability but not currently rendered.
  isSessionActive: _isSessionActive = false,
  onRestore,
}: SessionCheckpointsProps) {
  const {
    checkpoints,
    isLoading,
    error,
    deletingId,
    restoringId,
    showSaveModal,
    isSaving,
    newName,
    newDescription,
    saveError,
    setNewName,
    setNewDescription,
    openSaveModal,
    closeSaveModal,
    fetchCheckpoints,
    handleSave,
    handleDelete,
    handleRestore,
  } = useSessionCheckpoints(sessionId, currentMessageCount, onRestore);

  return (
    <View className="mx-4 mb-4">
      {/* Section header */}
      <View className="flex-row items-center justify-between mb-3">
        <Text className="text-zinc-400 text-xs font-medium uppercase tracking-wide">
          Checkpoints
        </Text>
        <Pressable
          onPress={openSaveModal}
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
      <SaveCheckpointModal
        visible={showSaveModal}
        newName={newName}
        newDescription={newDescription}
        saveError={saveError}
        isSaving={isSaving}
        currentMessageCount={currentMessageCount}
        onChangeName={setNewName}
        onChangeDescription={setNewDescription}
        onSave={handleSave}
        onClose={closeSaveModal}
      />
    </View>
  );
}

export default SessionCheckpoints;
