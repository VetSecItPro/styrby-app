// WHY force-dynamic: Team cost data updates continuously (hourly MV refresh +
// real-time sessions). A cached SSR response would show stale spend totals —
// unacceptable for budget decision-making.
export const dynamic = 'force-dynamic';

import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import {
  TeamMemberCostTable,
  TeamAgentStackedBarDynamic,
  TeamBudgetProjection,
} from '@/components/dashboard/team-costs';
import type { MemberCostRow, TeamProjectionData } from '@/components/dashboard/team-costs';

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export const metadata: Metadata = {
  title: 'Team Cost Analytics | Styrby',
  description: 'Per-member AI agent spend, projected MTD vs seat budget, and per-agent breakdown for your Styrby team.',
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TeamCostsPageProps {
  params: Promise<{ teamId: string }>;
  searchParams: Promise<{ days?: string }>;
}

/**
 * API response shape from GET /api/teams/[id]/costs.
 *
 * WHY defined here: The page component does a self-call to its own API route
 * (same as the founder dashboard pattern). Defining the type locally keeps the
 * page self-contained without adding a shared type dependency for this narrow
 * surface.
 */
interface TeamCostsApiResponse {
  members: MemberCostRow[];
  dailyByAgent: Array<{
    date: string;
    agentType: string;
    totalCostUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
  }>;
  projection: TeamProjectionData | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validates and normalises the ?days query param.
 *
 * @param raw - Raw string from searchParams (may be undefined)
 * @returns 7 | 30 | 90 (default 30)
 */
function parseDays(raw: string | undefined): 7 | 30 | 90 {
  const n = Number(raw);
  if (n === 7 || n === 30 || n === 90) return n;
  return 30;
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

/**
 * Team Cost Analytics page.
 *
 * /dashboard/team/[teamId]/costs
 *
 * Server component that fetches team cost data and delegates rendering to
 * focused sub-components. Page stays under 400 lines per CLAUDE.md.
 *
 * Architecture (orchestrator pattern):
 *   - Server fetches data via self-call to /api/teams/[id]/costs
 *   - Passes serialised data to TeamMemberCostTable, TeamAgentStackedBarDynamic,
 *     TeamBudgetProjection (all receive data as props — no client fetching)
 *
 * Access control:
 *   - Requires authenticated user
 *   - User must be a member of the team (enforced by the API route + RLS)
 *   - Team must have Power/Team/Business billing tier
 *
 * WHY self-call (not direct DB): The cost data requires createAdminClient()
 * (service-role) to read mv_team_cost_summary outside RLS. The API route owns
 * that client, so the page fetches from it rather than duplicating the logic.
 *
 * @param props - Page props (params: teamId, searchParams: days)
 */
export default async function TeamCostsPage({ params, searchParams }: TeamCostsPageProps) {
  const { teamId } = await params;
  const { days: daysRaw } = await searchParams;
  const days = parseDays(daysRaw);

  // Auth gate
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    redirect('/login');
  }

  // Verify team membership and get the user's role for the isAdminView prop.
  // WHY here (not just in the API route): The page needs the role to decide
  // whether to show email addresses in the member table. The API route also
  // verifies membership independently — defence in depth.
  const { data: membership } = await supabase
    .from('team_members')
    .select('role')
    .eq('team_id', teamId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!membership) {
    // Not a member — redirect to the team list page
    redirect('/dashboard/team');
  }

  const isAdminView = membership.role === 'owner' || membership.role === 'admin';

  // Fetch cost data via self-call (same pattern as founder dashboard)
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  let costsData: TeamCostsApiResponse | null = null;
  let fetchError: string | null = null;

  try {
    const response = await fetch(
      `${baseUrl}/api/teams/${teamId}/costs?days=${days}`,
      {
        headers: { Cookie: cookieHeader },
        // WHY no-store: team cost data changes with every session; caching
        // would show stale spend and break the "am I over budget?" question.
        cache: 'no-store',
      }
    );

    if (!response.ok) {
      if (response.status === 403) {
        redirect('/dashboard/team');
      }
      if (response.status === 404) {
        redirect('/dashboard/team');
      }
      const body = await response.json().catch(() => ({}));
      fetchError = (body as { message?: string; error?: string }).message
        ?? (body as { error?: string }).error
        ?? `HTTP ${response.status}`;
    } else {
      costsData = (await response.json()) as TeamCostsApiResponse;
    }
  } catch (err) {
    fetchError = err instanceof Error ? err.message : 'Failed to fetch team costs';
  }

  // Compute team total from members array
  const teamTotal = (costsData?.members ?? []).reduce(
    (sum, m) => sum + m.totalCostUsd,
    0
  );

  // Time range navigation links
  const dayOptions: { label: string; value: number }[] = [
    { label: '7D', value: 7 },
    { label: '30D', value: 30 },
    { label: '90D', value: 90 },
  ];

  return (
    <div>
      {/* Page header */}
      <div className="flex flex-col gap-3 mb-8 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Link
              href={`/dashboard/team/${teamId}`}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Team
            </Link>
            <span className="text-muted-foreground/40 text-xs">/</span>
            <span className="text-xs text-foreground font-medium">Cost Analytics</span>
          </div>
          <h1 className="text-2xl font-bold text-foreground">Team Cost Analytics</h1>
        </div>

        {/* Time range selector */}
        <div className="flex items-center gap-1 rounded-lg border border-border/60 p-0.5 w-fit">
          {dayOptions.map(({ label, value }) => (
            <Link
              key={value}
              href={`/dashboard/team/${teamId}/costs?days=${value}`}
              className={[
                'px-3 py-1.5 text-xs font-medium rounded-md transition-colors',
                days === value
                  ? 'bg-foreground/10 text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              ].join(' ')}
            >
              {label}
            </Link>
          ))}
        </div>
      </div>

      {/* Error state */}
      {fetchError && (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-5 py-4 mb-6">
          <p className="text-sm font-medium text-destructive">Failed to load team costs</p>
          <p className="text-xs text-muted-foreground mt-1">{fetchError}</p>
        </div>
      )}

      {/* MTD vs budget projection card */}
      {costsData?.projection && (
        <div className="mb-6">
          <TeamBudgetProjection projection={costsData.projection} />
        </div>
      )}

      {/* Per-agent stacked bar chart */}
      {costsData && costsData.dailyByAgent.length > 0 && (
        <section className="mb-8" aria-label="Team cost by agent over time">
          <h2 className="text-lg font-semibold text-foreground mb-4">
            Cost by Agent
          </h2>
          <TeamAgentStackedBarDynamic
            dailyByAgent={costsData.dailyByAgent}
            days={days}
          />
        </section>
      )}

      {/* Per-member cost table */}
      <section aria-label="Team cost by member">
        <h2 className="text-lg font-semibold text-foreground mb-4">
          Cost by Member
        </h2>
        <TeamMemberCostTable
          members={costsData?.members ?? []}
          teamTotal={teamTotal}
          days={days}
          isAdminView={isAdminView}
        />
      </section>

      {/* Footer note */}
      {costsData && (
        <p className="text-xs text-muted-foreground/60 mt-4">
          Cost data updated hourly. Last 24h sessions may not yet be reflected.
        </p>
      )}
    </div>
  );
}
