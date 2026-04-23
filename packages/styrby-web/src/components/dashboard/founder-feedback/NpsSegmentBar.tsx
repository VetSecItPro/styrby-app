'use client';

/**
 * NpsSegmentBar — horizontal stacked bar showing promoter/passive/detractor mix.
 *
 * Green = promoters, yellow = passives, red = detractors.
 * Shows percentage labels for each segment when wide enough.
 *
 * WHY this component: A stacked bar is the standard NPS visualization
 * used in tools like Delighted, AskNicely, and Qualtrics. Acquirers
 * recognize this pattern immediately.
 *
 * @module components/dashboard/founder-feedback/NpsSegmentBar
 */

import * as React from 'react';

interface NpsSegmentBarProps {
  promoterPct: number;
  passivePct: number;
  detractorPct: number;
  /** Total response count for the label */
  total: number;
}

/**
 * Stacked segment bar for NPS promoter/passive/detractor distribution.
 *
 * @param props - NpsSegmentBarProps
 */
export function NpsSegmentBar({
  promoterPct,
  passivePct,
  detractorPct,
  total,
}: NpsSegmentBarProps) {
  if (total === 0) {
    return (
      <div className="h-3 w-full rounded-full bg-zinc-800" aria-label="No NPS data yet" />
    );
  }

  return (
    <div className="space-y-2">
      {/* Stacked bar */}
      <div
        className="flex h-3 w-full overflow-hidden rounded-full"
        role="img"
        aria-label={`Promoters ${promoterPct.toFixed(1)}%, Passives ${passivePct.toFixed(1)}%, Detractors ${detractorPct.toFixed(1)}%`}
      >
        {promoterPct > 0 && (
          <div
            className="h-full bg-green-500 transition-all"
            style={{ width: `${promoterPct}%` }}
            title={`Promoters: ${promoterPct.toFixed(1)}%`}
          />
        )}
        {passivePct > 0 && (
          <div
            className="h-full bg-yellow-400 transition-all"
            style={{ width: `${passivePct}%` }}
            title={`Passives: ${passivePct.toFixed(1)}%`}
          />
        )}
        {detractorPct > 0 && (
          <div
            className="h-full bg-red-500 transition-all"
            style={{ width: `${detractorPct}%` }}
            title={`Detractors: ${detractorPct.toFixed(1)}%`}
          />
        )}
      </div>

      {/* Legend */}
      <div className="flex gap-4 text-xs text-zinc-400">
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-green-500" />
          Promoters {promoterPct.toFixed(0)}%
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-yellow-400" />
          Passives {passivePct.toFixed(0)}%
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-red-500" />
          Detractors {detractorPct.toFixed(0)}%
        </span>
      </div>
    </div>
  );
}
