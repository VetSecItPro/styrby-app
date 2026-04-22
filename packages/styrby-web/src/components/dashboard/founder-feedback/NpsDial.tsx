'use client';

/**
 * NpsDial — circular gauge showing the current NPS score.
 *
 * Displays the score (-100 to +100) with color coding:
 *   < 0:  red (detractor-heavy)
 *   0-29: amber (needs work)
 *   30-49: yellow-green (good)
 *   50+:  green (excellent)
 *
 * WHY a dial vs a number: Acquirers scan visual metrics first. A colored
 * dial communicates health at a glance before they read the number.
 * The SVG arc approach avoids any third-party chart dependency.
 *
 * @module components/dashboard/founder-feedback/NpsDial
 */

import * as React from 'react';

interface NpsDialProps {
  /** NPS score (-100 to +100) */
  score: number;
  /** Total number of responses used to compute the score */
  total: number;
  /** Optional className for the outer wrapper */
  className?: string;
}

/**
 * Compute the arc color based on the NPS score.
 *
 * @param score - NPS score
 * @returns Tailwind text color class
 */
function scoreColor(score: number): string {
  if (score < 0) return '#ef4444';    // red-500
  if (score < 30) return '#f59e0b';   // amber-500
  if (score < 50) return '#84cc16';   // lime-500
  return '#22c55e';                    // green-500
}

/**
 * Convert NPS score (-100 to +100) to a 0-1 fraction for the arc.
 *
 * @param score - NPS score
 * @returns Fraction 0-1
 */
function scoreFraction(score: number): number {
  return (score + 100) / 200;
}

/**
 * Build an SVG arc path for the dial.
 *
 * The arc goes from 7 o'clock (225 deg) to 5 o'clock (315 deg via the
 * long path = 270 degrees total sweep), matching a standard speedometer.
 *
 * @param fraction - 0-1 fill fraction
 * @param radius - Circle radius in SVG units
 * @param cx - Center x
 * @param cy - Center y
 * @returns SVG `d` attribute string
 */
function buildArc(fraction: number, radius = 52, cx = 60, cy = 60): string {
  const startDeg = 225;
  const sweepDeg = 270;
  const endDeg = startDeg + fraction * sweepDeg;

  const toRad = (d: number) => (d * Math.PI) / 180;

  const startX = cx + radius * Math.cos(toRad(startDeg));
  const startY = cy + radius * Math.sin(toRad(startDeg));
  const endX = cx + radius * Math.cos(toRad(endDeg));
  const endY = cy + radius * Math.sin(toRad(endDeg));

  const largeArc = fraction * sweepDeg > 180 ? 1 : 0;

  return `M ${startX.toFixed(2)} ${startY.toFixed(2)} A ${radius} ${radius} 0 ${largeArc} 1 ${endX.toFixed(2)} ${endY.toFixed(2)}`;
}

/**
 * NPS dial component. See module doc.
 *
 * @param props - NpsDialProps
 */
export function NpsDial({ score, total, className = '' }: NpsDialProps) {
  const fraction = scoreFraction(score);
  const color = scoreColor(score);
  const arcPath = buildArc(fraction);
  const bgArcPath = buildArc(1); // Full arc for background track

  const displayScore =
    score === 0 ? '0' : score > 0 ? `+${score.toFixed(score % 1 === 0 ? 0 : 1)}` : score.toFixed(score % 1 === 0 ? 0 : 1);

  return (
    <div className={`flex flex-col items-center gap-1 ${className}`} aria-label={`NPS score: ${displayScore}`}>
      <svg
        viewBox="0 0 120 90"
        width="160"
        height="120"
        aria-hidden="true"
      >
        {/* Background track */}
        <path
          d={bgArcPath}
          fill="none"
          stroke="#3f3f46"
          strokeWidth="10"
          strokeLinecap="round"
        />
        {/* Score arc */}
        {total > 0 && (
          <path
            d={arcPath}
            fill="none"
            stroke={color}
            strokeWidth="10"
            strokeLinecap="round"
          />
        )}
        {/* Score label */}
        <text
          x="60"
          y="68"
          textAnchor="middle"
          fontSize="22"
          fontWeight="700"
          fill={total > 0 ? color : '#71717a'}
          fontFamily="system-ui, sans-serif"
        >
          {total > 0 ? displayScore : '--'}
        </text>
      </svg>

      <p className="text-xs text-zinc-400">
        {total > 0 ? `${total} response${total !== 1 ? 's' : ''}` : 'No responses yet'}
      </p>
    </div>
  );
}
