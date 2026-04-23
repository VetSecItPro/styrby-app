/**
 * Feedback module barrel export.
 *
 * WHY: Keeps the public API surface of the feedback module explicit.
 * Only exports that are safe for all environments (web, mobile, CLI)
 * are included here.
 *
 * @module feedback
 */

export {
  calcNPS,
  classifyNpsScore,
  groupNpsByWeek,
  toIsoWeek,
  formatNpsScore,
} from './nps.js';

export type { NpsResult, NpsSegment, NpsTrendPoint } from './nps.js';
