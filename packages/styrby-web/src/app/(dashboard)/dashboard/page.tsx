import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { DashboardRealtime } from './dashboard-realtime';

/**
 * Dashboard home page - shows overview of sessions, costs, and quick actions.
 * Protected route - requires authentication.
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
                className="text-sm font-medium text-orange-500"
              >
                Dashboard
              </Link>
              <Link
                href="/sessions"
                className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
              >
                Sessions
              </Link>
              <Link
                href="/costs"
                className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
              >
                Costs
              </Link>
              <Link
                href="/settings"
                className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
              >
                Settings
              </Link>
            </nav>

            <div className="flex items-center gap-4">
              <span className="text-sm text-zinc-400">
                {user.email}
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
        <h1 className="text-2xl font-bold text-zinc-100 mb-8">Dashboard</h1>

        {/* Real-time dashboard content */}
        <DashboardRealtime
          initialSessions={sessions || []}
          initialTodaySpend={todaySpend}
          initialMachines={machines || []}
          userId={user.id}
        />
      </main>
    </div>
  );
}
