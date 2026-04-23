'use client';

/**
 * NpsSurveyCard — Web NPS survey component.
 *
 * Used on /nps/[kind] page. Follows the same flow as the mobile NpsSurveySheet:
 *  1. 0-10 scale (tapping a score advances to step 2)
 *  2. Follow-up question (optional free text)
 *  3. Thank-you confirmation
 *
 * Uses the shared /api/feedback/submit endpoint.
 *
 * WHY a Card not a modal: On web, a full centered card on a dark background
 * is the correct pattern for a focused survey page. Modals are disruptive
 * on desktop where the browser chrome provides its own navigation.
 *
 * @module components/nps/NpsSurveyCard
 */

import * as React from 'react';
import { createClient } from '@/lib/supabase/client';

// ============================================================================
// Types
// ============================================================================

interface NpsSurveyCardProps {
  window: '7d' | '30d';
  promptId?: string;
}

type Step = 'score' | 'followup' | 'thankyou' | 'error';

// ============================================================================
// Helpers
// ============================================================================

function scoreLabel(score: number): string {
  if (score >= 9) return "What do you love most about Styrby?";
  if (score >= 7) return "What would make Styrby even better?";
  return "What's the #1 thing we could improve?";
}

function scoreBg(score: number): string {
  if (score <= 6) return 'bg-red-900/40 border-red-700/60 hover:border-red-500';
  if (score <= 8) return 'bg-yellow-900/40 border-yellow-700/60 hover:border-yellow-500';
  return 'bg-green-900/40 border-green-700/60 hover:border-green-500';
}

function scoreText(score: number): string {
  if (score <= 6) return 'text-red-300';
  if (score <= 8) return 'text-yellow-300';
  return 'text-green-300';
}

// ============================================================================
// Component
// ============================================================================

/**
 * Web NPS survey card. See module doc.
 *
 * @param props - NpsSurveyCardProps
 */
export function NpsSurveyCard({ window, promptId }: NpsSurveyCardProps) {
  const [step, setStep] = React.useState<Step>('score');
  const [selectedScore, setSelectedScore] = React.useState<number | null>(null);
  const [followup, setFollowup] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  const handleScoreClick = (score: number) => {
    setSelectedScore(score);
    setStep('followup');
  };

  const handleSubmit = async (skipFollowup = false) => {
    if (selectedScore === null) return;

    setSubmitting(true);
    setErrorMessage(null);

    try {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        // WHY: If user is not authenticated (e.g. clicked link on a new device),
        // show a friendly error rather than crashing.
        setStep('error');
        setErrorMessage('Please sign in to Styrby to submit your feedback.');
        return;
      }

      const body: Record<string, unknown> = {
        kind: 'nps',
        score: selectedScore,
        window,
        contextJson: { screen: `/nps/nps_${window}` },
      };
      if (promptId) body.promptId = promptId;
      if (!skipFollowup && followup.trim()) body.followup = followup.trim();

      const res = await fetch('/api/feedback/submit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }

      setStep('thankyou');
    } catch (err) {
      setStep('error');
      setErrorMessage(err instanceof Error ? err.message : 'Submission failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-8 shadow-xl">
      {/* Step: Score */}
      {step === 'score' && (
        <div>
          <h2 className="mb-2 text-center text-xl font-bold text-zinc-100">
            How likely are you to recommend Styrby?
          </h2>
          <p className="mb-8 text-center text-sm text-zinc-400">
            To a friend or colleague - 0 to 10
          </p>

          {/* Score grid */}
          <div className="mb-4 flex flex-wrap justify-center gap-2">
            {Array.from({ length: 11 }, (_, i) => (
              <button
                key={i}
                onClick={() => handleScoreClick(i)}
                className={`h-12 w-12 rounded-xl border text-sm font-semibold transition-all ${scoreBg(i)} ${scoreText(i)} focus:outline-none focus:ring-2 focus:ring-indigo-500`}
                aria-label={`Score ${i}`}
              >
                {i}
              </button>
            ))}
          </div>

          {/* Scale labels */}
          <div className="flex justify-between px-1 text-xs text-zinc-500">
            <span>Not likely</span>
            <span>Very likely</span>
          </div>
        </div>
      )}

      {/* Step: Follow-up */}
      {step === 'followup' && selectedScore !== null && (
        <div>
          <div className="mb-2 flex items-center justify-center">
            <span
              className={`rounded-lg px-3 py-1 text-lg font-bold ${scoreText(selectedScore)} ${scoreBg(selectedScore)} border`}
            >
              {selectedScore}
            </span>
          </div>
          <h2 className="mb-2 text-center text-lg font-bold text-zinc-100">
            {scoreLabel(selectedScore)}
          </h2>
          <p className="mb-5 text-center text-sm text-zinc-500">Optional</p>

          <textarea
            value={followup}
            onChange={(e) => setFollowup(e.target.value)}
            placeholder="Share your thoughts..."
            maxLength={2000}
            rows={4}
            className="mb-4 w-full resize-none rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-3 text-sm text-zinc-100 placeholder-zinc-500 focus:border-indigo-500 focus:outline-none"
            autoFocus
          />

          <div className="flex gap-3">
            <button
              onClick={() => handleSubmit(false)}
              disabled={submitting}
              className="flex-1 rounded-xl bg-indigo-600 py-3 text-sm font-semibold text-white transition-colors hover:bg-indigo-700 disabled:opacity-60"
            >
              {submitting ? 'Submitting...' : 'Submit'}
            </button>
            <button
              onClick={() => handleSubmit(true)}
              disabled={submitting}
              className="rounded-xl border border-zinc-700 px-5 py-3 text-sm text-zinc-400 transition-colors hover:text-zinc-200 disabled:opacity-60"
            >
              Skip
            </button>
          </div>
        </div>
      )}

      {/* Step: Thank you */}
      {step === 'thankyou' && (
        <div className="py-6 text-center">
          <p className="mb-3 text-4xl">🎉</p>
          <h2 className="mb-2 text-xl font-bold text-zinc-100">Thank you!</h2>
          <p className="text-sm text-zinc-400">
            Your feedback helps us make Styrby better.
          </p>
          <a
            href="/dashboard"
            className="mt-6 inline-block rounded-xl bg-indigo-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-indigo-700"
          >
            Back to dashboard
          </a>
        </div>
      )}

      {/* Step: Error */}
      {step === 'error' && (
        <div className="py-6 text-center">
          <p className="mb-3 text-4xl">😕</p>
          <h2 className="mb-2 text-lg font-bold text-zinc-100">Something went wrong</h2>
          <p className="mb-4 text-sm text-zinc-400">{errorMessage}</p>
          <button
            onClick={() => {
              setStep('score');
              setErrorMessage(null);
            }}
            className="rounded-xl border border-zinc-700 px-6 py-3 text-sm text-zinc-400 hover:text-zinc-200"
          >
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
