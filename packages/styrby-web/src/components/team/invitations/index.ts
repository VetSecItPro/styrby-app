/**
 * Barrel export for team/invitations components.
 *
 * WHY barrel exports:
 *   Import paths like "@/components/team/invitations" resolve to this index.
 *   Consumers don't need to know the internal file structure.
 *
 * @module team/invitations
 */

export { InvitationsList } from './InvitationsList';
export type { InvitationRow } from './InvitationsList';
export { InviteMemberButton } from './InviteMemberButton';
export { InviteMemberModal } from './InviteMemberModal';
export { SeatCapBanner } from './SeatCapBanner';
