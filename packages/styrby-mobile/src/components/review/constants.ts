/**
 * Review Screen — Shared Constants
 *
 * Centralizes color tokens used across the review sub-components so the
 * dark-mode palette stays consistent if it later needs to be themed.
 *
 * WHY constants file: Multiple sub-components (header badge, action bar,
 * decision modal) repeat the same status color triplet. One source of truth
 * prevents drift if a brand color is ever rotated.
 *
 * @module components/review/constants
 */

import type { CodeReviewStatus } from '@/types/review';

/** Background color of the screen and modal scrim base. */
export const COLOR_BACKGROUND = '#09090b';
/** Card background — file rows, summary panels. */
export const COLOR_SURFACE = '#18181b';
/** Slightly lighter surface — header underlay, decision modal body. */
export const COLOR_SURFACE_ALT = '#0f0f11';
/** Default border color for cards. */
export const COLOR_BORDER = '#27272a';
/** Muted text and icon color. */
export const COLOR_MUTED = '#71717a';
/** Subtle text color used for placeholder copy. */
export const COLOR_PLACEHOLDER = '#52525b';
/** Brand accent — used for active comment buttons and loading spinner. */
export const COLOR_ACCENT = '#f97316';

/** Color used for the "+additions" count. */
export const COLOR_ADD = '#86efac';
/** Color used for the "-deletions" count. */
export const COLOR_DEL = '#fca5a5';

/** Status colors keyed by review decision. */
export const STATUS_COLOR: Record<Exclude<CodeReviewStatus, 'pending'>, string> = {
  approved: '#22c55e',
  rejected: '#ef4444',
  changes_requested: '#eab308',
};

/** Translucent backgrounds used for status badges and action-bar pills. */
export const STATUS_BG: Record<Exclude<CodeReviewStatus, 'pending'>, string> = {
  approved: 'rgba(34,197,94,0.15)',
  rejected: 'rgba(239,68,68,0.15)',
  changes_requested: 'rgba(234,179,8,0.15)',
};

/** Action bar button background tints (lower opacity than the badge bg). */
export const ACTION_BG: Record<Exclude<CodeReviewStatus, 'pending'>, string> = {
  approved: 'rgba(34,197,94,0.12)',
  rejected: 'rgba(239,68,68,0.12)',
  changes_requested: 'rgba(234,179,8,0.12)',
};

/** Action bar button border tints. */
export const ACTION_BORDER: Record<Exclude<CodeReviewStatus, 'pending'>, string> = {
  approved: 'rgba(34,197,94,0.3)',
  rejected: 'rgba(239,68,68,0.3)',
  changes_requested: 'rgba(234,179,8,0.3)',
};

/** Human-readable label for each non-pending decision. */
export const STATUS_LABEL: Record<Exclude<CodeReviewStatus, 'pending'>, string> = {
  approved: 'Approved',
  rejected: 'Rejected',
  changes_requested: 'Changes Requested',
};
