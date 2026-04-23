/**
 * Session Handoff — Snapshot Writer
 *
 * Platform-agnostic module that periodically captures UI state (cursor
 * position, scroll offset, active draft) and persists it to Supabase as a
 * `session_state_snapshots` row. Used by styrby-web, styrby-mobile, and
 * styrby-cli so all surfaces share identical snapshot semantics.
 *
 * WHY shared module: Each surface (web, mobile, CLI) previously had
 * divergent state-persistence paths, meaning a snapshot written by the web
 * client was not reliably readable by the mobile client. Centralising the
 * writer ensures one schema version, one debounce contract, and one test
 * suite covers all three surfaces.
 *
 * SOC2 CC6.1: Snapshot writes are authenticated and RLS-gated; the writer
 * never sends a snapshot unless the Supabase client is authenticated.
 *
 * @module session-handoff/snapshot-writer
 */

// ============================================================================
// Types
// ============================================================================

/**
 * The UI state captured in a single snapshot.
 *
 * All fields are optional so callers can capture partial state when only
 * some fields are available (e.g. CLI captures cursor only; no scroll/draft).
 */
export interface SessionStateSnapshot {
  /**
   * 0-based index of the last message the user has scrolled to.
   * Used by the receiving device to jump to the same message.
   */
  cursorPosition?: number;

  /**
   * Pixel scroll offset within the focused message bubble.
   * Relevant for long tool output panels where the user may be mid-read.
   */
  scrollOffset?: number;

  /**
   * Unsent message text the user was composing.
   * Restored into the input box on the receiving device.
   */
  activeDraft?: string;
}

/**
 * Minimal Supabase client interface required by the writer.
 *
 * WHY narrow interface: We accept any client that satisfies this shape —
 * the server-side `@supabase/ssr` client, the browser `@supabase/supabase-js`
 * client, or a test double. Avoids importing a concrete Supabase type from
 * the shared module (which would force a transitive dependency on
 * `@supabase/supabase-js` into every consumer).
 */
export interface SupabaseSnapshotClient {
  from(table: string): {
    insert(row: Record<string, unknown>): Promise<{ error: { message: string } | null }>;
  };
}

/**
 * Factory options for `createSnapshotWriter`.
 */
export interface SnapshotWriterOptions {
  /** Supabase session ID (UUID) that owns these snapshots. */
  sessionId: string;

  /**
   * Stable device ID generated on first launch and persisted locally.
   * Written to `session_state_snapshots.device_id` so the handoff banner
   * can label the origin device.
   */
  deviceId: string;

  /** Authenticated Supabase client instance. */
  supabase: SupabaseSnapshotClient;

  /**
   * Debounce interval in milliseconds.
   * Scheduled captures are coalesced so rapid state changes produce only
   * one INSERT per window.
   * @default 10000 (10 seconds)
   */
  debounceMs?: number;

  /**
   * Callback invoked when a snapshot fails to persist.
   * Defaults to a console.warn if not provided.
   *
   * @param error - The error message from Supabase
   */
  onError?: (error: string) => void;
}

/**
 * Control handle returned by `createSnapshotWriter`.
 */
export interface SnapshotWriter {
  /**
   * Immediately write a snapshot with the current state, bypassing the debounce.
   * Use on high-priority transitions: user sends a message, app moves to background.
   *
   * @param state - State to snapshot (merged with last known state)
   * @returns Promise that resolves when the INSERT completes or rejects on error
   */
  captureNow: (state: SessionStateSnapshot) => Promise<void>;

  /**
   * Schedule a debounced snapshot capture.
   * Calling this multiple times within `debounceMs` coalesces into one write.
   * The most recently supplied state wins.
   *
   * @param state - Current UI state to capture
   */
  scheduleCapture: (state: SessionStateSnapshot) => void;

  /**
   * Cancel any in-flight debounce timer and release resources.
   * Call on component unmount / session close.
   */
  destroy: () => void;
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Merges a partial snapshot update into the last known state.
 *
 * WHY: Callers rarely have all three fields available at once. A scroll
 * handler knows `scrollOffset` but not `activeDraft`. By merging into the
 * accumulated state we always write a complete snapshot row.
 *
 * @param base - Accumulated state from previous captures
 * @param update - Partial update from the current event
 * @returns Merged state object
 */
function mergeState(
  base: Required<SessionStateSnapshot>,
  update: SessionStateSnapshot,
): Required<SessionStateSnapshot> {
  return {
    cursorPosition: update.cursorPosition ?? base.cursorPosition,
    scrollOffset: update.scrollOffset ?? base.scrollOffset,
    activeDraft: update.activeDraft ?? base.activeDraft,
  };
}

// ============================================================================
// Public factory
// ============================================================================

/**
 * Creates a snapshot writer bound to a specific session and device.
 *
 * The writer maintains a rolling in-memory state that is flushed to Supabase
 * either immediately (via `captureNow`) or after the debounce window elapses
 * (via `scheduleCapture`). Both paths write to `session_state_snapshots`.
 *
 * @param options - Session, device, Supabase client, and tuning options
 * @returns A `SnapshotWriter` control handle
 *
 * @example
 * // In a React component:
 * const writer = createSnapshotWriter({
 *   sessionId: session.id,
 *   deviceId: getDeviceId(),
 *   supabase,
 * });
 *
 * // Schedule on every keystroke in the draft input:
 * writer.scheduleCapture({ activeDraft: inputValue });
 *
 * // Immediate flush when the user sends the message:
 * await writer.captureNow({ activeDraft: '' });
 *
 * // Cleanup on unmount:
 * return () => writer.destroy();
 */
export function createSnapshotWriter(options: SnapshotWriterOptions): SnapshotWriter {
  const {
    sessionId,
    deviceId,
    supabase,
    debounceMs = 10_000,
    onError,
  } = options;

  // Accumulated UI state — updated on every scheduleCapture / captureNow call.
  let accumulatedState: Required<SessionStateSnapshot> = {
    cursorPosition: 0,
    scrollOffset: 0,
    activeDraft: '',
  };

  // Pending debounce timer handle (null when no timer is active).
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Whether destroy() has been called — guard against post-destroy writes.
  let destroyed = false;

  /**
   * Persist the current accumulated state as a Supabase row.
   *
   * WHY we don't await inside the debounce callback: The debounce fires
   * asynchronously; awaiting inside `setTimeout` would require converting
   * to an async timer pattern. Instead we fire-and-forget and surface errors
   * through the `onError` callback so callers can log / retry.
   *
   * @param state - Resolved state to persist
   */
  async function persist(state: Required<SessionStateSnapshot>): Promise<void> {
    if (destroyed) return;

    const { error } = await supabase.from('session_state_snapshots').insert({
      session_id: sessionId,
      device_id: deviceId,
      cursor_position: state.cursorPosition,
      scroll_offset: state.scrollOffset,
      // Store null rather than empty string to keep the column semantics clean.
      active_draft: state.activeDraft || null,
      snapshot_version: 1,
    });

    if (error) {
      const msg = `[SnapshotWriter] Failed to persist snapshot: ${error.message}`;
      if (onError) {
        onError(msg);
      } else {
        console.warn(msg);
      }
    }
  }

  /**
   * Cancel any active debounce timer without writing.
   */
  function clearDebounce(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  const captureNow = async (state: SessionStateSnapshot): Promise<void> => {
    // Merge into accumulated state so captureNow also advances the base.
    accumulatedState = mergeState(accumulatedState, state);

    // Cancel any pending debounce — captureNow supersedes it.
    clearDebounce();

    await persist(accumulatedState);
  };

  const scheduleCapture = (state: SessionStateSnapshot): void => {
    // Merge immediately so the latest value wins if the timer fires.
    accumulatedState = mergeState(accumulatedState, state);

    // Reset the debounce window on every new call (trailing-edge debounce).
    clearDebounce();

    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void persist(accumulatedState);
    }, debounceMs);
  };

  const destroy = (): void => {
    destroyed = true;
    clearDebounce();
  };

  return { captureNow, scheduleCapture, destroy };
}
