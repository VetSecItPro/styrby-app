'use client';

/**
 * Support Ticket Submission Modal
 *
 * Allows users to submit bug reports, feature requests, and general questions.
 * Renders as a centered dialog on desktop and a bottom sheet on mobile via
 * the ResponsiveDialog component.
 *
 * @example
 * <SupportModal open={showSupport} onOpenChange={setShowSupport} />
 */

import { useState, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
} from '@/components/ui/responsive-dialog';

/* ──────────────────────────── Types ──────────────────────────── */

/** Ticket type options for the submission form */
type TicketType = 'bug' | 'feature' | 'question';

/** Priority levels available for bug reports */
type TicketPriority = 'low' | 'medium' | 'high';

interface SupportModalProps {
  /** Whether the modal is currently visible */
  open: boolean;
  /** Callback when the modal open state changes */
  onOpenChange: (open: boolean) => void;
}

/* ──────────────────────────── Constants ──────────────────────── */

const TYPE_OPTIONS: { value: TicketType; label: string }[] = [
  { value: 'bug', label: 'Bug Report' },
  { value: 'feature', label: 'Feature Request' },
  { value: 'question', label: 'General Question' },
];

const PRIORITY_OPTIONS: { value: TicketPriority; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

/* ──────────────────────────── Component ──────────────────────── */

/**
 * Modal form for submitting support tickets.
 * Inserts directly into the support_tickets table via the Supabase client
 * (RLS ensures the user can only create tickets for themselves).
 *
 * @param props.open - Controls visibility
 * @param props.onOpenChange - Called when the user closes the modal
 */
export function SupportModal({ open, onOpenChange }: SupportModalProps) {
  const supabase = createClient();

  /* ── Form state ────────────────────────────────────────────── */
  const [type, setType] = useState<TicketType>('bug');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TicketPriority>('medium');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  /**
   * Resets all form fields to their default state.
   * Called after successful submission or when closing the modal.
   */
  const resetForm = useCallback(() => {
    setType('bug');
    setSubject('');
    setDescription('');
    setPriority('medium');
    setError(null);
    setSuccess(false);
  }, []);

  /**
   * Validates form fields and inserts the ticket into support_tickets.
   * RLS ensures the user_id matches the authenticated user.
   */
  const handleSubmit = useCallback(async () => {
    // Client-side validation
    if (subject.trim().length < 3) {
      setError('Subject must be at least 3 characters.');
      return;
    }
    if (subject.trim().length > 200) {
      setError('Subject must be 200 characters or fewer.');
      return;
    }
    if (description.trim().length < 10) {
      setError('Description must be at least 10 characters.');
      return;
    }
    if (description.trim().length > 5000) {
      setError('Description must be 5,000 characters or fewer.');
      return;
    }

    setSubmitting(true);
    setError(null);

    // Get the current user to set user_id
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      setError('You must be signed in to submit a ticket.');
      setSubmitting(false);
      return;
    }

    // TODO: File upload to Supabase Storage is a future enhancement.
    // For now, screenshot_urls is always an empty array.
    const { error: insertError } = await supabase
      .from('support_tickets')
      .insert({
        user_id: user.id,
        type,
        subject: subject.trim(),
        description: description.trim(),
        priority: type === 'bug' ? priority : 'medium',
        screenshot_urls: [],
      });

    if (insertError) {
      setError(insertError.message);
      setSubmitting(false);
      return;
    }

    setSuccess(true);
    setSubmitting(false);

    // Auto-close after showing success message
    setTimeout(() => {
      onOpenChange(false);
      resetForm();
    }, 2000);
  }, [supabase, type, subject, description, priority, onOpenChange, resetForm]);

  /**
   * Handles modal close: resets form state unless a submission is in progress.
   */
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen && !submitting) {
        resetForm();
      }
      onOpenChange(nextOpen);
    },
    [submitting, resetForm, onOpenChange]
  );

  return (
    <ResponsiveDialog open={open} onOpenChange={handleOpenChange}>
      <ResponsiveDialogContent className="border-zinc-800 bg-zinc-900 sm:max-w-lg">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle className="text-zinc-100">
            Submit a Support Ticket
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="text-zinc-400">
            Tell us what you need help with. We typically respond within 24 hours.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        {success ? (
          <div className="py-8 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-500/10">
              <svg
                className="h-6 w-6 text-green-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>
            <p className="text-sm font-medium text-zinc-100">Ticket submitted.</p>
            <p className="mt-1 text-sm text-zinc-400">
              We will respond to your email within 24 hours.
            </p>
          </div>
        ) : (
          <div className="space-y-4 px-1">
            {/* Type selector */}
            <div>
              <label
                htmlFor="ticket-type"
                className="mb-1 block text-sm font-medium text-zinc-300"
              >
                Type
              </label>
              <select
                id="ticket-type"
                value={type}
                onChange={(e) => setType(e.target.value as TicketType)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
              >
                {TYPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Subject */}
            <div>
              <label
                htmlFor="ticket-subject"
                className="mb-1 block text-sm font-medium text-zinc-300"
              >
                Subject
              </label>
              <input
                id="ticket-subject"
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Brief summary of your issue"
                maxLength={200}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
              <p className="mt-1 text-xs text-zinc-500">
                {subject.length}/200 characters
              </p>
            </div>

            {/* Description */}
            <div>
              <label
                htmlFor="ticket-description"
                className="mb-1 block text-sm font-medium text-zinc-300"
              >
                Description
              </label>
              <textarea
                id="ticket-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe your issue in detail. Include steps to reproduce for bugs."
                rows={5}
                maxLength={5000}
                className="w-full resize-none rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
              <p className="mt-1 text-xs text-zinc-500">
                {description.length}/5,000 characters
              </p>
            </div>

            {/* Priority (only for bug reports) */}
            {type === 'bug' && (
              <div>
                <label
                  htmlFor="ticket-priority"
                  className="mb-1 block text-sm font-medium text-zinc-300"
                >
                  Priority
                </label>
                <select
                  id="ticket-priority"
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as TicketPriority)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
                >
                  {PRIORITY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Screenshots placeholder */}
            <div>
              <label
                htmlFor="ticket-screenshots"
                className="mb-1 block text-sm font-medium text-zinc-300"
              >
                Screenshots (optional)
              </label>
              <input
                id="ticket-screenshots"
                type="file"
                accept="image/*"
                multiple
                disabled
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-500 file:mr-3 file:rounded file:border-0 file:bg-zinc-700 file:px-3 file:py-1 file:text-sm file:text-zinc-300 disabled:opacity-50"
              />
              {/* TODO: Implement file upload to Supabase Storage. Max 3 files, 5MB each. */}
              <p className="mt-1 text-xs text-zinc-500">
                File upload coming soon. Max 3 images, 5MB each.
              </p>
            </div>

            {/* Error message */}
            {error && (
              <p className="text-sm text-red-400" role="alert">
                {error}
              </p>
            )}
          </div>
        )}

        {!success && (
          <ResponsiveDialogFooter>
            <button
              type="button"
              onClick={() => handleOpenChange(false)}
              disabled={submitting}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-100 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting || !subject.trim() || !description.trim()}
              className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? 'Submitting...' : 'Submit Ticket'}
            </button>
          </ResponsiveDialogFooter>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
