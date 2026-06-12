/**
 * useSessionCheckpoints — fetch/save/delete/restore engine for the checkpoint panel.
 *
 * Extracted from SessionCheckpoints.tsx (Cluster A2 split). Owns every piece of
 * state the panel renders (list, loading/error, per-row pending flags, and the
 * save-modal form) plus the Supabase CRUD. The component consumes the returned
 * state and only renders.
 *
 * @module components/session-checkpoints/useSessionCheckpoints
 */

import { useState, useCallback, useEffect } from 'react';
import { Alert } from 'react-native';
import { supabase } from '../../lib/supabase';
import type { SessionCheckpoint } from 'styrby-shared';
import { validateCheckpointName, rowToCheckpoint } from './checkpoint-format';

/** State + handlers the SessionCheckpoints panel needs. */
export interface UseSessionCheckpoints {
  checkpoints: SessionCheckpoint[];
  isLoading: boolean;
  error: string | null;
  deletingId: string | null;
  restoringId: string | null;
  showSaveModal: boolean;
  isSaving: boolean;
  newName: string;
  newDescription: string;
  saveError: string | null;
  setNewName: (name: string) => void;
  setNewDescription: (desc: string) => void;
  openSaveModal: () => void;
  closeSaveModal: () => void;
  fetchCheckpoints: () => Promise<void>;
  handleSave: () => Promise<void>;
  handleDelete: (checkpoint: SessionCheckpoint) => void;
  handleRestore: (checkpoint: SessionCheckpoint) => void;
}

/**
 * Drive the checkpoint panel: load, save, delete, and restore.
 *
 * @param sessionId - Session whose checkpoints to manage.
 * @param currentMessageCount - Position a new checkpoint marks.
 * @param onRestore - Parent callback when a checkpoint is restored.
 * @returns State + handlers for the panel.
 */
export function useSessionCheckpoints(
  sessionId: string,
  currentMessageCount: number,
  onRestore?: (checkpoint: SessionCheckpoint) => void,
): UseSessionCheckpoints {
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

  // ── Fetch ───────────────────────────────────────────────────────────────────

  /**
   * Load checkpoints for this session from Supabase.
   *
   * WHY query Supabase directly (not the REST API): the mobile app already has
   * an authenticated Supabase client with the user's JWT, so this avoids an
   * extra HTTP round-trip.
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

      setCheckpoints((data ?? []).map(rowToCheckpoint));
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

  // ── Save ──────────────────────────────────────────────────────────────────--

  /**
   * Save a new checkpoint at the current message position.
   *
   * Validates the name client-side, inserts into Supabase, and refreshes.
   */
  const handleSave = useCallback(async () => {
    const validationError = validateCheckpointName(newName);
    if (validationError) {
      setSaveError(validationError);
      return;
    }
    const trimmedName = newName.trim();

    setIsSaving(true);
    setSaveError(null);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { error: insertError } = await supabase.from('session_checkpoints').insert({
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

  // ── Delete ────────────────────────────────────────────────────────────────--

  /**
   * Delete a checkpoint after user confirmation.
   *
   * @param checkpoint - The checkpoint to delete.
   */
  const handleDelete = useCallback((checkpoint: SessionCheckpoint) => {
    Alert.alert('Delete Checkpoint', `Delete "${checkpoint.name}"? This cannot be undone.`, [
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
              err instanceof Error ? err.message : 'Failed to delete checkpoint',
            );
            if (__DEV__) console.error('[SessionCheckpoints] delete error:', err);
          } finally {
            setDeletingId(null);
          }
        },
      },
    ]);
  }, []);

  // ── Restore ───────────────────────────────────────────────────────────────--

  /**
   * Invoke the onRestore callback and briefly show a loading indicator.
   *
   * @param checkpoint - Checkpoint to restore to.
   */
  const handleRestore = useCallback(
    (checkpoint: SessionCheckpoint) => {
      setRestoringId(checkpoint.id);
      onRestore?.(checkpoint);
      setTimeout(() => setRestoringId(null), 800);
    },
    [onRestore],
  );

  // ── Save-modal transport ────────────────────────────────────────────────────

  const openSaveModal = useCallback(() => {
    setShowSaveModal(true);
    setSaveError(null);
  }, []);

  const closeSaveModal = useCallback(() => {
    setShowSaveModal(false);
    setSaveError(null);
  }, []);

  // Clear the save error as the user edits the name.
  const setNewNameAndClearError = useCallback((name: string) => {
    setNewName(name);
    setSaveError(null);
  }, []);

  return {
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
    setNewName: setNewNameAndClearError,
    setNewDescription,
    openSaveModal,
    closeSaveModal,
    fetchCheckpoints,
    handleSave,
    handleDelete,
    handleRestore,
  };
}
