/**
 * Replay components — barrel exports.
 *
 * WHY: Per CLAUDE.md Component-First Architecture, each component directory
 * exposes a barrel so consumers import from a flat surface area rather than
 * reaching into individual files.
 *
 * NOTE: ReplayViewer is intentionally NOT re-exported here because it is
 * used exclusively by the /replay/[token] Server Component page and
 * imports from @styrby/shared/session-replay. Barrel-exporting it would
 * pull scrub-engine regexes into the dashboard bundle unnecessarily.
 */

export { CreateReplayLinkModal } from './CreateReplayLinkModal';
export type { CreateReplayLinkModalProps } from './CreateReplayLinkModal';
