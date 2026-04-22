'use client';

/**
 * SessionCostDrillIn — click-through modal showing per-message cost breakdown.
 *
 * Features:
 *   - Per-message cost table, sortable by cost DESC
 *   - Token breakdown: input / output / cache-read / cache-write
 *   - Billing model chip + source badge per row
 *   - Summary header: total cost, dominant billing model, source mix
 *   - "Estimated vs reported" warning banner when session has mixed sources
 *
 * WHY modal not navigation: drill-in data is supplementary to the session list.
 * Opening a new page would lose scroll position and break the cost-dashboard flow.
 *
 * @module components/costs/SessionCostDrillIn
 */

import { useState, useEffect, useCallback } from 'react';
import { BillingModelChip, SourceBadge } from './BillingModelChip';
import type { BillingModel, CostSource } from '@styrby/shared';

// ============================================================================
// Types
// ============================================================================

/** Single cost record row from the API. */
interface CostMessage {
  id: string;
  recordedAt: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  model: string;
  agentType: string;
  billingModel: BillingModel;
  source: CostSource;
  creditsConsumed: number | null;
  subscriptionFractionUsed: number | null;
}

/** Full API response shape from /api/sessions/[id]/costs */
interface SessionCostData {
  sessionId: string;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  billingModel: BillingModel;
  sourceMix: { agentReported: number; styrbyEstimate: number };
  messages: CostMessage[];
}

/**
 * Props for {@link SessionCostDrillIn}.
 */
export interface SessionCostDrillInProps {
  /** Session ID to fetch cost breakdown for */
  sessionId: string;
  /** Display name for the modal title (e.g., "Session #123" or a truncated summary) */
  sessionLabel: string;
  /** Trigger element — clicking opens the modal */
  children: React.ReactNode;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Format token count with K/M suffix.
 *
 * @param n - Raw token count
 * @returns Formatted string, e.g. "12.3K"
 */
function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

/**
 * Format a UTC ISO timestamp to a short local time string.
 *
 * @param iso - ISO 8601 string
 * @returns Time-only string, e.g. "14:30"
 */
function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

// ============================================================================
// Component
// ============================================================================

/**
 * Wraps any trigger element and renders a modal with per-message cost data
 * for the given session.
 *
 * Data is fetched lazily on first open and cached in component state.
 *
 * @example
 * <SessionCostDrillIn sessionId={session.id} sessionLabel={session.summary}>
 *   <button>View breakdown</button>
 * </SessionCostDrillIn>
 */
export function SessionCostDrillIn({
  sessionId,
  sessionLabel,
  children,
}: SessionCostDrillInProps) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<SessionCostData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 'cost' | 'time' — default sort by cost descending
  const [sortBy, setSortBy] = useState<'cost' | 'time'>('cost');

  const fetchData = useCallback(async () => {
    if (data) return; // Already loaded — use cache
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/costs`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as SessionCostData;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load cost data');
    } finally {
      setLoading(false);
    }
  }, [sessionId, data]);

  function handleOpen() {
    setOpen(true);
    void fetchData();
  }

  function handleClose() {
    setOpen(false);
  }

  // Close on Escape key
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') handleClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const sortedMessages = data
    ? [...data.messages].sort((a, b) =>
        sortBy === 'cost' ? b.costUsd - a.costUsd : a.recordedAt.localeCompare(b.recordedAt)
      )
    : [];

  const hasMixedSources =
    data != null &&
    data.sourceMix.agentReported > 0 &&
    data.sourceMix.styrbyEstimate > 0;

  return (
    <>
      {/* Trigger */}
      <span
        role="button"
        tabIndex={0}
        onClick={handleOpen}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleOpen(); }}
        className="cursor-pointer"
        aria-label={`View cost breakdown for ${sessionLabel}`}
      >
        {children}
      </span>

      {/* Modal backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cost-drill-in-title"
        >
          {/* Overlay */}
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={handleClose}
            aria-hidden="true"
          />

          {/* Panel */}
          <div className="relative z-10 w-full max-w-3xl max-h-[90vh] bg-zinc-900 border border-zinc-700 rounded-t-2xl sm:rounded-2xl flex flex-col shadow-2xl overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800 shrink-0">
              <div>
                <h2 id="cost-drill-in-title" className="text-base font-semibold text-zinc-100">
                  Cost Breakdown
                </h2>
                <p className="text-xs text-zinc-500 mt-0.5 truncate max-w-xs">{sessionLabel}</p>
              </div>
              <button
                type="button"
                onClick={handleClose}
                className="text-zinc-400 hover:text-zinc-200 transition-colors"
                aria-label="Close"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {loading && (
                <div className="flex items-center justify-center py-16">
                  <div className="h-6 w-6 animate-spin rounded-full border-2 border-orange-500 border-t-transparent" aria-label="Loading" />
                </div>
              )}

              {error && (
                <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-4 py-3 text-sm text-red-400">
                  {error}
                </div>
              )}

              {data && (
                <>
                  {/* Summary header row */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                    {[
                      { label: 'Total Cost', value: `$${data.totalCostUsd.toFixed(4)}` },
                      { label: 'Input Tokens', value: fmt(data.totalInputTokens) },
                      { label: 'Output Tokens', value: fmt(data.totalOutputTokens) },
                      { label: 'Cache Read', value: fmt(data.totalCacheReadTokens) },
                    ].map(({ label, value }) => (
                      <div key={label} className="rounded-lg bg-zinc-800/60 border border-zinc-700/40 px-3 py-2.5 text-center">
                        <p className="text-xs text-zinc-500">{label}</p>
                        <p className="text-base font-semibold text-zinc-100 mt-0.5">{value}</p>
                      </div>
                    ))}
                  </div>

                  {/* Mixed-source warning */}
                  {hasMixedSources && (
                    <div className="mb-4 flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-400">
                      <svg className="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                      </svg>
                      <span>
                        This session mixes agent-reported ({data.sourceMix.agentReported}) and Styrby-estimated ({data.sourceMix.styrbyEstimate}) records. Estimated values may differ from actual billing.
                      </span>
                    </div>
                  )}

                  {/* Sort controls */}
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-xs text-zinc-500">Sort by:</span>
                    {(['cost', 'time'] as const).map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setSortBy(s)}
                        className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                          sortBy === s
                            ? 'bg-orange-500/20 text-orange-300'
                            : 'text-zinc-400 hover:text-zinc-200'
                        }`}
                      >
                        {s === 'cost' ? 'Cost (high-low)' : 'Time (chronological)'}
                      </button>
                    ))}
                  </div>

                  {/* Message table */}
                  <div className="overflow-x-auto rounded-lg border border-zinc-800">
                    <table className="w-full text-sm">
                      <thead className="bg-zinc-800/50">
                        <tr>
                          {['Time', 'Model', 'Billing', 'Src', 'Input', 'Output', 'Cache', 'Cost'].map((h) => (
                            <th key={h} className="px-3 py-2 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider whitespace-nowrap">
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-800">
                        {sortedMessages.map((msg) => (
                          <tr key={msg.id} className="hover:bg-zinc-800/30 transition-colors">
                            <td className="px-3 py-2 text-xs text-zinc-500 whitespace-nowrap">
                              {fmtTime(msg.recordedAt)}
                            </td>
                            <td className="px-3 py-2 text-xs text-zinc-300 max-w-[120px] truncate">
                              {msg.model}
                            </td>
                            <td className="px-3 py-2">
                              <BillingModelChip billingModel={msg.billingModel} />
                            </td>
                            <td className="px-3 py-2">
                              <SourceBadge source={msg.source} />
                            </td>
                            <td className="px-3 py-2 text-xs text-zinc-400 whitespace-nowrap">
                              {fmt(msg.inputTokens)}
                            </td>
                            <td className="px-3 py-2 text-xs text-zinc-400 whitespace-nowrap">
                              {fmt(msg.outputTokens)}
                            </td>
                            <td className="px-3 py-2 text-xs text-zinc-400 whitespace-nowrap">
                              {fmt(msg.cacheReadTokens)}
                            </td>
                            <td className="px-3 py-2 text-xs font-semibold text-zinc-100 whitespace-nowrap">
                              {msg.billingModel === 'subscription' && msg.subscriptionFractionUsed != null
                                ? `${(msg.subscriptionFractionUsed * 100).toFixed(1)}% quota`
                                : msg.billingModel === 'credit' && msg.creditsConsumed != null
                                ? `${msg.creditsConsumed} cr`
                                : `$${msg.costUsd.toFixed(5)}`}
                            </td>
                          </tr>
                        ))}
                        {sortedMessages.length === 0 && (
                          <tr>
                            <td colSpan={8} className="px-4 py-8 text-center text-zinc-500">
                              No cost records for this session yet.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
