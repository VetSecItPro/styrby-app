/**
 * Offline Queue UI — barrel export.
 *
 * WHY: Per CLAUDE.md "Component-First Architecture", every component
 * directory exposes a single barrel so orchestrators import a flat
 * surface area instead of reaching into individual files.
 *
 * Exports:
 * - QuarantinePanel — failed message review UI (self-hides when queue is clean)
 * - useQuarantine — hook for loading quarantine state and actions
 * - Types re-exported from src/types/offline-queue
 */

export { QuarantinePanel } from './QuarantinePanel';
export type { QuarantinePanelProps } from './QuarantinePanel';

export { useQuarantine } from './useQuarantine';

export type {
  QuarantinedMessage,
  UseQuarantineReturn,
  MessageOrderingKey,
  NormalizedOrderingResult,
} from '../../types/offline-queue';
