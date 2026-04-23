/**
 * InviteMemberModal Component
 *
 * Modal form for sending a new team invitation. Accepts an email address and
 * role, then POSTs to /api/invitations/send (which proxies to the edge function).
 *
 * Handles 402 seat cap responses with an upgrade CTA per the spec.
 * No em-dashes in UI copy. No sparkle icons.
 *
 * @module InviteMemberModal
 */

'use client';

import { useState } from 'react';
import { Mail, X } from 'lucide-react';
import { z } from 'zod';

// ============================================================================
// Types
// ============================================================================

/** Props for InviteMemberModal */
interface InviteMemberModalProps {
  /** Whether the modal is visible */
  isOpen: boolean;
  /** Team UUID - sent to /api/invitations/send */
  teamId: string;
  /** Called when the modal should close (cancel or success) */
  onClose: () => void;
  /** Called after a successful invite send (refresh caller's data) */
  onSuccess: () => void;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Zod schema for the invite form.
 *
 * WHY client-side validation: Immediate feedback is better UX. The API route
 * also validates, but client-side catches obvious errors before a network call.
 */
const InviteFormSchema = z.object({
  email: z.string().email('Please enter a valid email address').trim().toLowerCase(),
  role: z.enum(['admin', 'member', 'viewer']),
});

// ============================================================================
// Component
// ============================================================================

/**
 * Modal form for inviting a new team member.
 *
 * When the 402 seat cap response is received, renders an upgrade CTA using
 * the `upgradeCta` URL from the response body. Copy: "Your team has hit its
 * seat limit. Add a seat to send this invite."
 *
 * @param props - InviteMemberModalProps
 */
export function InviteMemberModal({ isOpen, teamId, onClose, onSuccess }: InviteMemberModalProps) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member' | 'viewer'>('member');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [upgradeCta, setUpgradeCta] = useState<string | null>(null);

  if (!isOpen) return null;

  /**
   * Resets form state to initial values.
   * Called on close or successful submission.
   */
  function resetForm() {
    setEmail('');
    setRole('member');
    setError(null);
    setUpgradeCta(null);
    setIsSubmitting(false);
  }

  /**
   * Handles cancel button click. Resets and closes.
   */
  function handleCancel() {
    resetForm();
    onClose();
  }

  /**
   * Submits the invite form.
   *
   * Flow:
   *   1. Client-side Zod validation
   *   2. POST to /api/invitations/send
   *   3. Handle 200 (success), 402 (seat cap), other 4xx/5xx (error)
   */
  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setUpgradeCta(null);

    // Client-side validation
    const parsed = InviteFormSchema.safeParse({ email, role });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid input');
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch('/api/invitations/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ team_id: teamId, email: parsed.data.email, role: parsed.data.role }),
      });

      const data = await response.json();

      if (response.status === 402) {
        // WHY special-case 402: spec requires showing the upgrade CTA from
        // the response body when the seat cap is hit.
        setUpgradeCta(data.upgradeCta ?? '/billing');
        setError(null);
        setIsSubmitting(false);
        return;
      }

      if (!response.ok) {
        setError(
          data?.message ?? data?.error ?? 'Failed to send invitation. Please try again.',
        );
        setIsSubmitting(false);
        return;
      }

      // Success
      resetForm();
      onSuccess();
      onClose();
    } catch (err) {
      console.error('[InviteMemberModal] Submit error:', err);
      setError('An unexpected error occurred. Please try again.');
      setIsSubmitting(false);
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 z-40"
        onClick={handleCancel}
        aria-hidden="true"
      />

      {/* Modal */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="invite-modal-title"
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
      >
        <div className="relative w-full max-w-md bg-zinc-900 rounded-2xl p-6 shadow-xl border border-zinc-800">
          {/* Close button */}
          <button
            onClick={handleCancel}
            aria-label="Close modal"
            className="absolute top-4 right-4 text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>

          {/* Header */}
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-lg bg-orange-500/10 flex items-center justify-center">
              <Mail className="w-5 h-5 text-orange-500" aria-hidden="true" />
            </div>
            <div>
              <h2 id="invite-modal-title" className="text-lg font-semibold text-zinc-100">
                Invite Team Member
              </h2>
              <p className="text-sm text-zinc-400">Send an invitation by email</p>
            </div>
          </div>

          {/* Seat cap CTA (shown when 402 received) */}
          {upgradeCta && (
            <div className="mb-4 p-4 rounded-xl bg-orange-500/10 border border-orange-500/20">
              <p className="text-sm text-orange-300 mb-3">
                Your team has hit its seat limit. Add a seat to send this invite.
              </p>
              <a
                href={upgradeCta}
                className="inline-block text-sm font-medium text-white bg-orange-500 hover:bg-orange-600 px-4 py-2 rounded-lg transition-colors"
              >
                Add a seat
              </a>
            </div>
          )}

          {/* Error message */}
          {error && !upgradeCta && (
            <div role="alert" className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-400">
              {error}
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Email field */}
            <div>
              <label
                htmlFor="invite-email"
                className="block text-sm font-medium text-zinc-300 mb-1.5"
              >
                Email address
              </label>
              <input
                id="invite-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="colleague@company.com"
                required
                autoComplete="email"
                className="w-full px-3 py-2.5 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-orange-500/50 focus:border-orange-500 transition-colors"
              />
            </div>

            {/* Role select */}
            <div>
              <label
                htmlFor="invite-role"
                className="block text-sm font-medium text-zinc-300 mb-1.5"
              >
                Role
              </label>
              <select
                id="invite-role"
                value={role}
                onChange={(e) => setRole(e.target.value as typeof role)}
                className="w-full px-3 py-2.5 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 focus:outline-none focus:ring-2 focus:ring-orange-500/50 focus:border-orange-500 transition-colors"
              >
                <option value="member">Member - can view and use team features</option>
                <option value="admin">Admin - can invite members and manage settings</option>
                <option value="viewer">Viewer - read-only access to shared sessions</option>
              </select>
            </div>

            {/* Actions */}
            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={handleCancel}
                disabled={isSubmitting}
                className="flex-1 px-4 py-2.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-300 font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting || !email}
                className="flex-1 px-4 py-2.5 rounded-lg bg-orange-500 hover:bg-orange-600 disabled:bg-orange-500/50 disabled:cursor-not-allowed text-white font-medium transition-colors flex items-center justify-center gap-2"
              >
                {isSubmitting ? (
                  <>
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Sending...
                  </>
                ) : (
                  'Send Invite'
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}
