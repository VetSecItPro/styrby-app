/**
 * session-groups components — barrel exports.
 *
 * WHY: Component-first architecture (CLAUDE.md). The directory exposes a
 * single barrel so orchestrators import a flat surface area without
 * reaching into individual file paths.
 */

export { SessionGroupStrip } from './SessionGroupStrip';
export type { SessionGroupStripProps } from './SessionGroupStrip';
export { AgentSessionCard } from './AgentSessionCard';
export type { AgentSessionCardProps } from './AgentSessionCard';
