import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { DashboardRealtime } from './dashboard-realtime';

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
  const today = new Date().toISOString().split('T')[0];
  const { data: todayCosts } = await supabase
    .from('cost_records')
    .select('cost_usd')
    .gte('record_date', today);

  const todaySpend = todayCosts?.reduce((sum, r) => sum + Number(r.cost_usd), 0) || 0;

  // Fetch user's machines
  const { data: machines } = await supabase
    .from('machines')
    .select('id, name, is_online, last_seen_at')
    .order('last_seen_at', { ascending: false });

  return (
    <DashboardRealtime
      initialSessions={sessions || []}
      initialTodaySpend={todaySpend}
      initialMachines={machines || []}
      userId={user.id}
    />
  );
}
