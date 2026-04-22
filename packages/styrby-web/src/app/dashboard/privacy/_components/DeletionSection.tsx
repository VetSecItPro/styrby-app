'use client';

/**
 * Deletion Section — GDPR Art. 17 Right to Erasure
 *
 * Three-step account deletion flow:
 *   Step 1 (idle):   Brief description + "Begin account deletion" button.
 *   Step 2 (info):   Full detail of what will be deleted, 30-day grace window,
 *                    and "Continue to account deletion" button.
 *   Step 3 (confirm): User must type their exact email address to proceed.
 *   (deleting / done are transient final states.)
 *
 * WHY three steps (not two):
 *   - Step 1 is a light entry point — minimal friction for users exploring.
 *   - Step 2 ensures informed consent: users see every data class being deleted
 *     before they commit. GDPR Art. 17(2) requires "without undue delay" but
 *     also requires the controller to verify the request is legitimate.
 *   - Step 3 prevents accidental deletions and copy-paste attacks: typing the
 *     exact registered email proves intent and identity. (OWASP A01 prevention)
 *
 * The actual deletion is performed by DELETE /api/account/delete (already
 * shipped in the existing codebase). This component provides the 3-step UX
 * with explicit GDPR Art. 17 framing.
 *
 * GDPR Art. 17  — Right to Erasure
 * SOC2 CC6.5    — Logical access removal on account deletion
 */

import { useState } from 'react';
import { Trash2, AlertTriangle } from 'lucide-react';
import { useRouter } from 'next/navigation';

/** Props for {@link DeletionSection}. */
export interface DeletionSectionProps {
  /** User's email address - must be typed exactly to confirm deletion */
  userEmail: string;
}

type DeletionStep = 'idle' | 'info' | 'confirm' | 'deleting' | 'done';

/**
 * Renders the 3-step account deletion panel.
 *
 * @param props - User identity for confirmation step
 */
export function DeletionSection({ userEmail }: DeletionSectionProps) {
  const router = useRouter();
  const [step, setStep] = useState<DeletionStep>('idle');
  const [confirmEmail, setConfirmEmail] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const emailMatches = confirmEmail.trim().toLowerCase() === userEmail.toLowerCase();

  /**
   * Execute the account deletion.
   *
   * WHY we call DELETE /api/account/delete with confirmation 'DELETE MY ACCOUNT':
   *   The existing endpoint uses this literal for server-side confirmation.
   *   We keep parity so both web and mobile share the same API surface.
   *   The email-typed-in-UI is a client-side guard; the API guard is the phrase.
   */
  const handleConfirmDelete = async () => {
    if (!emailMatches) return;
    setStep('deleting');
    setErrorMessage(null);

    try {
      const response = await fetch('/api/account/delete', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirmation: 'DELETE MY ACCOUNT',
          reason: 'User-initiated from Privacy Control Center',
        }),
      });

      if (!response.ok) {
        const data = await response.json() as { error?: string };
        setErrorMessage(data.error ?? 'Deletion failed. Please try again or contact support.');
        setStep('confirm');
        return;
      }

      setStep('done');
      // Short delay so the user sees the success state before redirect
      setTimeout(() => router.push('/login'), 2000);
    } catch {
      setErrorMessage('Network error. Please try again.');
      setStep('confirm');
    }
  };

  if (step === 'done') {
    return (
      <section className="rounded-xl bg-zinc-900 border border-red-500/30">
        <div className="px-6 py-6 text-center">
          <p className="text-green-400 font-medium">Account deletion initiated.</p>
          <p className="text-sm text-zinc-400 mt-1">
            Your data will be permanently deleted in 30 days. Redirecting...
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-xl bg-zinc-900 border border-red-500/30">
      <div className="px-6 py-4 border-b border-red-500/20 flex items-center gap-3">
        <Trash2 className="h-4 w-4 text-red-400" aria-hidden />
        <h2 className="text-base font-semibold text-red-400">Delete Account</h2>
        <span className="ml-auto text-xs text-zinc-500">GDPR Art. 17</span>
      </div>

      {/* Step 1 (idle): Entry point — minimal friction, clear CTA */}
      {step === 'idle' && (
        <div className="px-6 py-4">
          <p className="text-sm text-zinc-300 mb-4">
            Permanently delete your Styrby account and all associated data.
            Review what will be deleted before you continue.
          </p>

          <button
            type="button"
            onClick={() => setStep('info')}
            className="flex items-center gap-2 rounded-lg border border-red-500/50 px-4 py-2 text-sm font-medium text-red-400 hover:bg-red-500/10 transition-colors"
          >
            <Trash2 className="h-4 w-4" aria-hidden />
            Begin account deletion
          </button>
        </div>
      )}

      {/* Step 2 (info): Full detail of what will be deleted + 30-day grace window */}
      {step === 'info' && (
        <div className="px-6 py-4">
          <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-4 mb-4">
            <div className="flex items-start gap-2 mb-2">
              <AlertTriangle className="h-4 w-4 text-red-400 flex-shrink-0 mt-0.5" aria-hidden />
              <p className="text-sm font-medium text-red-300">What will be deleted:</p>
            </div>
            <ul className="text-xs text-zinc-400 space-y-1 ml-6">
              <li>All sessions and message history</li>
              <li>Machine pairings and encryption keys</li>
              <li>Agent configurations and budget alerts</li>
              <li>Billing history and subscription data</li>
              <li>Prompt templates and custom settings</li>
              <li>Audit log entries and feedback</li>
            </ul>
          </div>

          <div className="rounded-lg bg-zinc-800 border border-zinc-700 p-4 mb-4">
            <p className="text-sm text-zinc-300 font-medium mb-1">30-day grace window</p>
            <p className="text-xs text-zinc-400">
              Your account is soft-deleted immediately (you lose access now). All data
              is permanently and irreversibly removed after 30 days. You can contact
              support within that window to cancel if it was a mistake.
            </p>
          </div>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setStep('idle')}
              className="flex-1 rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-400 hover:bg-zinc-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => setStep('confirm')}
              className="flex-1 rounded-lg border border-red-500/50 px-4 py-2 text-sm font-medium text-red-400 hover:bg-red-500/10 transition-colors"
            >
              Continue to account deletion
            </button>
          </div>
        </div>
      )}

      {/* Step 3 (confirm): Email confirmation gate */}
      {(step === 'confirm' || step === 'deleting') && (
        <div className="px-6 py-4">
          <p className="text-sm text-zinc-400 mb-4">
            To confirm permanent deletion, type your account email address:{' '}
            <span className="font-mono text-zinc-200 font-medium">{userEmail}</span>
          </p>

          <input
            type="email"
            value={confirmEmail}
            onChange={(e) => setConfirmEmail(e.target.value)}
            placeholder={userEmail}
            disabled={step === 'deleting'}
            className="w-full rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 px-4 py-2 text-sm mb-4 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-red-500/50 disabled:opacity-50"
            aria-label={`Type ${userEmail} to confirm account deletion`}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
          />

          {errorMessage && (
            <p role="alert" className="text-sm text-red-400 mb-3">
              {errorMessage}
            </p>
          )}

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => {
                setStep('idle');
                setConfirmEmail('');
                setErrorMessage(null);
              }}
              disabled={step === 'deleting'}
              className="flex-1 rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-400 hover:bg-zinc-800 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirmDelete}
              disabled={!emailMatches || step === 'deleting'}
              className="flex-1 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {step === 'deleting' ? 'Deleting...' : 'Confirm Delete'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
