'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { SettingsLinkRow } from './settings-link-row';

/**
 * WHY SupportModal is dynamic: The support modal (350 LOC) is only shown when
 * the user clicks "New Ticket". Eager-loading it adds ~15 kB gzipped to the
 * settings page chunk without benefit for users who never open a ticket.
 * Dynamic import fetches the modal bundle on first open, invisible to the user
 * because modal dialogs have inherent open/close latency that masks chunk load time.
 */
const SupportModal = dynamic(
  () =>
    import('@/components/dashboard/support-modal').then((mod) => ({
      default: mod.SupportModal,
    })),
  { ssr: false }
);

/**
 * WHY FeedbackDialog is dynamic: Same reasoning as SupportModal — the feedback
 * dialog (342 LOC) is shown only on user action. Dynamic import keeps it out
 * of the initial settings bundle.
 */
const FeedbackDialog = dynamic(
  () =>
    import('@/components/dashboard/feedback-dialog').then((mod) => ({
      default: mod.FeedbackDialog,
    })),
  { ssr: false }
);

/**
 * Support section: view tickets (links to /dashboard/support), new ticket
 * modal, and general feedback dialog.
 *
 * WHY two modals in one section: Support tickets and feedback are intentionally
 * distinct funnels. Tickets require tracking + resolution; feedback is
 * lightweight "share a thought" input. Both live here because both surface
 * from the same "Support" card.
 */
export function SettingsSupport() {
  const [showSupportModal, setShowSupportModal] = useState(false);
  const [showFeedbackDialog, setShowFeedbackDialog] = useState(false);

  return (
    <>
      <section className="mb-8">
        <h2 className="text-lg font-semibold text-zinc-100 mb-4">Support</h2>
        <div className="rounded-xl bg-zinc-900 border border-zinc-800 divide-y divide-zinc-800">
          <SettingsLinkRow
            href="/dashboard/support"
            label="View Your Tickets"
            description="Check the status of your support requests"
          />
          <div className="px-4 py-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-zinc-100">Need Help?</p>
              <p className="text-sm text-zinc-500">
                Submit a bug report, feature request, or question
              </p>
            </div>
            <button
              onClick={() => setShowSupportModal(true)}
              className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-600 transition-colors"
              aria-label="Submit a new support ticket"
            >
              New Ticket
            </button>
          </div>
          {/* WHY: In-app feedback is distinct from support tickets. Feedback is
              for quick thoughts, feature ideas, and general sentiment, while
              support tickets are for issues that need tracking and resolution.
              Mirrors the mobile app's feedback modal in settings. */}
          <div className="px-4 py-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-zinc-100">Send Feedback</p>
              <p className="text-sm text-zinc-500">
                Share ideas, report bugs, or tell us what you think
              </p>
            </div>
            <button
              onClick={() => setShowFeedbackDialog(true)}
              className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 transition-colors"
              aria-label="Send feedback"
            >
              Feedback
            </button>
          </div>
        </div>
      </section>

      <SupportModal open={showSupportModal} onOpenChange={setShowSupportModal} />
      <FeedbackDialog open={showFeedbackDialog} onOpenChange={setShowFeedbackDialog} />
    </>
  );
}
