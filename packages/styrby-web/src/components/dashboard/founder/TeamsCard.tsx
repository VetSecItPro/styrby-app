'use client';

/**
 * TeamsCard
 *
 * Displays the Phase 2.3 team aggregate metrics on the founder dashboard:
 *   - Total team count
 *   - Average team size
 *   - Teams with churn in the last 30 days
 *   - Churn rate per team (rolling 30d)
 *   - Per-team breakdown table
 *
 * Data is fetched from /api/admin/founder-team-metrics by the parent server
 * component and passed as props. This component is purely presentational.
 *
 * WHY client component:
 *   The teams table supports toggling an expand/collapse for the per-team rows
 *   (using useState). If no interactivity is needed in the future, this can
 *   be converted to a server component.
 *
 * @module components/dashboard/founder/TeamsCard
 */

import { useState } from 'react';
import { Users, ChevronDown, ChevronUp } from 'lucide-react';
import type { FounderTeamMetrics, FounderTeamSummary } from '@styrby/shared';

// ============================================================================
// Types
// ============================================================================

export interface TeamsCardProps {
  /** Team metrics payload from /api/admin/founder-team-metrics */
  metrics: FounderTeamMetrics;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Formats a fractional rate (0-1) as "X.X%" for display.
 *
 * @param rate - Fractional rate, or null
 * @returns Formatted percentage string or "-"
 */
function fmtPct(rate: number | null): string {
  if (rate === null) return '-';
  return `${(rate * 100).toFixed(1)}%`;
}

/**
 * Formats an ISO date string to a short readable form.
 *
 * @param iso - ISO 8601 string
 * @returns Short date (e.g. "Jun 1, 2025")
 */
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

// ============================================================================
// Sub-components
// ============================================================================

/**
 * A single summary stat cell (label + value).
 *
 * @param props.label - Stat label
 * @param props.value - Stat value string
 * @param props.sub - Optional sub-label
 * @returns Rendered stat cell
 */
function StatCell({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <p className="text-muted-foreground text-xs uppercase tracking-wide">{label}</p>
      <p className="text-foreground text-2xl font-bold mt-0.5">{value}</p>
      {sub && <p className="text-muted-foreground text-xs">{sub}</p>}
    </div>
  );
}

/**
 * Per-team row in the breakdown table.
 *
 * @param props.team - Team summary row
 * @returns Rendered table row
 */
function TeamRow({ team }: { team: FounderTeamSummary }) {
  return (
    <tr className="border-b border-border/40 hover:bg-muted/20 transition-colors">
      <td className="py-2.5 px-4">
        <span className="text-foreground text-sm font-medium">{team.team_name}</span>
        <span className="text-muted-foreground text-xs ml-2 font-mono">
          {team.team_id.slice(0, 8)}
        </span>
      </td>
      <td className="py-2.5 px-4">
        <span className="text-muted-foreground text-xs capitalize">{team.owner_tier}</span>
      </td>
      <td className="py-2.5 px-4 text-center text-sm text-foreground">
        {team.member_count}
      </td>
      <td className="py-2.5 px-4 text-center">
        {team.had_churn_30d ? (
          <span className="text-destructive text-xs font-medium">Yes</span>
        ) : (
          <span className="text-muted-foreground text-xs">-</span>
        )}
      </td>
      <td className="py-2.5 px-4 text-muted-foreground text-xs hidden md:table-cell">
        {fmtDate(team.created_at)}
      </td>
    </tr>
  );
}

// ============================================================================
// Main Component
// ============================================================================

/**
 * Teams aggregate metrics card for the founder dashboard.
 *
 * Shows summary stats (total teams, avg size, churn) and a collapsible
 * per-team breakdown table.
 *
 * @param props - See {@link TeamsCardProps}
 */
export function TeamsCard({ metrics }: TeamsCardProps) {
  const [expanded, setExpanded] = useState(metrics.teams.length <= 10);

  return (
    <section aria-labelledby="teams-card-heading" className="space-y-4">
      {/* Card header */}
      <div className="flex items-center gap-2">
        <Users size={16} className="text-muted-foreground" aria-hidden />
        <h2 id="teams-card-heading" className="text-sm font-semibold text-foreground">
          Teams
        </h2>
        <span className="text-muted-foreground text-xs ml-auto">
          Computed {new Date(metrics.computed_at).toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT
        </span>
      </div>

      {/* Summary stats */}
      <div className="rounded-xl border border-border/40 bg-card/60 p-5">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-6">
          <StatCell
            label="Total teams"
            value={String(metrics.team_count)}
          />
          <StatCell
            label="Avg team size"
            value={metrics.avg_team_size.toFixed(1)}
            sub="members"
          />
          <StatCell
            label="Teams w/ churn"
            value={String(metrics.churned_teams_30d)}
            sub="last 30 days"
          />
          <StatCell
            label="Team churn rate"
            value={fmtPct(metrics.churn_rate_per_team_30d)}
            sub="rolling 30d"
          />
        </div>
      </div>

      {/* Per-team breakdown table */}
      {metrics.teams.length > 0 && (
        <div className="rounded-xl border border-border/40 bg-card/60 overflow-hidden">
          {/* Collapsible toggle */}
          <button
            onClick={() => setExpanded((prev) => !prev)}
            className="w-full flex items-center justify-between px-4 py-3 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/20 transition-colors"
            aria-expanded={expanded}
            aria-controls="team-breakdown-table"
          >
            <span className="font-medium">
              Per-team breakdown ({metrics.teams.length} teams)
            </span>
            {expanded ? (
              <ChevronUp size={16} aria-hidden />
            ) : (
              <ChevronDown size={16} aria-hidden />
            )}
          </button>

          {expanded && (
            <div id="team-breakdown-table" className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/40 border-t">
                    <th className="text-left text-muted-foreground font-medium py-2.5 px-4">Team</th>
                    <th className="text-left text-muted-foreground font-medium py-2.5 px-4">Owner tier</th>
                    <th className="text-center text-muted-foreground font-medium py-2.5 px-4">Members</th>
                    <th className="text-center text-muted-foreground font-medium py-2.5 px-4">Churn (30d)</th>
                    <th className="text-left text-muted-foreground font-medium py-2.5 px-4 hidden md:table-cell">
                      Created
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.teams.map((team) => (
                    <TeamRow key={team.team_id} team={team} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {metrics.teams.length === 0 && (
        <div className="rounded-xl border border-border/40 bg-card/60 p-8 text-center">
          <Users size={32} className="text-muted-foreground mx-auto mb-3" aria-hidden />
          <p className="text-muted-foreground text-sm">No teams created yet.</p>
        </div>
      )}
    </section>
  );
}
