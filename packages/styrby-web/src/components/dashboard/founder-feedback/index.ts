/**
 * Founder feedback dashboard components barrel export.
 *
 * WHY: Per CLAUDE.md "Component-First Architecture", every component
 * directory exposes a single barrel so orchestrator pages import a flat
 * surface area rather than reaching into individual files.
 *
 * @module components/dashboard/founder-feedback
 */

export { NpsDial } from './NpsDial';
export { NpsTrendChart } from './NpsTrendChart';
export { NpsSegmentBar } from './NpsSegmentBar';
export { NpsTab } from './NpsTab';
export { GeneralTab } from './GeneralTab';
export { PostmortemTab } from './PostmortemTab';
