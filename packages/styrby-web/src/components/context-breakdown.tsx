'use client';

/**
 * Context Breakdown Component
 *
 * Displays a per-file token allocation table for a given AI agent session.
 * No competitor surfaces this data on the web or mobile — it is a key Styrby
 * differentiator that helps power users understand and optimize their context budget.
 *
 * Layout:
 * - Header row: total tokens + last updated timestamp
 * - Table: file path, token count, percentage bar, last accessed
 * - Empty state when no breakdown data is available
 *
 * @module components/context-breakdown
 */

import type { ContextBreakdown, FileContextEntry } from '@styrby/shared';
import { cn } from '@/lib/utils';

// ============================================================================
// Props
// ============================================================================

/**
 * Props for the ContextBreakdown component.
 */
interface ContextBreakdownProps {
  /**
   * The context breakdown data to render.
   * Pass null or undefined to show the empty/unavailable state.
   */
  breakdown: ContextBreakdown | null | undefined;

  /**
   * Optional CSS class name for the outermost container.
   */
  className?: string;
}

// ============================================================================
// Sub-components
// ============================================================================

/**
 * A single row in the file context table.
 *
 * Renders the file path, progress bar, token count, percentage, and last-access time.
 *
 * @param entry - The file context entry to render
 * @param rank - 1-based position (used for alternating row color)
 */
function FileContextRow({ entry, rank }: { entry: FileContextEntry; rank: number }) {
  /**
   * Shorten deeply nested paths to keep the table readable.
   * We show the last two path segments preceded by "...".
   *
   * WHY: Agent file paths are often long absolute paths like
   * /Users/alice/projects/myapp/src/components/auth/LoginForm.tsx.
   * Showing the full path wastes table width on mobile and desktop.
   * The final two segments are the most meaningful part.
   */
  const segments = entry.filePath.replace(/\\/g, '/').split('/').filter(Boolean);
  const displayPath =
    segments.length > 2 ? `.../${segments.slice(-2).join('/')}` : entry.filePath;

  const isEven = rank % 2 === 0;

  return (
    <tr
      className={cn(
        'group transition-colors',
        isEven ? 'bg-zinc-900/30' : 'bg-transparent',
        'hover:bg-zinc-800/60'
      )}
      title={entry.filePath}
    >
      {/* File path */}
      <td className="px-4 py-2.5 font-mono text-xs text-zinc-300 max-w-[240px] truncate">
        {displayPath}
      </td>

      {/* Progress bar + percentage */}
      <td className="px-4 py-2.5 min-w-[120px]">
        <div className="flex items-center gap-2">
          <div
            className="h-1.5 rounded-full bg-orange-500/80 transition-all"
            style={{ width: `${Math.max(entry.percentage, 2)}%` }}
            role="progressbar"
            aria-valuenow={Math.round(entry.percentage)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${entry.percentage.toFixed(1)}% of context`}
          />
          <span className="text-xs text-zinc-400 tabular-nums w-10 text-right">
            {entry.percentage.toFixed(1)}%
          </span>
        </div>
      </td>

      {/* Token count */}
      <td className="px-4 py-2.5 text-right tabular-nums text-xs text-zinc-400">
        {entry.tokenCount.toLocaleString()}
      </td>

      {/* Last accessed */}
      <td className="px-4 py-2.5 text-right text-xs text-zinc-500 whitespace-nowrap">
        {new Date(entry.lastAccessed).toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        })}
      </td>
    </tr>
  );
}

/**
 * Empty state shown when no context breakdown data is available.
 */
function EmptyBreakdown() {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center">
      {/* Icon */}
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-zinc-800">
        <svg
          className="h-5 w-5 text-zinc-500"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414A1 1 0 0121 9.414V19a2 2 0 01-2 2z"
          />
        </svg>
      </div>
      <p className="text-sm font-medium text-zinc-400">No context data yet</p>
      <p className="mt-1 text-xs text-zinc-400">
        Context usage is tracked while the session is active
      </p>
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

/**
 * ContextBreakdown — Per-file token allocation view for a session.
 *
 * WHY: Power users frequently hit context window limits and don't know which
 * files are consuming the most tokens. This component surfaces that data so
 * users can decide what to remove from context. No competitor (Happy Coder,
 * Cursor, etc.) shows this breakdown — it is a meaningful product differentiator.
 *
 * @param breakdown - Context breakdown data from Supabase or the CLI relay
 * @param className - Optional container CSS class
 *
 * @example
 * <ContextBreakdown breakdown={session.contextBreakdown} />
 */
export function ContextBreakdown({ breakdown, className }: ContextBreakdownProps) {
  return (
    <section
      className={cn(
        'rounded-xl border border-zinc-800 bg-zinc-900/50',
        className
      )}
      aria-label="Context budget breakdown"
    >
      {/* Section header */}
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <svg
            className="h-4 w-4 text-orange-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414A1 1 0 0121 9.414V19a2 2 0 01-2 2z"
            />
          </svg>
          <h3 className="text-sm font-semibold text-zinc-100">Context Budget</h3>
        </div>

        {breakdown && (
          <div className="flex items-center gap-3 text-xs text-zinc-500">
            <span>
              <span className="font-semibold tabular-nums text-zinc-300">
                {breakdown.totalTokens.toLocaleString()}
              </span>{' '}
              tokens total
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Updated{' '}
              {new Date(breakdown.updatedAt).toLocaleTimeString('en-US', {
                hour: 'numeric',
                minute: '2-digit',
                hour12: true,
              })}
            </span>
          </div>
        )}
      </div>

      {/* Content */}
      {!breakdown || breakdown.files.length === 0 ? (
        <EmptyBreakdown />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left" aria-label="Files in context window">
            <thead>
              <tr className="border-b border-zinc-800/60">
                <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
                  File
                </th>
                <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
                  Usage
                </th>
                <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">
                  Tokens
                </th>
                <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">
                  Last Read
                </th>
              </tr>
            </thead>
            <tbody>
              {breakdown.files.map((entry: FileContextEntry, index: number) => (
                <FileContextRow
                  key={entry.filePath}
                  entry={entry}
                  rank={index + 1}
                />
              ))}
            </tbody>
          </table>

          {/* Footer summary */}
          <div className="border-t border-zinc-800/60 px-4 py-2 text-xs text-zinc-400">
            {breakdown.files.length} file{breakdown.files.length !== 1 ? 's' : ''} in context
          </div>
        </div>
      )}
    </section>
  );
}

export default ContextBreakdown;
