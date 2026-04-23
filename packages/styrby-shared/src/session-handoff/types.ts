/**
 * Session Handoff — Shared Types
 *
 * Type definitions shared across web, mobile, and CLI for the
 * cross-device session handoff feature.
 *
 * @module session-handoff/types
 */

// ============================================================================
// Device identity
// ============================================================================

/**
 * Surface kind for a registered device.
 * Used in the handoff banner to label the origin device ("on iPhone", "on Mac").
 */
export type DeviceKind = 'web' | 'mobile_ios' | 'mobile_android' | 'cli';

/**
 * A device registered in the `devices` table.
 */
export interface DeviceRecord {
  /** Stable UUID v7 generated on first launch and persisted client-side. */
  id: string;

  /** Supabase Auth user who owns this device. */
  userId: string;

  /** Surface kind for display labels. */
  kind: DeviceKind;

  /** ISO 8601 timestamp of the last time this device was seen. */
  lastSeenAt: string;
}

// ============================================================================
// Handoff API response
// ============================================================================

/**
 * Response from `GET /api/sessions/[id]/handoff`.
 *
 * `available: false` when no recent snapshot exists for a different device.
 * `available: true` when the user should be prompted to resume.
 */
export type HandoffResponse =
  | { available: false }
  | {
      available: true;
      /** Device ID that wrote the most recent snapshot. */
      lastDeviceId: string;
      /** Human-readable device kind label ('web' | 'mobile_ios' | etc.). */
      lastDeviceKind: DeviceKind;
      /** 0-based message index to scroll to on resume. */
      cursorPosition: number;
      /** Pixel scroll offset within the focused message. */
      scrollOffset: number;
      /** Unsent draft text to restore into the input box (null if none). */
      activeDraft: string | null;
      /** Age of the snapshot in milliseconds (for display: "2 min ago"). */
      ageMs: number;
    };
