'use client';

/**
 * NpsTrendChart — simple SVG line chart of weekly NPS scores.
 *
 * Renders a connected line chart without any external charting library
 * to avoid bundle-size impact (< 700 KB ratchet from Phase 1.6.13).
 * A recharts import here would push us over budget.
 *
 * WHY SVG not Canvas: Simpler, accessible (title/desc support), and SSR-safe.
 *
 * @module components/dashboard/founder-feedback/NpsTrendChart
 */

import * as React from 'react';
import type { NpsTrendPoint } from '@styrby/shared';

interface NpsTrendChartProps {
  /** Sorted ascending by week */
  trend: NpsTrendPoint[];
  /** Chart height in pixels (default 120) */
  height?: number;
}

/**
 * Format ISO week for axis label (e.g. "2026-W16" -> "W16").
 */
function shortWeek(isoWeek: string): string {
  return isoWeek.split('-')[1] ?? isoWeek;
}

/**
 * Map NPS score (-100 to +100) to SVG Y coordinate.
 *
 * WHY invert: SVG Y grows downward; score grows upward.
 *
 * @param score - NPS score
 * @param chartHeight - available chart height in px
 * @returns SVG Y coordinate
 */
function scoreToY(score: number, chartHeight: number): number {
  // Map -100..+100 to chartHeight..0 (inverted)
  return ((100 - score) / 200) * chartHeight;
}

/**
 * Weekly NPS trend line chart.
 *
 * @param props - NpsTrendChartProps
 */
export function NpsTrendChart({ trend, height = 120 }: NpsTrendChartProps) {
  const WIDTH = 560;
  const PADDING_X = 30;
  const PADDING_Y = 16;
  const CHART_H = height - PADDING_Y * 2;
  const CHART_W = WIDTH - PADDING_X * 2;

  if (!trend.length) {
    return (
      <div className="flex h-[120px] items-center justify-center rounded-lg bg-zinc-800/50 text-sm text-zinc-500">
        No trend data yet
      </div>
    );
  }

  const points = trend.map((p, i) => ({
    x: PADDING_X + (i / Math.max(trend.length - 1, 1)) * CHART_W,
    y: PADDING_Y + scoreToY(p.score, CHART_H),
    week: p.week,
    score: p.score,
    count: p.responseCount,
  }));

  const polylinePoints = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  // Zero line Y (where score = 0)
  const zeroY = PADDING_Y + scoreToY(0, CHART_H);

  return (
    <div className="overflow-x-auto" role="img" aria-label="Weekly NPS trend chart">
      <svg
        viewBox={`0 0 ${WIDTH} ${height + 24}`}
        width="100%"
        style={{ minWidth: 280 }}
        aria-hidden="true"
      >
        {/* Zero baseline */}
        <line
          x1={PADDING_X}
          y1={zeroY}
          x2={WIDTH - PADDING_X}
          y2={zeroY}
          stroke="#3f3f46"
          strokeWidth="1"
          strokeDasharray="4 4"
        />

        {/* Score line */}
        <polyline
          points={polylinePoints}
          fill="none"
          stroke="#6366f1"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* Data point dots */}
        {points.map((p) => (
          <g key={p.week}>
            <circle cx={p.x} cy={p.y} r="4" fill="#6366f1" />
            {/* Tooltip text on hover via title tag */}
            <title>{`${shortWeek(p.week)}: ${p.score > 0 ? '+' : ''}${p.score.toFixed(1)} (${p.count} responses)`}</title>
          </g>
        ))}

        {/* X-axis labels */}
        {points
          .filter((_, i) => i === 0 || i === points.length - 1 || i % Math.max(1, Math.floor(points.length / 5)) === 0)
          .map((p) => (
            <text
              key={`lbl-${p.week}`}
              x={p.x}
              y={height + 18}
              textAnchor="middle"
              fontSize="10"
              fill="#71717a"
              fontFamily="system-ui, sans-serif"
            >
              {shortWeek(p.week)}
            </text>
          ))}

        {/* Y-axis labels: +100, 0, -100 */}
        {[100, 0, -100].map((score) => (
          <text
            key={`y-${score}`}
            x={PADDING_X - 4}
            y={PADDING_Y + scoreToY(score, CHART_H) + 4}
            textAnchor="end"
            fontSize="9"
            fill="#52525b"
            fontFamily="system-ui, sans-serif"
          >
            {score > 0 ? `+${score}` : score}
          </text>
        ))}
      </svg>
    </div>
  );
}
