'use client';

/**
 * TierCapWarning — soft banner when month-to-date hits 80%+ of tier spend cap.
 *
 * Shows:
 *   "You've used 80% of your Power tier ($XX of $49).
 *    Upgrade to Team for unlimited and per-seat billing."
 *
 * WHY client component: snooze state is stored in localStorage to persist across
 * page refreshes without adding a DB column. The snooze expires after 24 hours.
 *
 * Logic:
 *   - Only show when pct >= 80
 *   - Snooze key: "tier_cap_warning_snoozed_until" in localStorage
 *   - Snooze duration: 24 hours
 *
 * @module components/costs/TierCapWarning
 */

import { useState, useEffect } from 'react';
import Link from 'next/link';
import type { TierId } from '@/lib/polar';

// ============================================================================
// Constants
// ============================================================================

/** Tier monthly caps in USD — mirrors TIERS config */
const TIER_MONTHLY_CAP_USD: Record<string, number> = {
  free: 0,      // Free tier has no per-dollar cap (agent limit instead)
  power: 49,    // Power plan at $49/mo
  team: 19,     // Team per-seat — shown as fleet total separately
  business: 39, // Business per-seat
};

/** Upgrade copy per tier */
const UPGRADE_COPY: Record<string, { cta: string; href: string }> = {
  free: { cta: 'Upgrade to Power for all agents and unlimited sessions', href: '/pricing' },
  power: { cta: 'Upgrade to Team for unlimited and per-seat billing', href: '/pricing' },
  team: { cta: 'Upgrade to Business for expanded enterprise controls', href: '/pricing' },
  business: { cta: 'Contact us for Enterprise pricing', href: '/pricing' },
};

const SNOOZE_KEY = 'tier_cap_warning_snoozed_until';
const SNOOZE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

// ============================================================================
// Types
// ============================================================================

/**
 * Props for {@link TierCapWarning}.
 */
export interface TierCapWarningProps {
  /** User's current subscription tier */
  tier: TierId;
  /** Month-to-date USD spend */
  monthToDateSpendUsd: number;
}

// ============================================================================
// Component
// ============================================================================

/**
 * Renders a soft dismissable banner when month-to-date spend reaches 80%
 * of the user's tier monthly cap.
 *
 * Snoozed for 24 hours via localStorage after dismiss.
 * Only renders on the client (localStorage dependency).
 *
 * @param props - Component props
 * @returns Banner element or null
 *
 * @example
 * <TierCapWarning tier="power" monthToDateSpendUsd={39.50} />
 */
export function TierCapWarning({ tier, monthToDateSpendUsd }: TierCapWarningProps) {
  const [visible, setVisible] = useState(false);

  const cap = TIER_MONTHLY_CAP_USD[tier] ?? 0;
  // Free tier has no dollar cap to warn about
  if (cap === 0) return null;

  const pct = Math.round((monthToDateSpendUsd / cap) * 100);

  useEffect(() => {
    // Only show when >= 80%
    if (pct < 80) {
      setVisible(false);
      return;
    }

    // Check snooze
    try {
      const snoozeUntil = localStorage.getItem(SNOOZE_KEY);
      if (snoozeUntil && Date.now() < Number(snoozeUntil)) {
        setVisible(false);
        return;
      }
    } catch {
      // localStorage unavailable (SSR, private mode) — show the banner
    }

    setVisible(true);
  }, [pct]);

  if (!visible) return null;

  const upgrade = UPGRADE_COPY[tier] ?? UPGRADE_COPY.power;

  function handleSnooze() {
    try {
      localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_DURATION_MS));
    } catch {
      // localStorage write failed — just hide in-memory
    }
    setVisible(false);
  }

  return (
    <div
      className="mb-4 flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3"
      role="alert"
      aria-label="Tier spend cap warning"
    >
      {/* Warning icon */}
      <svg
        className="h-4 w-4 shrink-0 mt-0.5 text-amber-400"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
        />
      </svg>

      {/* Message */}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-amber-200">
          You&apos;ve used{' '}
          <strong>{pct}%</strong> of your{' '}
          <span className="capitalize">{tier}</span> tier ($
          {monthToDateSpendUsd.toFixed(2)} of ${cap.toFixed(0)}).{' '}
          <Link
            href={upgrade.href}
            className="underline underline-offset-2 hover:text-amber-100 transition-colors"
          >
            {upgrade.cta}
          </Link>
          .
        </p>
      </div>

      {/* Snooze dismiss */}
      <button
        type="button"
        onClick={handleSnooze}
        className="shrink-0 text-amber-400/70 hover:text-amber-300 transition-colors"
        aria-label="Dismiss for 24 hours"
        title="Dismiss for 24 hours"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
