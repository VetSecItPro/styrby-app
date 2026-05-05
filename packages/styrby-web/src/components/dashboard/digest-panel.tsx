/**
 * Digest Panel
 *
 * Renders the user's most recent AI-generated session digest at the top of
 * the dashboard. Three states:
 *   - Free tier   → upgrade prompt (digests are a paid feature)
 *   - No digest yet (Pro/Growth) → empty state with friendly "first one is coming" copy
 *   - Has digest  → period label, session count, content, relative time
 *
 * The actual digest rows are written by /api/cron/generate-digest. This
 * component is a pure read — the only DB call is one indexed lookup
 * (idx_digest_summaries_user_recent).
 */

import * as React from 'react';

export interface DigestRow {
  period: 'daily' | 'weekly';
  period_start: string;
  period_end: string;
  session_count: number;
  content: string | null;
  generated_at: string;
}

export interface DigestPanelProps {
  digest: DigestRow | null;
  userTier: 'free' | 'pro' | 'growth';
}

/**
 * Format an ISO timestamp into a relative time string.
 * Keeps it dependency-free (no date-fns import for one helper).
 */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  const diffMs = now.getTime() - then;
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day} day${day === 1 ? '' : 's'} ago`;
  const week = Math.round(day / 7);
  return `${week} week${week === 1 ? '' : 's'} ago`;
}

export function DigestPanel({ digest, userTier }: DigestPanelProps) {
  // Free tier — gate behind upgrade.
  if (userTier === 'free') {
    return (
      <section
        aria-label="Session digest"
        className="mb-8 rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 flex items-center justify-between"
      >
        <div>
          <p className="text-sm font-medium text-zinc-300">AI session digest</p>
          <p className="text-xs text-zinc-500 mt-1">
            Get a weekly AI summary of your sessions on Pro, or daily on Growth.
          </p>
        </div>
        <a
          href="/pricing"
          className="shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-orange-500/10 border border-orange-500/20 px-3 py-1.5 text-xs font-medium text-orange-400 hover:bg-orange-500/20 transition-colors"
        >
          Upgrade to Pro
        </a>
      </section>
    );
  }

  // Pro/Growth, no digest yet — friendly empty state.
  if (!digest) {
    const upcomingLabel = userTier === 'growth' ? 'tomorrow morning' : 'this Sunday';
    return (
      <section
        aria-label="Session digest"
        className="mb-8 rounded-xl border border-zinc-800 bg-zinc-900 p-6"
      >
        <p className="text-sm font-medium text-zinc-300">Your AI session digest</p>
        <p className="text-xs text-zinc-500 mt-2">
          Your first digest will appear here {upcomingLabel}.
        </p>
      </section>
    );
  }

  const periodLabel = digest.period === 'weekly' ? 'This week' : 'Today';
  const sessionLabel = `${digest.session_count} session${digest.session_count === 1 ? '' : 's'}`;

  return (
    <section
      aria-label="Session digest"
      className="mb-8 rounded-xl border border-zinc-800 bg-zinc-900 p-6"
    >
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <span className="inline-flex items-center rounded-full bg-orange-500/10 px-2 py-0.5 text-xs font-medium text-orange-400 mr-2">
            {periodLabel}
          </span>
          <span className="text-xs text-zinc-500">{sessionLabel}</span>
        </div>
        <span className="text-xs text-zinc-500">
          {formatRelative(digest.generated_at)}
        </span>
      </div>
      {digest.content ? (
        <p className="text-sm leading-relaxed text-zinc-200">{digest.content}</p>
      ) : (
        <p className="text-sm text-zinc-500 italic">
          Digest is being generated. Check back shortly.
        </p>
      )}
    </section>
  );
}

export default DigestPanel;
