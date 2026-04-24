/**
 * /legal/retention-proof — Data Retention Policy + Live Proof Page
 *
 * Purpose: Public page that (1) states Styrby's data retention policy derived
 * from migration 025 and (2) distinguishes between rules that are actively
 * enforced by automated jobs vs. target policies committed to but not yet
 * automated. Live counts are shown ONLY for enforced rules.
 *
 * WHY this page exists:
 *   GDPR Article 5(1)(e) — Storage limitation: data must be kept "no longer
 *   than necessary." Most companies publish retention policies but offer no
 *   evidence of enforcement. This page closes that gap by showing live deletion
 *   counts from the database, making our compliance posture verifiable.
 *
 *   For acquisition due diligence, this page is a strong signal: "we don't
 *   just have a policy, we have proof it runs." Critically, we distinguish
 *   between policies that ARE backed by running automation and those that are
 *   committed targets in progress — publishing unenforced claims on a page
 *   titled "Retention Proof" would be a GDPR diligence liability.
 *
 * Architecture:
 *   Server Component that calls our own /api/legal/retention-proof endpoint
 *   at render time (server-side fetch, 1-hour cache). On API error, renders
 *   a graceful fallback. The static policy table is never blocked by API failure.
 *
 * Audit citations:
 *   GDPR Art. 5(1)(e) — Storage limitation principle
 *   GDPR Art. 17      — Right to erasure (retention + deletion policy)
 *   Migration 025     — delete_expired_sessions() cron, styrby_expire_stale_exports cron
 *   SOC2 CC6.5        — Removal of access on deletion
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import type { RetentionProofResponse } from '@/app/api/legal/retention-proof/route';

export const metadata: Metadata = {
  title: 'Data Retention — Target Policy and Live Proof — Styrby',
  description:
    "Styrby's data retention policy: target windows for all data types, plus live proof for rules backed by automated enforcement. GDPR Article 5(1)(e) storage limitation compliance.",
  openGraph: {
    title: 'Styrby Data Retention - Target Policy and Live Proof',
    description:
      'Retention windows for sessions, audit logs, and account data. Clearly marks which rules are enforced by automated jobs vs. committed targets in progress.',
    type: 'website',
    url: 'https://styrbyapp.com/legal/retention-proof',
  },
  robots: {
    index: true,
    follow: true,
  },
};

/**
 * Enforcement status for each retention policy row.
 *
 * 'enforced' — backed by an active pg_cron job or scheduled edge function in production.
 * 'target'   — policy we are committed to; automated enforcement is in progress.
 *
 * WHY we distinguish these:
 *   Publishing "hard-delete follows 48h" or "audit logs removed after 90 days"
 *   as live proof without an actual cron backing those claims is a GDPR
 *   Art. 5(1)(e) diligence risk. We state the truth: enforced rules have
 *   running automation; target rules have a policy commitment and a roadmap
 *   item to automate them.
 */
type EnforcementStatus = 'enforced' | 'target';

interface RetentionPolicyRow {
  dataType: string;
  retentionWindow: string;
  mechanism: string;
  gdprBasis: string;
  /** Whether this rule has live automated enforcement. */
  enforcement: EnforcementStatus;
  /** Human-readable label shown in the Status column. */
  enforcementLabel: string;
}

/**
 * Retention policy rows derived from migration 025.
 *
 * Enforcement column tracks the honest state as of 2026-04-24:
 *
 *   ENFORCED (pg_cron jobs registered in migration 025):
 *     - Sessions soft-delete: styrby_delete_expired_sessions (nightly, 03:00 CT)
 *     - Data export request expiry: styrby_expire_stale_exports (nightly, 03:30 CT)
 *     - Account soft-delete: set on request via /api/account/delete (immediate)
 *
 *   TARGET (policy committed, automation in progress):
 *     - Sessions hard-delete 48h after soft-delete: hard_delete_soft_deleted_sessions
 *       cron is referenced in migration 025 comments but not yet scheduled.
 *     - Audit log purge at 90 days: no cron in any migration as of 025.
 *     - Cost records purge at account + 90 days: no cron as of 025.
 *     - Account hard-delete: delegated to edge function purge-deleted-accounts;
 *       the migration registers get_accounts_pending_hard_delete() but the
 *       edge function + its cron schedule are a separate deployment artifact.
 *
 * WHY hardcoded here vs. importing from migration:
 *   SQL migration files are not importable in Next.js. The canonical semantics
 *   live in migration 025; this table documents those semantics for humans.
 *   When the migration changes, this table must be updated in tandem.
 */
const RETENTION_POLICY: RetentionPolicyRow[] = [
  {
    dataType: 'Sessions',
    retentionWindow: 'Per user setting: 7 / 30 / 90 / 365 days, or Never (default)',
    mechanism:
      'Soft-delete (deleted_at set) by nightly cron delete_expired_sessions(). Hard-delete 48h after soft-delete is a committed target pending a second cron job.',
    gdprBasis: 'Art. 5(1)(e) storage limitation; Art. 17 right to erasure',
    enforcement: 'enforced',
    enforcementLabel: 'Enforced (soft-delete)',
  },
  {
    dataType: 'Session messages',
    retentionWindow: 'Same as parent session',
    mechanism:
      'Cascades with session soft/hard delete. Content is E2E encrypted; Styrby cannot read it.',
    gdprBasis: 'Art. 5(1)(e); zero-knowledge architecture',
    enforcement: 'enforced',
    enforcementLabel: 'Enforced (cascades with session)',
  },
  {
    dataType: 'Data export requests',
    retentionWindow: '72 hours for pending/processing status, then marked expired',
    mechanism:
      'Nightly cron styrby_expire_stale_exports marks stale requests expired at 03:30 CT. Records remain in the audit table.',
    gdprBasis: 'Art. 15 (subject access right); migration 025 styrby_expire_stale_exports',
    enforcement: 'enforced',
    enforcementLabel: 'Enforced (nightly cron)',
  },
  {
    dataType: 'Account (profile)',
    retentionWindow: '30-day grace window after deletion request',
    mechanism:
      'Soft-delete on request (deleted_at set immediately). Hard-delete via edge function purge-deleted-accounts after 30 days — deployment in progress.',
    gdprBasis: 'Art. 17 right to erasure (30-day grace period per Art. 17(3)(e))',
    enforcement: 'target',
    enforcementLabel: 'Target (edge function pending)',
  },
  {
    dataType: 'Audit log entries',
    retentionWindow: '90 days after account deletion, then permanently removed',
    mechanism:
      'Retained for security investigation per SOC2 CC7.2. Automated purge cron is a committed target; no scheduled job as of migration 025.',
    gdprBasis: 'Art. 5(1)(e); SOC2 CC7.2 system monitoring',
    enforcement: 'target',
    enforcementLabel: 'Target (cron pending)',
  },
  {
    dataType: 'Cost records',
    retentionWindow: 'Duration of account + 90 days after deletion',
    mechanism:
      'BRIN-indexed time-series table retained for billing reconciliation. Automated purge on account deletion is a committed target; no scheduled job as of migration 025.',
    gdprBasis: 'Financial record retention; tax compliance',
    enforcement: 'target',
    enforcementLabel: 'Target (cron pending)',
  },
];

/** Date this retention policy was last audited and verified against migration 025. */
const POLICY_LAST_AUDITED = '2026-04-24';

/**
 * Fetches live retention proof counts from our own API.
 * Returns null on any error — the page degrades gracefully.
 *
 * WHY we call our own API (vs. querying Supabase directly in the Server Component):
 *   1. The API route has its own cache headers (1 hour) — reusing it avoids
 *      an extra uncached DB round-trip on every page render.
 *   2. Centralizes the DB query logic in one place; the page doesn't need to
 *      know the Supabase schema.
 *   3. The API is separately testable.
 *
 * @returns Retention counts or null on failure.
 */
async function fetchRetentionCounts(): Promise<RetentionProofResponse | null> {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
    const res = await fetch(`${baseUrl}/api/legal/retention-proof`, {
      // WHY next.revalidate=3600: matches the API's Cache-Control max-age
      // so the Server Component and CDN cache are aligned.
      next: { revalidate: 3600 },
    });

    if (!res.ok) {
      return null;
    }

    return (await res.json()) as RetentionProofResponse;
  } catch {
    return null;
  }
}

/**
 * Renders the enforcement status badge for a policy row.
 *
 * @param status - 'enforced' | 'target'
 * @param label  - Human-readable label for the badge
 * @returns A styled inline element.
 */
function EnforcementBadge({
  status,
  label,
}: {
  status: EnforcementStatus;
  label: string;
}) {
  if (status === 'enforced') {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs font-medium text-emerald-400"
        data-enforcement="enforced"
        aria-label={`Enforcement status: ${label}`}
      >
        {/* WHY checkmark icon as text: avoids an icon dependency; accessible via aria-label */}
        <span aria-hidden="true">✅</span>
        {label}
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center gap-1 text-xs font-medium text-amber-400"
      data-enforcement="target"
      aria-label={`Enforcement status: ${label}`}
    >
      <span aria-hidden="true">📋</span>
      {label}
    </span>
  );
}

/**
 * Retention proof page — Server Component.
 *
 * Renders the static retention policy table (always) — with an enforcement
 * status column — and live purge counts fetched from the API for enforced
 * rules only (with graceful fallback on error).
 */
export default async function RetentionProofPage() {
  const liveCounts = await fetchRetentionCounts();

  return (
    <div className="min-h-screen bg-zinc-950">
      {/* Navigation header */}
      <header className="border-b border-zinc-800 bg-zinc-900/50">
        <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            <Link href="/" className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center">
                <span className="text-lg font-bold text-white">S</span>
              </div>
              <span className="font-semibold text-zinc-100">Styrby</span>
            </Link>
            <Link
              href="/"
              className="text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Back to Home
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6 lg:px-8">
        {/* Page header */}
        <div className="mb-10">
          <h1 className="text-3xl font-bold text-zinc-100">
            Data Retention - Target Policy and Live Proof
          </h1>
          <p className="mt-2 text-sm text-zinc-500">
            Policy last audited: {POLICY_LAST_AUDITED}
          </p>
          <p className="mt-4 text-zinc-300 max-w-3xl">
            Under{' '}
            <strong className="text-zinc-200">GDPR Article 5(1)(e)</strong> (storage limitation),
            personal data must not be kept longer than necessary. This page documents our target
            retention windows and clearly distinguishes between rules that are{' '}
            <strong className="text-emerald-400">actively enforced</strong> by automated jobs and
            rules that are{' '}
            <strong className="text-amber-400">committed targets</strong> with enforcement in
            progress.
          </p>

          {/* Enforcement legend */}
          <div className="mt-4 flex flex-wrap gap-4 rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3">
            <div className="flex items-center gap-2 text-sm">
              <span aria-hidden="true">✅</span>
              <span className="text-emerald-400 font-medium">Enforced</span>
              <span className="text-zinc-400">- backed by an active automated cron or scheduled job</span>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <span aria-hidden="true">📋</span>
              <span className="text-amber-400 font-medium">Target</span>
              <span className="text-zinc-400">- policy we are committed to; automated enforcement in progress</span>
            </div>
          </div>
        </div>

        {/* Section 1: Retention policy table */}
        <section aria-labelledby="policy-heading" className="mb-12">
          <h2
            id="policy-heading"
            className="mb-4 text-xl font-semibold text-zinc-100"
          >
            Retention Policy at a Glance
          </h2>
          <p className="mb-4 text-sm text-zinc-400">
            Derived from{' '}
            <strong className="text-zinc-300">migration 025</strong>{' '}
            (Data Privacy Control Center, 2026-04-22). Enforced rules run via PostgreSQL functions{' '}
            <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs text-orange-300">
              delete_expired_sessions()
            </code>{' '}
            and{' '}
            <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs text-orange-300">
              styrby_expire_stale_exports
            </code>{' '}
            scheduled via pg_cron at 03:00 CT daily. Target rules will be backed by automated jobs in a future release.
          </p>

          <div className="overflow-x-auto rounded-lg border border-zinc-800">
            <table
              className="min-w-full divide-y divide-zinc-800"
              aria-label="Styrby data retention policy"
            >
              <thead className="bg-zinc-900">
                <tr>
                  <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-400">
                    Data Type
                  </th>
                  <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-400">
                    Retention Window
                  </th>
                  <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-400">
                    Mechanism
                  </th>
                  <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-400">
                    GDPR Basis
                  </th>
                  <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-400">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800 bg-zinc-950">
                {RETENTION_POLICY.map((row) => (
                  <tr key={row.dataType} className="hover:bg-zinc-900/50 transition-colors">
                    <td className="px-4 py-4 text-sm font-medium text-zinc-200 align-top whitespace-nowrap">
                      {row.dataType}
                    </td>
                    <td className="px-4 py-4 text-sm text-zinc-300 align-top">
                      {row.retentionWindow}
                    </td>
                    <td className="px-4 py-4 text-sm text-zinc-400 align-top max-w-xs">
                      {row.mechanism}
                    </td>
                    <td className="px-4 py-4 text-sm text-zinc-500 align-top max-w-xs">
                      {row.gdprBasis}
                    </td>
                    <td className="px-4 py-4 align-top whitespace-nowrap">
                      <EnforcementBadge
                        status={row.enforcement}
                        label={row.enforcementLabel}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Section 2: Live proof — enforced rules only */}
        <section aria-labelledby="live-proof-heading" className="mb-12">
          <h2
            id="live-proof-heading"
            className="mb-2 text-xl font-semibold text-zinc-100"
          >
            Live Proof - Records Purged in Last 30 Days
          </h2>
          {/*
           * WHY this note: we only show live counts for rules backed by the
           * sessions soft-delete cron. Showing counts for target rules that
           * don't have a cron yet would be fabricating "proof" that doesn't exist.
           */}
          <p className="mb-4 text-sm text-zinc-400">
            Live counts are shown only for{' '}
            <strong className="text-emerald-400">Enforced</strong> rules. Target rules will
            appear here once their automated jobs are deployed.
          </p>

          {liveCounts === null ? (
            // Graceful fallback — API unavailable
            <div
              role="status"
              className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-5 py-4 text-sm text-zinc-400"
            >
              Retention data temporarily unavailable. The policy table above still applies and
              the nightly cron continues to run. Check back shortly.
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {/* Sessions soft-deleted — backed by styrby_delete_expired_sessions cron */}
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-5 py-4">
                <p className="text-sm text-zinc-400">Sessions soft-deleted (last 30 days)</p>
                <p className="mt-1 text-3xl font-bold text-orange-400" data-testid="sessions-purged-count">
                  {liveCounts.sessions_purged_30d.toLocaleString()}
                </p>
                <p className="mt-2 text-xs text-zinc-500">
                  Source: sessions WHERE deleted_at IS NOT NULL AND deleted_at &gt; now() - 30 days
                </p>
                <p className="mt-1 text-xs text-emerald-500">
                  ✅ Enforced by styrby_delete_expired_sessions (nightly, 03:00 CT)
                </p>
              </div>

              {/* As-of timestamp */}
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-5 py-4 flex flex-col justify-center">
                <p className="text-sm text-zinc-400">Count computed at</p>
                <p className="mt-1 text-sm font-medium text-zinc-200">
                  {new Date(liveCounts.as_of).toLocaleString('en-US', {
                    timeZone: 'America/Chicago',
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}{' '}
                  CT
                </p>
                <p className="mt-2 text-xs text-zinc-500">
                  Cached for up to 1 hour. Nightly cron runs at 03:00 CT.
                </p>
              </div>
            </div>
          )}
        </section>

        {/* Footer */}
        <div className="border-t border-zinc-800 pt-6 text-sm text-zinc-500">
          <p className="mb-3 text-zinc-400">
            Target rules without automated enforcement will be backed by scheduled jobs in a future
            release. See{' '}
            <strong className="text-zinc-300">migration 025</strong>{' '}
            (supabase/migrations/025_data_privacy_control_center.sql) for the canonical enforcement
            definitions.
          </p>
          <p>
            Questions about our retention policy?{' '}
            <a
              href="mailto:legal@styrbyapp.com"
              className="text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              legal@styrbyapp.com
            </a>
          </p>
          <p className="mt-3">
            Related:{' '}
            <Link href="/dpa" className="text-zinc-400 hover:text-zinc-200 transition-colors">
              Data Processing Agreement
            </Link>
            {' | '}
            <Link href="/privacy" className="text-zinc-400 hover:text-zinc-200 transition-colors">
              Privacy Policy
            </Link>
            {' | '}
            <Link href="/legal/subprocessors" className="text-zinc-400 hover:text-zinc-200 transition-colors">
              Subprocessors
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
