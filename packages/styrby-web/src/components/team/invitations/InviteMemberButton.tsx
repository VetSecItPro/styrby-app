/**
 * InviteMemberButton Component
 *
 * Primary CTA button for the team invitations admin panel.
 * Opens the InviteMemberModal when clicked.
 *
 * @module InviteMemberButton
 */

'use client';

import { useState } from 'react';
import { Mail } from 'lucide-react';
import { InviteMemberModal } from './InviteMemberModal';

// ============================================================================
// Types
// ============================================================================

/** Props for InviteMemberButton */
interface InviteMemberButtonProps {
  /** Team UUID passed down to the modal */
  teamId: string;
  /** Called after a successful invitation send (parent should re-fetch data) */
  onSuccess: () => void;
}

// ============================================================================
// Component
// ============================================================================

/**
 * Button that opens the InviteMemberModal when clicked.
 *
 * WHY this is a separate component from the modal:
 *   Follows component-first architecture. The button is the trigger; the modal
 *   is the form. Separating them allows re-use of the modal from other surfaces
 *   (e.g., onboarding flow, member management page).
 *
 * @param props - InviteMemberButtonProps
 */
export function InviteMemberButton({ teamId, onSuccess }: InviteMemberButtonProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setIsModalOpen(true)}
        className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-orange-500 hover:bg-orange-600 text-white font-medium transition-colors"
      >
        <Mail className="w-4 h-4" aria-hidden="true" />
        Invite Member
      </button>

      <InviteMemberModal
        isOpen={isModalOpen}
        teamId={teamId}
        onClose={() => setIsModalOpen(false)}
        onSuccess={() => {
          setIsModalOpen(false);
          onSuccess();
        }}
      />
    </>
  );
}
