'use client';

/**
 * Session Checkpoints Panel
 *
 * Displays the list of named checkpoints for a session and provides controls
 * to save a new checkpoint, view restore details, or delete existing ones.
 *
 * Rendered in the session detail page sidebar for completed sessions, and
 * in an inline collapsible section for active sessions.
 *
 * WHY: Inspired by Gemini CLI's `/resume save [name]` feature. Power users
 * conducting long multi-phase AI sessions benefit from being able to mark
 * known-good states in the session timeline and jump back to them.
 */

import { useState, useCallback, useEffect } from 'react';
import type { SessionCheckpoint } from '@styrby/shared';

// ============================================================================
// Types
// ============================================================================

/**
 * Props for the SessionCheckpoints panel component.
 */
interface SessionCheckpointsProps {
  /** The session ID whose checkpoints to show */
  sessionId: string;
  /** User's API key or Supabase access token for authenticated requests */
  apiKey?: string;
  /** Current message count - used when saving a new checkpoint */
  currentMessageCount?: number;
  /** Whether the session is active (controls save button visibility) */
  isSessionActive?: boolean;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Formats a checkpoint creation timestamp for display.
 *
 * @param isoTimestamp - ISO 8601 timestamp
 * @returns Short human-readable string (e.g., "Mar 27, 2:30 PM")
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
// Component
// ============================================================================

/**
 * Panel that lists, creates, and deletes session checkpoints.
 *
 * @param props - Component props
 * @returns React element for the checkpoints panel
 *
 * @example
 * <SessionCheckpoints
 *   sessionId="abc123"
 *   currentMessageCount={42}
 *   isSessionActive={false}
 * />
 */
export function SessionCheckpoints({
  sessionId,
  currentMessageCount = 0,
  isSessionActive = false,
}: SessionCheckpointsProps) {
  const [checkpoints, setCheckpoints] = useState<SessionCheckpoint[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);

  // ──────────────────────────────────────────────────────────────────────────
  // Data loading
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Fetch checkpoints from the API.
   *
   * WHY: We load checkpoints from the REST API rather than Supabase client
   * directly because the web dashboard uses API key auth (same as CLI), keeping
   * the auth model consistent across all clients.
   */
  const fetchCheckpoints = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const res = await fetch(`/api/v1/sessions/${sessionId}/checkpoints`);

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }

      const data = await res.json() as { checkpoints: SessionCheckpoint[] };
      setCheckpoints(data.checkpoints ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load checkpoints');
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
   * Handles saving a new checkpoint via the API.
   *
   * Optimistically adds the checkpoint to the list on success, then
   * re-fetches to get the server-assigned ID and created_at.
   */
  const handleSave = useCallback(async () => {
    if (!newName.trim()) {
      setSaveError('Checkpoint name is required');
      return;
    }

    if (newName.length > 80) {
      setSaveError('Name must be 80 characters or fewer');
      return;
    }

    setIsSaving(true);
    setSaveError(null);

    try {
      const res = await fetch(`/api/v1/sessions/${sessionId}/checkpoints`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName.trim(),
          description: newDescription.trim() || undefined,
          messageSequenceNumber: currentMessageCount,
          contextSnapshot: { totalTokens: 0, fileCount: 0 },
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }

      // Reset form and refresh list
      setNewName('');
      setNewDescription('');
      setShowSaveForm(false);
      await fetchCheckpoints();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save checkpoint');
    } finally {
      setIsSaving(false);
    }
  }, [sessionId, newName, newDescription, currentMessageCount, fetchCheckpoints]);

  // ──────────────────────────────────────────────────────────────────────────
  // Delete checkpoint
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Deletes a checkpoint by ID after user confirmation.
   *
   * @param checkpoint - The checkpoint to delete
   */
  const handleDelete = useCallback(
    async (checkpoint: SessionCheckpoint) => {
      if (!confirm(`Delete checkpoint "${checkpoint.name}"?`)) return;

      setDeletingId(checkpoint.id);
      try {
        const res = await fetch(
          `/api/v1/sessions/${sessionId}/checkpoints?checkpointId=${checkpoint.id}`,
          { method: 'DELETE' }
        );

        if (!res.ok) {
          const body = await res.json().catch(() => ({})) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }

        setCheckpoints((prev) => prev.filter((c) => c.id !== checkpoint.id));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete checkpoint');
      } finally {
        setDeletingId(null);
      }
    },
    [sessionId]
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Restore (navigate to checkpoint position)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * "Restores" a checkpoint by navigating to the session URL with a checkpoint
   * query param. The session view uses this param to filter the message thread
   * to the checkpoint position.
   *
   * WHY: True in-session rollback requires agent-side IPC which is a future
   * feature. For now, "restore" shows the session timeline up to that message
   * so the user can review context and re-start from there.
   *
   * @param checkpoint - The checkpoint to restore to
   */
  const handleRestore = useCallback(
    (checkpoint: SessionCheckpoint) => {
      setRestoringId(checkpoint.id);
      const url = new URL(window.location.href);
      url.searchParams.set('checkpoint', checkpoint.id);
      window.history.pushState({}, '', url.toString());
      // Trigger a page-level event so SessionView can filter messages
      window.dispatchEvent(
        new CustomEvent('styrby:checkpoint-restore', {
          detail: {
            checkpointId: checkpoint.id,
            messageSequenceNumber: checkpoint.messageSequenceNumber,
          },
        })
      );
      setTimeout(() => setRestoringId(null), 800);
    },
    []
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Render
  // ──────────────────────────────────────────────────────────────────────────

  return (
    <section aria-label="Session checkpoints" className="flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-400">
          Checkpoints
        </h3>
        <button
          type="button"
          onClick={() => {
            setShowSaveForm((v) => !v);
            setSaveError(null);
          }}
          className="rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-700 transition-colors"
          aria-label="Save new checkpoint"
        >
          + Save
        </button>
      </div>

      {/* Save form (inline) */}
      {showSaveForm && (
        <div className="rounded-xl border border-zinc-700 bg-zinc-900 p-3 flex flex-col gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => {
              setNewName(e.target.value);
              setSaveError(null);
            }}
            placeholder="Checkpoint name (e.g. before-refactor)"
            maxLength={80}
            className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 border border-zinc-700 focus:border-zinc-500 focus:outline-none"
            aria-label="Checkpoint name"
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSave();
              if (e.key === 'Escape') setShowSaveForm(false);
            }}
            autoFocus
          />
          <input
            type="text"
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
            placeholder="Optional description"
            className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 border border-zinc-700 focus:border-zinc-500 focus:outline-none"
            aria-label="Checkpoint description"
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSave();
              if (e.key === 'Escape') setShowSaveForm(false);
            }}
          />

          {saveError && (
            <p className="text-xs text-red-400">{saveError}</p>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving || !newName.trim()}
              className="flex-1 rounded-lg bg-orange-500 px-3 py-2 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-50 transition-colors"
              aria-label={isSaving ? 'Saving checkpoint...' : 'Save checkpoint'}
            >
              {isSaving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowSaveForm(false);
                setSaveError(null);
              }}
              className="rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-400 hover:bg-zinc-700 transition-colors"
              aria-label="Cancel"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Loading state */}
      {isLoading && (
        <p className="text-xs text-zinc-500 py-2">Loading checkpoints…</p>
      )}

      {/* Error state */}
      {error && !isLoading && (
        <p className="text-xs text-red-400">{error}</p>
      )}

      {/* Empty state */}
      {!isLoading && !error && checkpoints.length === 0 && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 text-center">
          <p className="text-xs text-zinc-500">No checkpoints yet.</p>
          <p className="text-xs text-zinc-400 mt-1">
            Save a checkpoint to mark a position in this session.
          </p>
        </div>
      )}

      {/* Checkpoint list */}
      {!isLoading && checkpoints.length > 0 && (
        <ul className="flex flex-col gap-2" role="list" aria-label="Checkpoint list">
          {checkpoints.map((cp) => (
            <li
              key={cp.id}
              className="group rounded-xl border border-zinc-800 bg-zinc-900/50 p-3 hover:border-zinc-700 transition-colors"
            >
              {/* Name + timestamp */}
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <p
                    className="text-sm font-medium text-zinc-100 truncate"
                    title={cp.name}
                  >
                    {cp.name}
                  </p>
                  {cp.description && (
                    <p
                      className="text-xs text-zinc-500 mt-0.5 line-clamp-2"
                      title={cp.description}
                    >
                      {cp.description}
                    </p>
                  )}
                </div>

                {/* Action buttons (appear on group hover) */}
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  {/* Restore button */}
                  <button
                    type="button"
                    onClick={() => handleRestore(cp)}
                    disabled={restoringId === cp.id}
                    className="rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-700 hover:text-white disabled:opacity-50 transition-colors"
                    aria-label={`Restore to checkpoint "${cp.name}"`}
                    title="Restore to this checkpoint"
                  >
                    {restoringId === cp.id ? '…' : 'Restore'}
                  </button>

                  {/* Delete button */}
                  <button
                    type="button"
                    onClick={() => handleDelete(cp)}
                    disabled={deletingId === cp.id}
                    className="rounded-md bg-zinc-800 px-2 py-1 text-xs text-red-400 hover:bg-red-900/30 hover:text-red-300 disabled:opacity-50 transition-colors"
                    aria-label={`Delete checkpoint "${cp.name}"`}
                    title="Delete checkpoint"
                  >
                    {deletingId === cp.id ? '…' : 'Delete'}
                  </button>
                </div>
              </div>

              {/* Metadata row */}
              <div className="mt-2 flex items-center gap-3 text-xs text-zinc-400">
                <span>Msg {cp.messageSequenceNumber}</span>
                {cp.contextSnapshot.totalTokens > 0 && (
                  <span>{cp.contextSnapshot.totalTokens.toLocaleString()} tokens</span>
                )}
                <span className="ml-auto">{formatCheckpointTime(cp.createdAt)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Info note for active sessions */}
      {isSessionActive && checkpoints.length > 0 && (
        <p className="text-xs text-zinc-400">
          Checkpoints update live. Restore navigates the session view to that message.
        </p>
      )}
    </section>
  );
}

export default SessionCheckpoints;
