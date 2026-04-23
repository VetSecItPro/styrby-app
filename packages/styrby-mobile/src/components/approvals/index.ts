/**
 * Approvals — Barrel Exports (Phase 2.4)
 *
 * Public surface of the `approvals` component group. Consumed by:
 *   - Approvals tab screen (list of pending requests)
 *   - Push notification deep-link handler (single approval detail)
 *
 * WHY `useApprovalActions` is re-exported from this barrel:
 *   It is tightly coupled to `ApprovalRequestCard` and only used in these
 *   two screens. Collocating keeps the API discoverable without adding noise
 *   to the global hooks barrel.
 *
 * @module components/approvals
 */

export { ApprovalRequestCard } from './ApprovalRequestCard';
export type {
  ApprovalRequest,
  ApprovalRequestCardProps,
  ApprovalRequestCardCallbacks,
  RiskLevel,
} from './ApprovalRequestCard';

export { useApprovalActions } from './useApprovalActions';
export type {
  UseApprovalActionsInput,
  UseApprovalActionsResult,
} from './useApprovalActions';
