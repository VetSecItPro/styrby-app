'use client';

/**
 * Onboarding Sidebar Banner
 *
 * Persistent compact banner displayed at the bottom of the sidebar until
 * the user completes all onboarding steps. Expands on click to show the
 * full step checklist. When all steps are done, it calls the completion
 * API, shows a brief "all set" message, and removes itself.
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { CheckCircle2, Circle, ChevronUp, ChevronDown, Sparkles, X } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import type { OnboardingState } from '@/lib/onboarding';

interface OnboardingBannerProps {
  /** Full onboarding state including steps and completion counts */
  onboardingState: OnboardingState;
}

/**
 * Marks onboarding as complete by calling the server endpoint.
 * Fire-and-forget; errors are logged but do not block the UI.
 */
async function markOnboardingComplete(): Promise<void> {
  try {
    await fetch('/api/onboarding/complete', { method: 'POST' });
  } catch (err) {
    console.error('Failed to mark onboarding complete:', err);
  }
}

/**
 * Sidebar banner that tracks onboarding progress. Compact by default,
 * expandable to show the full checklist. Auto-completes and dismisses
 * when all steps are finished.
 *
 * @param onboardingState - Current onboarding progress
 */
export function OnboardingBanner({ onboardingState }: OnboardingBannerProps) {
  const { steps, completedCount, totalSteps } = onboardingState;
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [allDone, setAllDone] = useState(false);

  const progressPercent = totalSteps > 0 ? (completedCount / totalSteps) * 100 : 0;
  const allStepsComplete = completedCount === totalSteps;

  /**
   * When all steps are complete, mark onboarding done and show a brief
   * "all set" message before auto-dismissing after 2 seconds.
   */
  const handleCompletion = useCallback(() => {
    setAllDone(true);
    markOnboardingComplete();
    const timer = setTimeout(() => {
      setDismissed(true);
    }, 2000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (allStepsComplete && !allDone) {
      const cleanup = handleCompletion();
      return cleanup;
    }
  }, [allStepsComplete, allDone, handleCompletion]);

  if (dismissed) return null;

  // Brief completion message
  if (allDone) {
    return (
      <div className="mt-auto border-t border-border/40 pt-4">
        <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 p-3 text-center">
          <div className="flex items-center justify-center gap-2">
            <Sparkles className="h-4 w-4 text-emerald-500" />
            <span className="text-xs font-medium text-emerald-400">
              You&apos;re all set!
            </span>
          </div>
        </div>
      </div>
    );
  }

  // Compact view (default)
  if (!expanded) {
    return (
      <div className="mt-auto border-t border-border/40 pt-4">
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="w-full rounded-lg bg-amber-500/10 border border-amber-500/20 p-3 text-left transition-colors hover:bg-amber-500/15"
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-amber-500">
              Setup: {completedCount}/{totalSteps}
            </span>
            <ChevronUp className="h-3.5 w-3.5 text-amber-500" />
          </div>
          <Progress
            value={progressPercent}
            className="h-1 bg-zinc-800 [&>div]:bg-amber-500"
          />
        </button>
      </div>
    );
  }

  // Expanded view
  return (
    <div className="mt-auto border-t border-border/40 pt-4">
      <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 p-3">
        {/* Header */}
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-amber-500">
            Setup: {completedCount}/{totalSteps}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="rounded p-0.5 text-amber-500/70 transition-colors hover:text-amber-500"
              aria-label="Collapse onboarding banner"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setDismissed(true)}
              className="rounded p-0.5 text-amber-500/70 transition-colors hover:text-amber-500"
              aria-label="Dismiss onboarding banner"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Progress bar */}
        <Progress
          value={progressPercent}
          className="mb-3 h-1 bg-zinc-800 [&>div]:bg-amber-500"
        />

        {/* Step list */}
        <div className="space-y-1.5">
          {steps.map((step) => (
            <div key={step.id} className="flex items-center gap-2">
              {step.completed ? (
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
              ) : (
                <Circle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
              )}
              {step.completed ? (
                <span className="text-[11px] text-zinc-500 line-through">
                  {step.label}
                </span>
              ) : (
                <Link
                  href={step.href}
                  className="text-[11px] text-zinc-300 transition-colors hover:text-amber-500"
                >
                  {step.label}
                </Link>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
