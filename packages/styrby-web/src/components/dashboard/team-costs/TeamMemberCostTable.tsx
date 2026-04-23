'use client';

/**
 * TeamMemberCostTable
 *
 * Displays a per-member cost breakdown table with a proportional bar
 * for each member's share of the team total.
 *
 * WHY client component: sorting state (column, direction) is interactive
 * without requiring a server round-trip. All data is passed from the
 * server page component as props — no client-side fetching.
 *
 * @module components/dashboard/team-costs/TeamMemberCostTable
 */

import { useState } from 'react';
import { Users } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-member cost summary row. Mirrors the API response shape from
 * GET /api/teams/[id]/costs.
 */
export interface MemberCostRow {
  /** Supabase user ID */
  userId: string;
  /** Display name from profile, or email fallback */
  displayName: string;
  /** Member email */
  email: string;
  /** Total USD spend in the selected period */
  totalCostUsd: number;
  /** Total input tokens consumed */
  totalInputTokens: number;
  /** Total output tokens generated */
  totalOutputTokens: number;
}

/** Props for {@link TeamMemberCostTable}. */
export interface TeamMemberCostTableProps {
  /** Per-member cost rows to display. */
  members: MemberCostRow[];
  /** Pre-computed team total in USD (sum of all member costs). */
  teamTotal: number;
  /** The selected time range in days (7, 30, or 90). */
  days: number;
  /** Whether the viewer is an admin or owner — shows email column if true. */
  isAdminView: boolean;
}

// ---------------------------------------------------------------------------
// Sort helpers
// ---------------------------------------------------------------------------

type SortKey = 'displayName' | 'totalCostUsd' | 'totalInputTokens' | 'totalOutputTokens';
type SortDirection = 'asc' | 'desc';

/**
 * Sorts an array of MemberCostRow by the given key and direction.
 *
 * @param rows - The rows to sort (immutable — returns a new array)
 * @param key - The column to sort by
 * @param dir - Sort direction ('asc' | 'desc')
 * @returns Sorted copy of the rows array
 */
function sortRows(rows: MemberCostRow[], key: SortKey, dir: SortDirection): MemberCostRow[] {
  return [...rows].sort((a, b) => {
    const aVal = a[key];
    const bVal = b[key];

    if (typeof aVal === 'string' && typeof bVal === 'string') {
      return dir === 'asc'
        ? aVal.localeCompare(bVal)
        : bVal.localeCompare(aVal);
    }

    const aNum = Number(aVal);
    const bNum = Number(bVal);
    return dir === 'asc' ? aNum - bNum : bNum - aNum;
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Renders a sortable per-member cost table with proportional share bars.
 *
 * Sorting is client-side (all data is already present as props). The
 * default sort is by totalCostUsd descending so the highest spender
 * appears first, matching the "top-spender-first" UX convention.
 *
 * @param props - TeamMemberCostTableProps
 */
export function TeamMemberCostTable({
  members,
  teamTotal,
  days,
  isAdminView,
}: TeamMemberCostTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('totalCostUsd');
  const [sortDir, setSortDir] = useState<SortDirection>('desc');

  /**
   * Toggles sort state when a column header is clicked.
   * If the same key is clicked again, direction flips. Otherwise, defaults to 'desc'.
   *
   * @param key - The column key that was clicked
   */
  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  }

  const sorted = sortRows(members, sortKey, sortDir);

  const SortIndicator = ({ col }: { col: SortKey }) => {
    if (col !== sortKey) return <span className="ml-1 text-muted-foreground/40">-</span>;
    return (
      <span className="ml-1 text-muted-foreground">
        {sortDir === 'asc' ? '↑' : '↓'}
      </span>
    );
  };

  if (members.length === 0) {
    return (
      <div className="rounded-xl bg-card/60 border border-border/40 px-4 py-10 text-center">
        <Users className="h-8 w-8 text-muted-foreground/40 mx-auto mb-3" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">
          No cost data for this period. Once team members run sessions, costs will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Summary header */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {members.length} {members.length === 1 ? 'member' : 'members'} - last {days} days
        </p>
        <div className="text-right">
          <p className="text-xs text-muted-foreground">Team Total</p>
          <p className="text-lg font-bold text-foreground">${teamTotal.toFixed(2)}</p>
        </div>
      </div>

      {/* Desktop table */}
      <div className="hidden md:block rounded-xl bg-card/60 border border-border/40 overflow-hidden overflow-x-auto">
        <table className="w-full min-w-[480px]">
          <thead className="bg-secondary/40">
            <tr>
              <th
                className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider cursor-pointer select-none hover:text-foreground transition-colors"
                onClick={() => handleSort('displayName')}
                aria-sort={sortKey === 'displayName' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
              >
                Member <SortIndicator col="displayName" />
              </th>
              <th
                className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider cursor-pointer select-none hover:text-foreground transition-colors"
                onClick={() => handleSort('totalCostUsd')}
                aria-sort={sortKey === 'totalCostUsd' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
              >
                Spend <SortIndicator col="totalCostUsd" />
              </th>
              <th
                className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider cursor-pointer select-none hover:text-foreground transition-colors"
                onClick={() => handleSort('totalInputTokens')}
                aria-sort={sortKey === 'totalInputTokens' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
              >
                Input Tokens <SortIndicator col="totalInputTokens" />
              </th>
              <th
                className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider cursor-pointer select-none hover:text-foreground transition-colors"
                onClick={() => handleSort('totalOutputTokens')}
                aria-sort={sortKey === 'totalOutputTokens' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
              >
                Output Tokens <SortIndicator col="totalOutputTokens" />
              </th>
              <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Share
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/20">
            {sorted.map((member) => {
              const pct = teamTotal > 0 ? (member.totalCostUsd / teamTotal) * 100 : 0;
              const totalTokens = member.totalInputTokens + member.totalOutputTokens;

              return (
                <tr key={member.userId} className="hover:bg-secondary/10 transition-colors">
                  <td className="px-4 py-3">
                    <p className="text-sm font-medium text-foreground">{member.displayName}</p>
                    {isAdminView && (
                      <p className="text-xs text-muted-foreground">{member.email}</p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <p className="text-sm font-semibold text-foreground">
                      ${member.totalCostUsd.toFixed(4)}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <p className="text-xs text-muted-foreground">
                      {member.totalInputTokens.toLocaleString()}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <p className="text-xs text-muted-foreground">
                      {member.totalOutputTokens.toLocaleString()}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <div
                        className="h-1.5 w-16 rounded-full bg-border/40 overflow-hidden"
                        role="none"
                      >
                        <div
                          className="h-full rounded-full bg-orange-500/70"
                          style={{ width: `${Math.min(pct, 100).toFixed(1)}%` }}
                          role="progressbar"
                          aria-valuenow={pct}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-label={`${member.displayName} team share`}
                        />
                      </div>
                      <p className="text-xs text-muted-foreground w-10 text-right">
                        {pct.toFixed(1)}%
                      </p>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile card list */}
      <div className="md:hidden rounded-xl bg-card/60 border border-border/40 divide-y divide-border/20">
        {sorted.map((member) => {
          const pct = teamTotal > 0 ? (member.totalCostUsd / teamTotal) * 100 : 0;

          return (
            <div key={member.userId} className="px-4 py-3">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <p className="text-sm font-medium text-foreground">{member.displayName}</p>
                  {isAdminView && (
                    <p className="text-xs text-muted-foreground">{member.email}</p>
                  )}
                </div>
                <p className="text-sm font-semibold text-foreground">
                  ${member.totalCostUsd.toFixed(4)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex-1 h-1.5 rounded-full bg-border/40 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-orange-500/70"
                    style={{ width: `${Math.min(pct, 100).toFixed(1)}%` }}
                    role="progressbar"
                    aria-valuenow={pct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`${member.displayName} share`}
                  />
                </div>
                <p className="text-xs text-muted-foreground shrink-0">{pct.toFixed(1)}%</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
