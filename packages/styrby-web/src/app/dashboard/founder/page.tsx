// WHY force-dynamic: Founder metrics aggregate live subscription + session data.
// Caching would show stale MRR and funnel numbers — unacceptable for business decisions.
export const dynamic = 'force-dynamic';

import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/admin';
// WHY: calcRunRate / normalizeTier are not used directly in this page —
// the metrics are computed in /api/admin/founder-metrics. The import is kept
// to document the dependency boundary and will be used if we add client-side
// projections in a future iteration. Remove if still unused at Phase 2.
// import { calcRunRate, normalizeTier } from '@styrby/shared';
import { MrrCard, FunnelChart, TierMixTable, CohortRetentionTable, TeamsCard, ErrorClassHistogramDynamic, ForecastQualityCard } from '@/components/dashboard/founder';
import type { FounderTeamMetrics } from '@styrby/shared';
import type { ErrorHistogramDay } from '@/components/dashboard/founder';

export const metadata: Metadata = {
  title: 'Founder Ops | Styrby',
  description: 'MRR, ARR, churn, LTV, cohort retention, and funnel analytics for Styrby founders.',
};

/**
 * Founder Ops Dashboard page.
 *
 * Server-gated to users with is_admin = true (currently vetsecitpro@gmail.com only).
 *
 * WHY server component: All data fetching uses the service-role Supabase client
 * (createAdminClient via the API route). The page calls its own API route so the
 * service-role key is never exposed to the browser. The page is a pure SSR
 * orchestrator that passes serialised data to display components.
 *
 * WHY /dashboard/founder (not /admin/founder): The founder dashboard is a business
 * intelligence view for the product owner, not a support/moderation admin panel.
 * Co-locating it under /dashboard keeps the nav structure flat and signals its
 * audience clearly.
 *
 * Sections:
 *   1. MRR / ARR / churn / LTV
 *   2. Tier mix + agent usage distribution
 *   3. Onboarding funnel
 *   4. Cohort retention table
 *
 * @returns Server-rendered founder ops page
 */
export default async function FounderPage() {
  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    redirect('/login');
  }

  // Gate: only admins may view this page.
  // WHY server-side: Client-side role checks can be bypassed by toggling JS.
  // Server-side redirect + API-level 403 = defence in depth.
  const adminOk = await isAdmin(user.id);
  if (!adminOk) {
    redirect('/dashboard');
  }

  // Fetch metrics from the API route (which uses service-role internally).
  // WHY self-call: The metrics logic lives in the API route so it can also be
  // consumed by external tooling (e.g. a scheduled Slack digest). We call it
  // from the page server component rather than duplicating the logic here.
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  let metrics: Awaited<typeof import('@/app/api/admin/founder-metrics/route').GET> extends Promise<Response> ? Record<string, unknown> : never;

  type FounderMetrics = {
    mrrUsd: number;
    arrUsd: number;
    churnRate30d: number | null;
    churnRate90d: number | null;
    avgLtvUsd: number | null;
    tierMix: { tier: string; count: number }[];
    agentUsage: { agentType: string; sessionCount: number; totalCostUsd: number }[];
    funnel: { step: string; count: number; conversionFromPrev: number | null }[];
    cohortRetention: {
      cohortMonth: string;
      cohortSize: number;
      retention30d: number | null;
      retention90d: number | null;
    }[];
    computedAt: string;
  };

  let data: FounderMetrics | null = null;
  let fetchError: string | null = null;
  let teamMetrics: FounderTeamMetrics | null = null;
  // Phase 2.5 (absorbs 1.6.7b): error class histogram data (non-fatal if absent)
  let errorHistogram: ErrorHistogramDay[] = [];

  try {
    // Forward the cookie header so the API route can verify the auth session.
    const { cookies } = await import('next/headers');
    const cookieStore = await cookies();
    const cookieHeader = cookieStore.getAll()
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');

    // Fetch core metrics, team metrics, and error histogram in parallel.
    // WHY parallel: all three are independent admin-gated queries; serial fetches
    // would triple server-render latency for the founder dashboard.
    // WHY histogram is non-fatal: it uses the audit_log table which may have
    // no rows in early production (no errors yet). The dashboard should still
    // render MRR and funnel data if the histogram query fails or returns empty.
    const [metricsResponse, teamMetricsResponse, histogramResponse] = await Promise.all([
      fetch(`${baseUrl}/api/admin/founder-metrics`, {
        headers: { Cookie: cookieHeader },
        // WHY no-store: We want live data every render, not a cached response.
        cache: 'no-store',
      }),
      fetch(`${baseUrl}/api/admin/founder-team-metrics`, {
        headers: { Cookie: cookieHeader },
        cache: 'no-store',
      }),
      fetch(`${baseUrl}/api/admin/founder-error-histogram`, {
        headers: { Cookie: cookieHeader },
        cache: 'no-store',
      }),
    ]);

    if (!metricsResponse.ok) {
      const body = await metricsResponse.json().catch(() => ({}));
      fetchError = (body as { message?: string }).message ?? `HTTP ${metricsResponse.status}`;
    } else {
      data = (await metricsResponse.json()) as FounderMetrics;
    }

    // Team metrics failure is non-fatal — page still shows core metrics.
    if (teamMetricsResponse.ok) {
      teamMetrics = (await teamMetricsResponse.json()) as FounderTeamMetrics;
    }

    // Error histogram failure is non-fatal.
    // WHY: A missing or empty histogram is normal in early production.
    // The chart shows "No errors logged" empty state which is a positive signal.
    if (histogramResponse.ok) {
      const histBody = (await histogramResponse.json()) as { histogram?: ErrorHistogramDay[] };
      errorHistogram = histBody.histogram ?? [];
    }
  } catch (err) {
    fetchError = err instanceof Error ? err.message : 'Failed to fetch founder metrics';
  }

  if (fetchError || !data) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
        <p className="text-foreground font-semibold">Failed to load founder metrics</p>
        <p className="text-muted-foreground text-sm">{fetchError ?? 'Unknown error'}</p>
      </div>
    );
  }

  return (
    <div>
      {/* Page header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-foreground">Founder Ops</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Last computed: {new Date(data.computedAt).toLocaleString()}
        </p>
      </div>

      {/* Row 1: MRR / ARR / churn / LTV */}
      <MrrCard
        mrrUsd={data.mrrUsd}
        arrUsd={data.arrUsd}
        churnRate30d={data.churnRate30d}
        churnRate90d={data.churnRate90d}
        avgLtvUsd={data.avgLtvUsd}
      />

      {/* Row 2: Tier mix + Agent usage */}
      <div className="mt-6">
        <TierMixTable
          tierMix={data.tierMix}
          agentUsage={data.agentUsage}
        />
      </div>

      {/* Row 3: Funnel */}
      <div className="mt-6">
        <FunnelChart steps={data.funnel} />
      </div>

      {/* Row 4: Cohort retention */}
      <div className="mt-6">
        <CohortRetentionTable cohorts={data.cohortRetention} />
      </div>

      {/* Row 5: Teams — Phase 2.3 */}
      {teamMetrics && (
        <div className="mt-6">
          <TeamsCard metrics={teamMetrics} />
        </div>
      )}

      {/* Row 6: Error-class histogram — Phase 2.5 (absorbs 1.6.7b)
          WHY here (below teams, above the fold break):
            Business metrics (MRR, funnel, cohorts) are the primary read for
            the founder. Error trends are secondary — product health context.
            Placing the histogram at the bottom of the dashboard keeps the
            primary read uncluttered while making errors discoverable on scroll.
          WHY always rendered (not gated on errorHistogram.length > 0):
            The ErrorClassHistogramDynamic renders its own "No errors" empty
            state, which is itself a meaningful signal (healthy system). Hiding
            the card entirely when there are no errors would hide that signal. */}
      <div className="mt-6 mb-4">
        <h2 className="text-lg font-semibold text-foreground mb-4">System Error Trends</h2>
        <ErrorClassHistogramDynamic data={errorHistogram} />
      </div>

      {/* Row 7: Forecast quality — Phase 3.4
          WHY here (below error histogram):
            Forecast quality is a product-health signal for the predictive alert
            system. It answers "are we actually warning users in time?" and is
            owned by the same founder audience as MRR and error trends.
            Placing it at the bottom maintains the primary → secondary → health
            information hierarchy. */}
      <div className="mt-6 mb-8">
        <h2 className="text-lg font-semibold text-foreground mb-4">Forecast Alert Quality</h2>
        <ForecastQualityCard />
      </div>
    </div>
  );
}
