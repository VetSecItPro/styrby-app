/**
 * InvitationsClientActions
 *
 * Client Component wrapper for the invite CTA button and list action handlers.
 * Server Components cannot hold state or call browser APIs; this component
 * bridges the orchestrator page (Server) with the interactive UI.
 *
 * WHY separate from the page:
 *   The invitations page is a Server Component for fast initial load and
 *   server-side auth checks. Client-side state (modal open, loading per-row)
 *   lives here. This keeps the page under 400 lines and follows the
 *   orchestrator pattern from CLAUDE.md.
 *
 * @module InvitationsClientActions
 */

'use client';

import { useRouter } from 'next/navigation';
import { InviteMemberButton } from '@/components/team/invitations';

// ============================================================================
// Types
// ============================================================================

interface InvitationsClientActionsProps {
  /** Team UUID */
  teamId: string;
}

// ============================================================================
// Component
// ============================================================================

/**
 * Renders the Invite Member CTA and wires up re-fetch on success.
 *
 * WHY useRouter().refresh():
 *   After a successful invite, the server-side data (invitation list) is stale.
 *   Next.js App Router's router.refresh() re-fetches Server Component data
 *   without a full page reload - same as calling the server actions.
 *
 * @param props - InvitationsClientActionsProps
 */
export default function InvitationsClientActions({ teamId }: InvitationsClientActionsProps) {
  const router = useRouter();

  /**
   * Called after a successful invite or after re-send/revoke actions.
   * Refreshes the server data to reflect the updated invitation list.
   */
  function handleSuccess() {
    router.refresh();
  }

  return (
    <InviteMemberButton
      teamId={teamId}
      onSuccess={handleSuccess}
    />
  );
}
