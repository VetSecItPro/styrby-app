'use client';

/**
 * Lazy-loaded wrapper for SsoSettingsPanel.
 *
 * WHY dynamic import:
 *   SsoSettingsPanel is a 540-line interactive form that imports lucide-react
 *   (Shield, Lock, Mail, Users, AlertTriangle, CheckCircle, XCircle) and
 *   several Radix UI primitives (Input, Button, Label). The SSO settings page
 *   is admin-only and visited by at most the team owner — typically ~1 user
 *   per team. Deferring its load prevents all dashboard users from paying the
 *   download cost for code almost nobody executes.
 *
 * WHY ssr: false not used:
 *   SsoSettingsPanel uses useState and fetch but no browser-only APIs
 *   (no ResizeObserver, no canvas). SSR is safe and provides initial HTML
 *   to avoid a blank flash before hydration.
 *
 * WHY fixed-dimension skeleton:
 *   The skeleton matches the three status-card row + settings form structure
 *   (~520 px tall) to prevent cumulative layout shift (CLS).
 *
 * Follows the pattern from cost-charts-dynamic.tsx (Phase 1.6.13),
 * members-dynamic.tsx (Phase 2.3), and policies-dynamic.tsx (Phase 2.3).
 *
 * @module dashboard/team/[teamId]/sso/sso-dynamic
 */

import dynamic from 'next/dynamic';
import type { ComponentProps } from 'react';

// ============================================================================
// Types
// ============================================================================

/**
 * Props mirror SsoSettingsPanel exactly so this wrapper is a transparent
 * drop-in replacement in the server page.
 */
type SsoPanelProps = ComponentProps<typeof import('./sso-settings-panel').SsoSettingsPanel>;

// ============================================================================
// Skeleton
// ============================================================================

/**
 * Skeleton matching the SsoSettingsPanel layout.
 * Three status cards (horizontal row) + one settings form card.
 * Fixed heights prevent cumulative layout shift.
 */
function SsoPanelSkeleton() {
  return (
    <div className="space-y-8" aria-busy="true" aria-label="Loading SSO settings">
      {/* Status cards row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="rounded-lg border border-border/60 bg-card p-4 animate-pulse"
            style={{ minHeight: 80 }}
          >
            <div className="h-3 bg-zinc-800 rounded w-20 mb-2" />
            <div className="h-4 bg-zinc-800 rounded w-28" />
          </div>
        ))}
      </div>

      {/* Settings form card */}
      <div
        className="rounded-xl border border-border/60 bg-card p-6 animate-pulse space-y-5"
        style={{ minHeight: 320 }}
      >
        <div className="h-4 bg-zinc-800 rounded w-48 mb-1" />
        <div className="h-3 bg-zinc-800 rounded w-80 mb-6" />
        <div className="space-y-2">
          <div className="h-3 bg-zinc-800 rounded w-40" />
          <div className="h-10 bg-zinc-800 rounded-lg" />
        </div>
        <div className="h-16 bg-zinc-800 rounded-lg" />
        <div className="flex justify-end">
          <div className="h-9 w-28 bg-zinc-800 rounded-lg" />
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Dynamic import
// ============================================================================

/**
 * Dynamically imported SsoSettingsPanel.
 * Defers lucide-react icons and Radix primitives until the SSO admin page is visited.
 */
const SsoSettingsPanelLazy = dynamic<SsoPanelProps>(
  () =>
    import('./sso-settings-panel').then((mod) => ({
      default: mod.SsoSettingsPanel,
    })),
  { loading: () => <SsoPanelSkeleton /> },
);

// ============================================================================
// Export
// ============================================================================

/**
 * Transparent dynamic wrapper for SsoSettingsPanel.
 * Pass all props through directly — the API is identical to the eager component.
 *
 * @param props - SsoSettingsPanel props (teamId, ssoDomain, requireSso, etc.)
 */
export function SsoSettingsPanelDynamic(props: SsoPanelProps) {
  return <SsoSettingsPanelLazy {...props} />;
}
