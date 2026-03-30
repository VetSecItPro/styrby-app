// WHY: force-dynamic ensures this page is always server-rendered at request time.
// The dashboard shows live user-specific data (sessions, spend, machines) that
// must never be statically cached - stale data would show wrong costs and status.
export const dynamic = 'force-dynamic';

import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { DashboardRealtime } from './dashboard-realtime';

export const metadata: Metadata = {
  title: 'Dashboard | Styrby',
  description: "Your Styrby dashboard — live session overview, today's AI spend, machine status, and quick actions.",
};

/**
 * Dashboard home page - shows overview of sessions, costs, and quick actions.
 *
 * WHY DashboardRealtime wrapper: The dashboard shows live statistics that
 * should update in real-time:
 * - Today's spend increases as AI agents are used
 * - Active session count changes as sessions start/end
 * - Machine online status updates as devices connect/disconnect
 *
 * The server component fetches initial data for fast SSR, then the client
 * component subscribes to Supabase Realtime for live updates.
 */
export default async function DashboardPage() {
  const supabase = await createClient();

  // Get current user
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    redirect('/login');
  }

  // Fetch user's recent sessions
  const { data: sessions } = await supabase
    .from('sessions')
    .select('id, title, agent_type, status, total_cost_usd, message_count, created_at')
    .order('created_at', { ascending: false })
    .limit(5);

  // Fetch today's spend
  // WHY: .limit(1000) prevents unbounded memory on high-volume users with many records today.
  // 1000 records per day is well above typical usage and safe for serverless functions.
  const today = new Date().toISOString().split('T')[0];
  const { data: todayCosts } = await supabase
    .from('cost_records')
    .select('cost_usd')
    .gte('record_date', today)
    .limit(1000);

  const todaySpend = todayCosts?.reduce((sum, r) => sum + Number(r.cost_usd), 0) || 0;

  // Fetch user's machines and subscription tier in parallel
  // WHY: Tier is needed to gate the activity graph (Pro+) and cloud tasks panel
  // (Power) in the dashboard. Fetching in parallel keeps the page fast.
  const [machinesResult, subscriptionResult] = await Promise.all([
    supabase
      .from('machines')
      .select('id, name, is_online, last_seen_at')
      .order('last_seen_at', { ascending: false }),
    supabase
      .from('subscriptions')
      .select('tier')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .maybeSingle(),
  ]);

  const machines = machinesResult.data;
  const userTier = (subscriptionResult.data?.tier as 'free' | 'pro' | 'power') || 'free';

  return (
    <DashboardRealtime
      initialSessions={sessions || []}
      initialTodaySpend={todaySpend}
      initialMachines={machines || []}
      userId={user.id}
      userTier={userTier}
    />
  );
}
