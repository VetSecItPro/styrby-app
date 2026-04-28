'use client';

/**
 * AdminMfaBanner
 *
 * Displays a time-sensitive warning banner to admins who are within their
 * MFA enrollment grace period (mfa_grace_until from migration 065).
 *
 * Color urgency tiers:
 *   - ≤1 day remaining → red (critical, action required today)
 *   - ≤3 days remaining → amber (high urgency)
 *   - >3 days remaining → yellow (informational)
 *
 * WHY urgency tiers: admins who see the same yellow banner every day develop
 * banner blindness. Escalating color (red/amber) for shorter windows breaks
 * that pattern and drives enrollment before the grace period expires.
 *
 * WHY client component:
 *   The banner only needs the `graceUntil` prop (a string) which is fetched
 *   server-side in the admin layout and passed down. No server-side rendering
 *   is needed in this component itself. 'use client' is required for the
 *   link onClick / potential animations. The layout fetches the data; the
 *   banner only renders it.
 *
 * WHY NOT in layout.tsx directly:
 *   Separating the banner into a component keeps layout.tsx as an orchestrator
 *   (data fetching only) and pushes UI logic into a dedicated file.
 *   CLAUDE.md: Component-First Architecture.
 *
 * Security references:
 *   OWASP A07:2021 — Identification and Authentication Failures
 *   SOC 2 CC6.1 — Privileged access requires phishing-resistant MFA
 *
 * @param graceUntil - ISO 8601 timestamp string when the grace period expires,
 *   or null if no grace (admin enrolled before/after MFA requirement — no banner).
 */

import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';

// ============================================================================
// Props
// ============================================================================

interface AdminMfaBannerProps {
  /**
   * The admin's mfa_grace_until timestamp from site_admins.
   * null → admin has no grace window → banner is not shown.
   */
  graceUntil: string | null;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Computes whole days remaining until the grace period expires.
 *
 * WHY Math.ceil: a value of 0.2 days should show "1 day" — rounding down
 * to 0 would imply the grace has expired when it hasn't. Ceiling is the
 * correct user-facing rounding for "how much time do I have left?"
 *
 * @param graceUntil - ISO 8601 timestamp.
 * @returns Whole days remaining (may be 0 or negative if expired).
 */
function daysRemaining(graceUntil: string): number {
  const msRemaining = new Date(graceUntil).getTime() - Date.now();
  return Math.ceil(msRemaining / (1000 * 60 * 60 * 24));
}

// ============================================================================
// Component
// ============================================================================

/**
 * Renders an MFA enrollment reminder banner for admins in the grace period.
 *
 * Returns null when:
 *   - graceUntil is null (no grace window, admin already has MFA or
 *     was added after enforcement)
 *   - The grace period has already expired (days <= 0): at that point
 *     assertAdminMfa() blocks admin actions, so the banner is moot.
 */
export function AdminMfaBanner({ graceUntil }: AdminMfaBannerProps) {
  if (!graceUntil) return null;

  const days = daysRemaining(graceUntil);

  // Grace expired — assertAdminMfa blocks actions; banner is redundant.
  if (days <= 0) return null;

  // ── Urgency styling ────────────────────────────────────────────────────────
  // WHY three tiers: see component JSDoc for the banner-blindness rationale.
  let bannerClass: string;
  let textClass: string;
  let iconClass: string;

  if (days <= 1) {
    // Critical: red
    bannerClass = 'bg-red-50 border border-red-300';
    textClass = 'text-red-800';
    iconClass = 'text-red-500';
  } else if (days <= 3) {
    // High: amber
    bannerClass = 'bg-amber-50 border border-amber-300';
    textClass = 'text-amber-800';
    iconClass = 'text-amber-500';
  } else {
    // Informational: yellow
    bannerClass = 'bg-yellow-50 border border-yellow-200';
    textClass = 'text-yellow-800';
    iconClass = 'text-yellow-500';
  }

  const dayLabel = days === 1 ? 'day' : 'days';

  return (
    <div
      className={`flex items-start gap-3 rounded-md px-4 py-3 ${bannerClass}`}
      role="alert"
      aria-live="polite"
    >
      {/* WHY AlertTriangle: CLAUDE.md prohibits sparkle icons (Sparkles, ✨).
          AlertTriangle is the correct lucide-react icon for a security warning. */}
      <AlertTriangle className={`mt-0.5 h-5 w-5 flex-shrink-0 ${iconClass}`} aria-hidden="true" />

      <div className={`text-sm ${textClass}`}>
        <strong className="font-semibold">MFA enrollment required.</strong>{' '}
        You have{' '}
        <strong>
          {days} {dayLabel}
        </strong>{' '}
        remaining to enroll a passkey or authenticator app. After the grace period expires, admin
        actions will be blocked until MFA is set up.{' '}
        <Link
          href="/dashboard/settings/account/passkeys"
          className="underline underline-offset-2 font-medium hover:opacity-80 transition-opacity"
        >
          Set up MFA now
        </Link>
        .
      </div>
    </div>
  );
}
