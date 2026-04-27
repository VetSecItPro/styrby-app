'use client';

/**
 * Welcome Onboarding Modal
 *
 * Shown on the user's first visit to the dashboard (when onboarding is
 * not yet complete). Displays a tier-specific welcome message and a
 * checklist of setup steps. Uses ResponsiveDialog to render as a
 * centered dialog on desktop and a bottom sheet on mobile.
 */

import Image from 'next/image';
import Link from 'next/link';
import { CheckCircle2, Circle } from 'lucide-react';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogFooter,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
} from '@/components/ui/responsive-dialog';
import { Progress } from '@/components/ui/progress';
import type { OnboardingState } from '@/lib/onboarding';

interface OnboardingModalProps {
  /** Full onboarding state including steps and completion counts */
  onboardingState: OnboardingState;
  /** Called when the user dismisses the modal */
  onDismiss: () => void;
}

/**
 * Returns a tier-specific welcome headline.
 *
 * @param tier - The user's subscription tier
 * @returns Welcome string like "Welcome to Pro"
 */
function getWelcomeTitle(tier: OnboardingState['tier']): string {
  switch (tier) {
    case 'pro':
      return 'Welcome to Pro';
    case 'growth':
      // WHY (Phase 5 rename): pre-rename `'power'` collapsed into Growth.
      return 'Welcome to Growth';
    default:
      return 'Welcome to Styrby';
  }
}

/**
 * Welcome modal shown once when a user first reaches the dashboard.
 * Renders a setup checklist based on their subscription tier.
 *
 * @param onboardingState - Current onboarding progress
 * @param onDismiss - Callback to close the modal
 */
export function OnboardingModal({ onboardingState, onDismiss }: OnboardingModalProps) {
  const { tier, steps, completedCount, totalSteps } = onboardingState;
  const progressPercent = totalSteps > 0 ? (completedCount / totalSteps) * 100 : 0;

  return (
    <ResponsiveDialog open onOpenChange={(open) => !open && onDismiss()}>
      <ResponsiveDialogContent className="sm:max-w-md border-border/40 bg-zinc-900">
        <ResponsiveDialogHeader className="items-center text-center">
          <div className="mx-auto mb-2">
            <Image
              src="/logo.png"
              alt="Styrby"
              width={48}
              height={48}
              className="rounded-xl"
            />
          </div>
          <ResponsiveDialogTitle className="text-xl font-semibold text-zinc-100">
            {getWelcomeTitle(tier)}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="text-sm text-zinc-400">
            Complete these steps to get the most out of your account.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        {/* Progress indicator */}
        <div className="px-1">
          <div className="flex items-center justify-between text-xs text-zinc-400 mb-1.5">
            <span>
              {completedCount} of {totalSteps} complete
            </span>
            <span>{Math.round(progressPercent)}%</span>
          </div>
          <Progress
            value={progressPercent}
            className="h-1.5 bg-zinc-800 [&>div]:bg-amber-500"
          />
        </div>

        {/* Step checklist */}
        <div className="space-y-1 py-2">
          {steps.map((step) => (
            <div
              key={step.id}
              className="flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-zinc-800/60"
            >
              {step.completed ? (
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" />
              ) : (
                <Circle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
              )}
              <div className="min-w-0 flex-1">
                {step.completed ? (
                  <span className="text-sm font-medium text-zinc-400 line-through">
                    {step.label}
                  </span>
                ) : (
                  <Link
                    href={step.href}
                    onClick={onDismiss}
                    className="text-sm font-medium text-zinc-100 hover:text-amber-500 transition-colors"
                  >
                    {step.label}
                  </Link>
                )}
                <p className="text-xs text-zinc-500 mt-0.5">{step.description}</p>
              </div>
            </div>
          ))}
        </div>

        <ResponsiveDialogFooter>
          <button
            type="button"
            onClick={onDismiss}
            className="w-full rounded-lg bg-amber-500 px-4 py-2.5 text-sm font-semibold text-zinc-900 transition-colors hover:bg-amber-400"
          >
            Get Started
          </button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
