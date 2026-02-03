import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';

/**
 * Dashboard home page - shows overview of sessions, costs, and quick actions.
 * Protected route - requires authentication.
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

        {/* Stats grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {/* Today's spend */}
          <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
            <p className="text-sm text-zinc-500">Today&apos;s Spend</p>
            <p className="text-2xl font-bold text-zinc-100 mt-1">
              ${todaySpend.toFixed(2)}
            </p>
          </div>

          {/* Active sessions */}
          <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
            <p className="text-sm text-zinc-500">Active Sessions</p>
            <p className="text-2xl font-bold text-zinc-100 mt-1">
              {sessions?.filter((s) => ['running', 'idle'].includes(s.status)).length || 0}
            </p>
          </div>

          {/* Connected machines */}
          <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
            <p className="text-sm text-zinc-500">Connected Machines</p>
            <p className="text-2xl font-bold text-zinc-100 mt-1">
              {machines?.filter((m) => m.is_online).length || 0}
            </p>
          </div>

          {/* Total machines */}
          <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
            <p className="text-sm text-zinc-500">Total Machines</p>
            <p className="text-2xl font-bold text-zinc-100 mt-1">
              {machines?.length || 0}
            </p>
          </div>
        </div>

        {/* Recent sessions */}
        <div className="rounded-xl bg-zinc-900 border border-zinc-800">
          <div className="px-4 py-3 border-b border-zinc-800">
            <h2 className="font-semibold text-zinc-100">Recent Sessions</h2>
          </div>

          {sessions && sessions.length > 0 ? (
            <ul className="divide-y divide-zinc-800">
              {sessions.map((session) => (
                <li key={session.id} className="px-4 py-3 hover:bg-zinc-800/50 transition-colors">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      {/* Agent badge */}
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                          session.agent_type === 'claude'
                            ? 'bg-orange-500/10 text-orange-400'
                            : session.agent_type === 'codex'
                              ? 'bg-green-500/10 text-green-400'
                              : 'bg-blue-500/10 text-blue-400'
                        }`}
                      >
                        {session.agent_type}
                      </span>

                      {/* Session title */}
                      <span className="text-zinc-100">
                        {session.title || 'Untitled session'}
                      </span>

                      {/* Status indicator */}
                      <span
                        className={`h-2 w-2 rounded-full ${
                          session.status === 'running'
                            ? 'bg-green-500 animate-pulse'
                            : session.status === 'idle'
                              ? 'bg-yellow-500'
                              : 'bg-zinc-500'
                        }`}
                      />
                    </div>

                    <div className="flex items-center gap-4 text-sm text-zinc-500">
                      <span>{session.message_count} messages</span>
                      <span>${Number(session.total_cost_usd).toFixed(4)}</span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-4 py-8 text-center text-zinc-500">
              <p>No sessions yet.</p>
              <p className="mt-1 text-sm">
                Install the CLI and start a session to see it here.
              </p>
            </div>
          )}
        </div>

        {/* Machines list */}
        <div className="mt-8 rounded-xl bg-zinc-900 border border-zinc-800">
          <div className="px-4 py-3 border-b border-zinc-800">
            <h2 className="font-semibold text-zinc-100">Your Machines</h2>
          </div>

          {machines && machines.length > 0 ? (
            <ul className="divide-y divide-zinc-800">
              {machines.map((machine) => (
                <li key={machine.id} className="px-4 py-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span
                        className={`h-2 w-2 rounded-full ${
                          machine.is_online ? 'bg-green-500' : 'bg-zinc-500'
                        }`}
                      />
                      <span className="text-zinc-100">{machine.name}</span>
                    </div>
                    <span className="text-sm text-zinc-500">
                      {machine.is_online
                        ? 'Online'
                        : `Last seen ${new Date(machine.last_seen_at).toLocaleDateString()}`}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-4 py-8 text-center text-zinc-500">
              <p>No machines registered.</p>
              <p className="mt-1 text-sm">
                Run <code className="text-orange-500">styrby auth</code> on your development machine to get started.
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
