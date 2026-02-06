/**
 * Budget Alerts Page
 *
 * Server component that fetches the user's budget alerts, current spend
 * per alert period, and subscription tier from Supabase. Passes the
 * pre-computed data to the BudgetAlertsClient for interactive rendering.
 *
 * WHY server component: The initial data fetch requires authenticated
 * Supabase queries and spend aggregation. Computing percentages server-side
 * avoids a loading flash and reduces client-side API calls on first load.
 */

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { TIERS, type TierId } from '@/lib/polar';
import { BudgetAlertsClient } from './budget-alerts-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Budget alert row from Supabase */
interface BudgetAlertRow {
  id: string;
  user_id: string;
  name: string;
  threshold_usd: number;
  period: 'daily' | 'weekly' | 'monthly';
  agent_type: 'claude' | 'codex' | 'gemini' | null;
  action: 'notify' | 'warn_and_slowdown' | 'hard_stop';
  notification_channels: string[];
  is_enabled: boolean;
  last_triggered_at: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/**
 * Calculates the start date for a given budget period.
 *
 * WHY: Duplicated from the API route because server components cannot
 * call API routes. Both need the same period boundary logic.
 *
 * @param period - The budget period (daily, weekly, monthly)
 * @returns ISO 8601 date string for the start of the period
 */
function getPeriodStartDate(period: 'daily' | 'weekly' | 'monthly'): string {
  const now = new Date();

  switch (period) {
    case 'daily': {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      return start.toISOString();
    }
    case 'weekly': {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const day = start.getUTCDay();
      const diff = day === 0 ? 6 : day - 1;
      start.setUTCDate(start.getUTCDate() - diff);
      return start.toISOString();
    }
    case 'monthly': {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      return start.toISOString();
    }
  }
}

// ---------------------------------------------------------------------------
// Page Component
// ---------------------------------------------------------------------------

export default async function BudgetAlertsPage() {
  const supabase = await createClient();

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    redirect('/login');
  }

  // Fetch alerts and subscription in parallel
  const [alertsResult, subscriptionResult] = await Promise.all([
    supabase
      .from('budget_alerts')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false }),
    supabase
      .from('subscriptions')
      .select('tier')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .single(),
  ]);

  const alerts: BudgetAlertRow[] = alertsResult.data || [];
  const tier = (subscriptionResult.data?.tier as TierId) || 'free';
  const alertLimit = TIERS[tier]?.limits.budgetAlerts ?? 0;

  // WHY: Calculate current spend for each alert's period. We do this server-side
  // so the progress bars render immediately without a second client-side fetch.
  // Each alert may have a different period and agent scope.
  const alertsWithSpend = await Promise.all(
    alerts.map(async (alert) => {
      const periodStart = getPeriodStartDate(alert.period);

      let query = supabase
        .from('cost_records')
        .select('cost_usd')
        .eq('user_id', user.id)
        .gte('recorded_at', periodStart);

      if (alert.agent_type) {
        query = query.eq('agent_type', alert.agent_type);
      }

      const { data: costData } = await query;

      const currentSpend = (costData || []).reduce(
        (sum, record) => sum + (Number(record.cost_usd) || 0),
        0
      );

      return {
        ...alert,
        // WHY: Supabase returns notification_channels as string[], but the
        // client component expects the narrower NotificationChannel[] type.
        // The CHECK constraint on the DB ensures only valid values exist.
        notification_channels: alert.notification_channels as ('push' | 'in_app' | 'email')[],
        current_spend_usd: currentSpend,
        percentage_used:
          Number(alert.threshold_usd) > 0
            ? (currentSpend / Number(alert.threshold_usd)) * 100
            : 0,
      };
    })
  );

  return (
    <div className="min-h-screen bg-zinc-950">
      {/* Header */}
      <header className="border-b border-zinc-800 bg-zinc-900/50">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            <div className="flex items-center gap-4">
              <Link href="/dashboard" className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center">
                  <span className="text-lg font-bold text-white">S</span>
                </div>
                <span className="font-semibold text-zinc-100">Styrby</span>
              </Link>
            </div>

            <nav className="flex items-center gap-6">
              <Link
                href="/dashboard"
                className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
              >
                Dashboard
              </Link>
              <Link
                href="/dashboard/sessions"
                className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
              >
                Sessions
              </Link>
              <Link href="/dashboard/costs" className="text-sm font-medium text-orange-500">
                Costs
              </Link>
              <Link
                href="/dashboard/settings"
                className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
              >
                Settings
              </Link>
            </nav>

            <div className="flex items-center gap-4">
              <span className="text-sm text-zinc-400">{user.email}</span>
            </div>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center gap-3 mb-8">
          <h1 className="text-2xl font-bold text-zinc-100">Budget Alerts</h1>
        </div>

        <BudgetAlertsClient
          initialAlerts={alertsWithSpend}
          tier={tier}
          alertLimit={alertLimit}
          alertCount={alerts.length}
        />
      </main>
    </div>
  );
}
