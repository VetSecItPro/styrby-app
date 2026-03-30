'use client';

import { useState, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';

/* ──────────────────────────── Types ──────────────────────────── */

/**
 * Feedback category values matching the `feedback_type` enum in the
 * `user_feedback` Supabase table.
 *
 * WHY: The mobile app only uses 'general' as the feedback_type because it
 * has a simpler single-field form. The web version adds a category selector
 * for better triage of incoming feedback by the support team.
 */
type FeedbackCategory = 'general' | 'bug' | 'feature';

/**
 * Props for the FeedbackDialog component.
 */
interface FeedbackDialogProps {
  /** Whether the dialog is currently visible */
  open: boolean;
  /** Callback to toggle dialog visibility */
  onOpenChange: (open: boolean) => void;
}

/* ──────────────────────────── Constants ──────────────────────────── */

/**
 * Maximum character length for feedback messages.
 *
 * WHY: Matches the mobile app's limit of 2000 characters. Long enough for
 * detailed bug reports, short enough to prevent abuse.
 */
const MAX_MESSAGE_LENGTH = 2000;

/**
 * Available feedback categories with display labels and descriptions.
 */
const FEEDBACK_CATEGORIES: Array<{
  value: FeedbackCategory;
  label: string;
  description: string;
}> = [
  {
    value: 'general',
    label: 'General Feedback',
    description: 'Thoughts, suggestions, or comments about Styrby',
  },
  {
    value: 'bug',
    label: 'Bug Report',
    description: 'Something is broken or not working as expected',
  },
  {
    value: 'feature',
    label: 'Feature Request',
    description: 'An idea for a new feature or improvement',
  },
];

/* ──────────────────────────── Component ──────────────────────────── */

/**
 * Feedback submission dialog for the web app.
 *
 * Allows users to submit feedback directly from the web dashboard,
 * inserting into the `user_feedback` table in Supabase. This is the
 * web equivalent of the mobile app's feedback modal in settings.
 *
 * WHY: User feedback is critical for a premium product. Making it
 * accessible with minimal friction (2 clicks from any page) ensures
 * we capture valuable input that drives product improvements.
 *
 * Schema: The `user_feedback` table requires `user_id`, `feedback_type`,
 * `message`, and `platform`. The `feedback_type` column uses an enum
 * (general | bug | feature). The `platform` field distinguishes web
 * feedback from mobile for analytics.
 *
 * @param props - Dialog visibility state and toggle callback
 * @returns Rendered feedback dialog overlay, or null when closed
 *
 * @example
 * <FeedbackDialog open={showFeedback} onOpenChange={setShowFeedback} />
 */
export function FeedbackDialog({ open, onOpenChange }: FeedbackDialogProps) {
  const [category, setCategory] = useState<FeedbackCategory>('general');
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  /**
   * Resets the form to its initial state.
   * Called after successful submission or when the dialog is closed.
   */
  const resetForm = useCallback(() => {
    setCategory('general');
    setMessage('');
    setEmail('');
    setSubmitResult(null);
  }, []);

  /**
   * Closes the dialog and resets the form state.
   */
  const handleClose = useCallback(() => {
    onOpenChange(false);
    // WHY: Delay reset so the closing animation completes before
    // form fields visibly clear.
    setTimeout(resetForm, 200);
  }, [onOpenChange, resetForm]);

  /**
   * Submits the feedback to the `user_feedback` table in Supabase.
   *
   * WHY: We insert directly via the Supabase client rather than going through
   * an API route because the user_feedback table has RLS policies that allow
   * authenticated users to insert their own feedback. This avoids an
   * unnecessary server round-trip.
   */
  const handleSubmit = useCallback(async () => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage) return;

    setIsSubmitting(true);
    setSubmitResult(null);

    try {
      const supabase = createClient();

      // Get the authenticated user's ID for the insert
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        setSubmitResult({
          type: 'error',
          text: 'You must be logged in to submit feedback.',
        });
        return;
      }

      // WHY: The `user_feedback` table schema uses `message` (not `feedback`),
      // `feedback_type` (NOT NULL enum), and `platform` to distinguish web from mobile.
      // The optional `email` field is stored in `metadata` JSONB for follow-up contact.
      const { error } = await supabase
        .from('user_feedback')
        .insert({
          user_id: user.id,
          feedback_type: category,
          message: trimmedMessage,
          platform: 'web',
          ...(email.trim() && {
            metadata: { contact_email: email.trim() },
          }),
        });

      if (error) {
        setSubmitResult({
          type: 'error',
          text: 'Failed to submit feedback. Please try again.',
        });
      } else {
        setSubmitResult({
          type: 'success',
          text: 'Thank you! Your feedback has been submitted.',
        });
        // Auto-close after a brief delay so the user sees the success message
        setTimeout(handleClose, 1500);
      }
    } catch {
      setSubmitResult({
        type: 'error',
        text: 'An unexpected error occurred. Please try again.',
      });
    } finally {
      setIsSubmitting(false);
    }
  }, [message, category, email, handleClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center md:justify-center bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="feedback-title"
    >
      {/* Backdrop click to close */}
      <div
        className="absolute inset-0"
        onClick={handleClose}
        aria-hidden="true"
      />

      {/* Dialog content */}
      <div className="relative w-full md:w-auto md:min-w-[28rem] max-w-lg max-h-[85vh] overflow-y-auto rounded-t-2xl md:rounded-2xl bg-zinc-900 border border-zinc-700 p-6 shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h3
            id="feedback-title"
            className="text-lg font-semibold text-zinc-100"
          >
            Send Feedback
          </h3>
          <button
            onClick={handleClose}
            className="text-zinc-500 hover:text-zinc-300 transition-colors"
            aria-label="Close feedback dialog"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <p className="text-sm text-zinc-400 mb-4">
          Your feedback helps us make Styrby better. We read every submission.
        </p>

        {/* Category selector */}
        <label
          htmlFor="feedback-category"
          className="block text-sm font-medium text-zinc-300 mb-2"
        >
          Category
        </label>
        <select
          id="feedback-category"
          value={category}
          onChange={(e) => setCategory(e.target.value as FeedbackCategory)}
          disabled={isSubmitting}
          className="w-full rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500 mb-1"
        >
          {FEEDBACK_CATEGORIES.map((cat) => (
            <option key={cat.value} value={cat.value}>
              {cat.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-zinc-500 mb-4">
          {FEEDBACK_CATEGORIES.find((c) => c.value === category)?.description}
        </p>

        {/* Message textarea */}
        <label
          htmlFor="feedback-message"
          className="block text-sm font-medium text-zinc-300 mb-2"
        >
          Message
        </label>
        {/* WHY no aria-label: The <label htmlFor="feedback-message"> above
            already provides the accessible name. Adding aria-label here would
            override the visible label in the accessibility tree, which is
            redundant and potentially confusing. */}
        <textarea
          id="feedback-message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Tell us what you think..."
          rows={5}
          maxLength={MAX_MESSAGE_LENGTH}
          disabled={isSubmitting}
          className="w-full rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500 resize-none mb-1"
        />
        <p className="text-xs text-zinc-500 text-right mb-4">
          {message.length}/{MAX_MESSAGE_LENGTH}
        </p>

        {/* Optional email for follow-up */}
        <label
          htmlFor="feedback-email"
          className="block text-sm font-medium text-zinc-300 mb-2"
        >
          Email for follow-up{' '}
          <span className="text-zinc-500 font-normal">(optional)</span>
        </label>
        {/* WHY no aria-label: The <label htmlFor="feedback-email"> above
            already provides the accessible name. Redundant aria-label removed. */}
        <input
          id="feedback-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="your@email.com"
          disabled={isSubmitting}
          className="w-full rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500 mb-4"
        />

        {/* Submit result message */}
        {submitResult && (
          <p
            className={`text-sm mb-4 ${
              submitResult.type === 'success'
                ? 'text-green-400'
                : 'text-red-400'
            }`}
            role="alert"
          >
            {submitResult.text}
          </p>
        )}

        {/* Action buttons */}
        <div className="flex justify-end gap-3">
          <button
            onClick={handleClose}
            disabled={isSubmitting}
            className="rounded-lg border border-zinc-600 px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={isSubmitting || message.trim().length === 0}
            className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            aria-label="Submit feedback"
          >
            {isSubmitting ? 'Submitting...' : 'Submit Feedback'}
          </button>
        </div>
      </div>
    </div>
  );
}
