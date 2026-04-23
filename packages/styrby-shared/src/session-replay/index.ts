/**
 * Session Replay — Public API
 *
 * Re-exports all public symbols from the session-replay sub-module.
 *
 * WHY NOT re-exported from the main barrel: The scrub engine contains regex
 * patterns that add weight. Consumers who only need types can import from
 * '@styrby/shared/session-replay' without pulling in the regex runtime.
 *
 * To use scrubbing: `import { scrubMessage, scrubSession } from '@styrby/shared/session-replay'`
 * To use types only: `import type { ScrubMask, ... } from '@styrby/shared/session-replay'`
 *
 * @module session-replay
 */

export { scrubMessage, scrubSession } from './scrub.js';
export type {
  ScrubMask,
  ReplayMessage,
  ScrubbedMessage,
} from './scrub.js';
export type {
  SessionReplayToken,
  ReplayTokenDuration,
  ReplayTokenMaxViews,
  CreateReplayTokenRequest,
  CreateReplayTokenResponse,
  ReplayViewerData,
  ReplaySessionMeta,
  PlaybackSpeed,
  PlaybackState,
} from './types.js';
