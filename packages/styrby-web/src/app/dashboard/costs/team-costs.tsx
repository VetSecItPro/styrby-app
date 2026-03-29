'use client';

/**
 * Team Cost Dashboard Component
 *
 * Displays an aggregated cost breakdown for all members of a Power-tier team.
 * Shows per-member spend and a combined team total for the selected time range.
 *
 * WHY: Teams using Styrby need visibility into shared AI spend. A freelance
 * agency might have 3 developers running agents simultaneously; the team owner
 * needs to see who spent what to allocate costs to clients.
 *
 * WHY client component: This component fetches team data on mount using the
 * Supabase client, which requires browser-side auth state (cookies). The parent
 * costs page is a server component and cannot hold client-side fetch state.
 */

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-member cost summary row, computed from mv_daily_cost_summary.
 */
interface MemberCostRow {
  /** Supabase user ID */
  userId: string;
  /** Display name or email fallback */
  displayName: string;
  /** Member email */
  email: string;
  /** Total spend in USD for the selected period */
  totalCostUsd: number;
  /** Total input tokens consumed */
  totalInputTokens: number;
  /** Total output tokens generated */
  totalOutputTokens: number;
}

/**
 * Props for the TeamCosts component.
 */
interface TeamCostsProps {
  /**
   * The team ID to aggregate costs for. If null/undefined the component
   * renders nothing (caller should guard before rendering).
   */
  teamId: string;

  /**
   * ISO date string for the start of the display window (e.g. 30 days ago).
   * WHY: The parent server component already computed the range start date
   * from the `days` searchParam - reusing it keeps the two charts in sync.
   */
  rangeStartDate: string;
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function UsersIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * TeamCosts - renders a per-member cost breakdown for the user's Power team.
 *
 * Renders nothing if the user has no team or is not on Power tier. The parent
 * page (costs/page.tsx) is responsible for gatekeeping the render.
 *
 * @param props - TeamCostsProps
 */
export function TeamCosts({ teamId, rangeStartDate }: TeamCostsProps) {
  const supabase = createClient();

  const [memberCosts, setMemberCosts] = useState<MemberCostRow[]>([]);
  const [teamTotal, setTeamTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    /**
     * Fetches team member list and then aggregates cost data for each member
     * from mv_daily_cost_summary for the given date range.
     *
     * WHY two-step: We first get team membership (user_ids + display info) via
     * the API, then query the cost MV per-member. We can't do a single query
     * across teams because cost data lives in the individual user's rows (RLS
     * scoped). The team owner's Power subscription grants them access via RLS
     * policy to see team members' cost summaries through a server-side join
     * function - but the Supabase JS client can only call RPC, not write JOINs
     * across user_ids directly.
     *
     * WHY RPC: Using an RPC function (`get_team_cost_summary`) avoids exposing
     * other users' cost_records to the client. The function runs with elevated
     * privileges server-side and returns only the aggregated totals.
     */
    async function fetchTeamCosts() {
      setLoading(true);
      setError(null);

      try {
        // Call the server-side RPC function that aggregates team costs.
        // WHY: The RPC function has access to all team members' mv_daily_cost_summary
        // rows via the service role, applies the date filter, and returns only
        // the per-member totals - no raw cost_records are ever sent to the client.
        const { data, error: rpcError } = await supabase.rpc('get_team_cost_summary', {
          p_team_id: teamId,
          p_start_date: rangeStartDate,
        });

        if (rpcError) {
          // WHY: If the RPC function doesn't exist yet (pre-migration), surface
          // a clear message rather than a generic error. This prevents silent
          // failures during the rollout period before the DB migration is applied.
          if (rpcError.code === 'PGRST202' || rpcError.message.includes('does not exist')) {
            setError('Team cost aggregation requires a database migration. Run the latest migration to enable this feature.');
          } else {
            setError('Failed to load team costs. Please try again.');
          }
          setLoading(false);
          return;
        }

        // Type-assert the RPC result
        type RpcRow = {
          user_id: string;
          display_name: string | null;
          email: string;
          total_cost_usd: number;
          total_input_tokens: number;
          total_output_tokens: number;
        };

        const rows: MemberCostRow[] = ((data as RpcRow[]) ?? []).map((row) => ({
          userId: row.user_id,
          displayName: row.display_name ?? row.email,
          email: row.email,
          totalCostUsd: Number(row.total_cost_usd) || 0,
          totalInputTokens: Number(row.total_input_tokens) || 0,
          totalOutputTokens: Number(row.total_output_tokens) || 0,
        }));

        // Sort by cost descending - highest spender at the top
        rows.sort((a, b) => b.totalCostUsd - a.totalCostUsd);

        const total = rows.reduce((sum, r) => sum + r.totalCostUsd, 0);

        setMemberCosts(rows);
        setTeamTotal(total);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load team costs');
      } finally {
        setLoading(false);
      }
    }

    void fetchTeamCosts();
  }, [teamId, rangeStartDate, supabase]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <section className="mt-8" aria-label="Team cost breakdown loading">
        <div className="flex items-center gap-2 mb-4">
          <UsersIcon className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold text-foreground">Team Costs</h2>
        </div>
        <div className="rounded-xl bg-card/60 border border-border/40 px-4 py-8 text-center">
          <div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-border border-t-foreground" />
          <p className="text-sm text-muted-foreground mt-3">Loading team costs…</p>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="mt-8" aria-label="Team cost breakdown error">
        <div className="flex items-center gap-2 mb-4">
          <UsersIcon className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold text-foreground">Team Costs</h2>
        </div>
        <div className="rounded-xl bg-card/60 border border-border/40 px-4 py-6 text-center">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      </section>
    );
  }

  if (memberCosts.length === 0) {
    return (
      <section className="mt-8" aria-label="Team cost breakdown empty">
        <div className="flex items-center gap-2 mb-4">
          <UsersIcon className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold text-foreground">Team Costs</h2>
        </div>
        <div className="rounded-xl bg-card/60 border border-border/40 px-4 py-8 text-center">
          <p className="text-sm text-muted-foreground">
            No team cost data for this period. Invite team members and start sessions to see costs here.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="mt-8" aria-label="Team cost breakdown">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <UsersIcon className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold text-foreground">Team Costs</h2>
        </div>
        {/* Team total */}
        <div className="text-right">
          <p className="text-xs text-muted-foreground">Team Total</p>
          <p className="text-lg font-bold text-foreground">${teamTotal.toFixed(2)}</p>
        </div>
      </div>

      {/* Per-member breakdown */}
      <div className="rounded-xl bg-card/60 border border-border/40 divide-y divide-border/20">
        {memberCosts.map((member) => {
          // Fraction bar width: percentage of team total
          const pct = teamTotal > 0 ? (member.totalCostUsd / teamTotal) * 100 : 0;

          return (
            <div key={member.userId} className="px-4 py-3">
              <div className="flex items-center justify-between mb-1.5">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {member.displayName}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {(member.totalInputTokens + member.totalOutputTokens).toLocaleString()} tokens
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold text-foreground">
                    ${member.totalCostUsd.toFixed(4)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {pct.toFixed(1)}% of team
                  </p>
                </div>
              </div>
              {/* Proportional cost bar */}
              <div className="h-1.5 w-full rounded-full bg-border/40 overflow-hidden">
                <div
                  className="h-full rounded-full bg-orange-500/70"
                  style={{ width: `${pct.toFixed(1)}%` }}
                  role="progressbar"
                  aria-valuenow={pct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`${member.displayName} cost share`}
                />
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground/60 mt-2">
        Team cost data is visible to all Power plan team members.
      </p>
    </section>
  );
}
