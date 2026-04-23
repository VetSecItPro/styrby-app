/**
 * Session Replay — Shared Types
 *
 * Type definitions shared across web, mobile, and CLI for the
 * privacy-preserving session replay feature (Phase 3.3).
 *
 * WHY shared: Both web and mobile render replay links and viewers.
 * Sharing types ensures the API contract is unambiguous and eliminates
 * "struct drift" where two surfaces evolve incompatible field names.
 *
 * @module session-replay/types
 */

import type { ScrubMask } from './scrub.js';

// ============================================================================
// Re-export scrub types so callers import from one place
// ============================================================================

export type { ScrubMask, ReplayMessage, ScrubbedMessage } from './scrub.js';

// ============================================================================
// Token record (mirrors session_replay_tokens table)
// ============================================================================

/**
 * A session replay token record as stored in `session_replay_tokens`.
 *
 * Callers who receive this from the API never see `token_hash` (it is
 * omitted from all public-facing responses). The raw token appears only
 * once — in the URL returned at creation time.
 */
export interface SessionReplayToken {
  /** UUID primary key. */
  id: string;

  /** UUID of the session this token grants replay access to. */
  sessionId: string;

  /** UUID of the profile that created this token. */
  createdBy: string;

  /** ISO 8601 timestamp after which the token is invalid. */
  expiresAt: string;

  /** Maximum number of allowed views (null = unlimited). */
  maxViews: number | null;

  /** Number of views consumed so far. */
  viewsUsed: number;

  /** Scrub mask applied server-side before delivering content to viewers. */
  scrubMask: ScrubMask;

  /** ISO 8601 timestamp when the creator revoked the token (null if active). */
  revokedAt: string | null;

  /** ISO 8601 timestamp when the token was created. */
  createdAt: string;
}

// ============================================================================
// API request / response types
// ============================================================================

/**
 * Token duration options shown in the create-link modal.
 */
export type ReplayTokenDuration = '1h' | '24h' | '7d' | '30d';

/**
 * Max-views options shown in the create-link modal.
 * 'unlimited' maps to null in the DB.
 */
export type ReplayTokenMaxViews = 1 | 5 | 10 | 'unlimited';

/**
 * Request body for POST /api/sessions/[id]/replay — creates a new token.
 */
export interface CreateReplayTokenRequest {
  /** How long the token should be valid. */
  duration: ReplayTokenDuration;

  /** Maximum number of views before the token burns. */
  maxViews: ReplayTokenMaxViews;

  /** Which categories of content to redact. */
  scrubMask: ScrubMask;
}

/**
 * Response body for POST /api/sessions/[id]/replay — successful creation.
 *
 * WHY return both token record and URL: The caller needs the URL to display
 * in the copy-link UI and the token record for the "active links" list.
 */
export interface CreateReplayTokenResponse {
  /** The created token record (without token_hash). */
  token: SessionReplayToken;

  /** Full replay URL including the raw token. Display to the user ONCE; do not store. */
  url: string;
}

/**
 * Response body for GET /replay/[token] — the viewer page data.
 */
export interface ReplayViewerData {
  /** Session metadata (id, agent_type, started_at, title, etc.). */
  session: ReplaySessionMeta;

  /** Scrubbed messages ready for rendering. */
  messages: import('./scrub.js').ScrubbedMessage[];

  /** The scrub mask that was applied (for the viewer UI to display a banner). */
  scrubMask: ScrubMask;

  /** ISO 8601 timestamp when this token expires. */
  expiresAt: string;

  /** Number of views remaining (null = unlimited). */
  viewsRemaining: number | null;
}

/**
 * Session metadata fields exposed to replay viewers.
 *
 * WHY not the full session row: We expose only the fields needed for
 * the viewer header and timeline. Sensitive fields like projectPath,
 * gitRemoteUrl, and tags are omitted unless the token creator explicitly
 * shares them (future enhancement).
 */
export interface ReplaySessionMeta {
  id: string;
  title: string | null;
  agentType: string;
  model: string | null;
  status: string;
  startedAt: string;
  endedAt: string | null;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  totalCostUsd: number | null;
}

/**
 * Playback speed options for the replay timeline scrubber.
 */
export type PlaybackSpeed = 1 | 2 | 4;

/**
 * Playback state managed by the replay viewer component.
 */
export interface PlaybackState {
  /** Whether playback is currently running. */
  isPlaying: boolean;

  /** Current message index being displayed. */
  currentIndex: number;

  /** Playback speed multiplier. */
  speed: PlaybackSpeed;

  /** Total number of messages in the session. */
  total: number;
}
