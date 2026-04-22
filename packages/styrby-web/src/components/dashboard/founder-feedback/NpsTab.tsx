'use client';

/**
 * NpsTab — NPS panel for the founder feedback dashboard.
 *
 * Sections:
 *  1. Score dial + segment bar (current NPS + breakdown)
 *  2. Weekly trend chart (last 12 weeks)
 *  3. Latest 10 follow-up comments
 *
 * Data refreshes every 60 seconds (per CLAUDE.md spec for founder dashboard).
 *
 * @module components/dashboard/founder-feedback/NpsTab
 */

import * as React from 'react';
import { NpsDial } from './NpsDial';
import { NpsTrendChart } from './NpsTrendChart';
import { NpsSegmentBar } from './NpsSegmentBar';
import type { NpsTrendPoint } from '@styrby/shared';
import { formatNpsScore } from '@styrby/shared';
import { MessageSquare } from 'lucide-react';

// ============================================================================
// Types
// ============================================================================

interface NpsComment {
  id: string;
  score: number;
  followup: string;
  window: string | null;
  created_at: string;
}

interface NpsCurrentData {
  score: number;
  promoters: number;
  passives: number;
  detractors: number;
  total: number;
  promoterPct: number;
  passivePct: number;
  detractorPct: number;
}

interface NpsTabData {
  currentNps: NpsCurrentData;
  trend: NpsTrendPoint[];
  latestComments: NpsComment[];
}

interface NpsTabProps {
  /** Initial server-fetched data (avoids loading flash) */
  initialData: NpsTabData;
  /** Window filter for this view */
  window: '7d' | '30d' | 'all';
}

// ============================================================================
// Component
// ============================================================================

/**
 * NPS panel component. See module doc.
 *
 * @param props - NpsTabProps
 */
export function NpsTab({ initialData, window }: NpsTabProps) {
  const [data, setData] = React.useState<NpsTabData>(initialData);
  const [loading, setLoading] = React.useState(false);

  // Auto-refresh every 60 seconds
  React.useEffect(() => {
    const interval = setInterval(async () => {
      try {
        setLoading(true);
        const res = await fetch(
          `/api/admin/founder-feedback?tab=nps&window=${window}&weeks=12`,
          { credentials: 'include' }
        );
        if (res.ok) {
          const json = await res.json();
          setData(json.data);
        }
      } catch {
        // Non-fatal: keep showing stale data
      } finally {
        setLoading(false);
      }
    }, 60_000);

    return () => clearInterval(interval);
  }, [window]);

  const { currentNps, trend, latestComments } = data;

  return (
    <div className="space-y-6">
      {/* Current score + breakdown */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {/* Dial */}
        <div className="flex flex-col items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 p-6">
          <p className="mb-3 text-sm font-medium text-zinc-300">
            Current NPS
            {loading && (
              <span className="ml-2 inline-block h-2 w-2 animate-pulse rounded-full bg-indigo-400" />
            )}
          </p>
          <NpsDial score={currentNps.score} total={currentNps.total} />
        </div>

        {/* Segment breakdown */}
        <div className="flex flex-col justify-center rounded-lg border border-zinc-800 bg-zinc-900 p-6">
          <p className="mb-4 text-sm font-medium text-zinc-300">Segment breakdown</p>
          <NpsSegmentBar
            promoterPct={currentNps.promoterPct}
            passivePct={currentNps.passivePct}
            detractorPct={currentNps.detractorPct}
            total={currentNps.total}
          />
          {currentNps.total > 0 && (
            <div className="mt-4 grid grid-cols-3 gap-2 text-center">
              <div>
                <p className="text-xl font-bold text-green-400">{currentNps.promoters}</p>
                <p className="text-xs text-zinc-500">Promoters</p>
              </div>
              <div>
                <p className="text-xl font-bold text-yellow-400">{currentNps.passives}</p>
                <p className="text-xs text-zinc-500">Passives</p>
              </div>
              <div>
                <p className="text-xl font-bold text-red-400">{currentNps.detractors}</p>
                <p className="text-xs text-zinc-500">Detractors</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Weekly trend */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6">
        <p className="mb-4 text-sm font-medium text-zinc-300">Weekly trend (last 12 weeks)</p>
        <NpsTrendChart trend={trend} height={120} />
      </div>

      {/* Latest comments */}
      {latestComments.length > 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6">
          <p className="mb-4 flex items-center gap-2 text-sm font-medium text-zinc-300">
            <MessageSquare className="h-4 w-4" />
            Latest follow-up comments
          </p>
          <ul className="space-y-3">
            {latestComments.map((comment) => (
              <li key={comment.id} className="border-b border-zinc-800 pb-3 last:border-0 last:pb-0">
                <div className="mb-1 flex items-center gap-2">
                  <span className="rounded bg-indigo-900/40 px-1.5 py-0.5 text-xs font-semibold text-indigo-300">
                    {formatNpsScore(comment.score)}
                  </span>
                  {comment.window && (
                    <span className="text-xs text-zinc-500">
                      {comment.window === '7d' ? '7-day survey' : '30-day survey'}
                    </span>
                  )}
                  <span className="ml-auto text-xs text-zinc-400">
                    {new Date(comment.created_at).toLocaleDateString()}
                  </span>
                </div>
                <p className="text-sm text-zinc-200">{comment.followup}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {currentNps.total === 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-8 text-center">
          <p className="text-sm text-zinc-500">
            No NPS responses yet.
            Prompts are scheduled for day 7 and day 30 after signup.
          </p>
        </div>
      )}
    </div>
  );
}
