import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';

/**
 * Sessions page - lists all user sessions with filtering and search.
 */
export default async function SessionsPage() {
  const supabase = await createClient();

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    redirect('/login');
  }

  // Fetch all sessions
  const { data: sessions } = await supabase
    .from('sessions')
    .select('id, title, agent_type, status, total_cost_usd, message_count, created_at, summary, tags')
    .order('created_at', { ascending: false })
    .limit(50);

  // Group sessions by date
  const sessionsByDate = (sessions || []).reduce(
    (acc, session) => {
      const date = new Date(session.created_at).toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
      if (!acc[date]) {
        acc[date] = [];
      }
      acc[date].push(session);
      return acc;
    },
    {} as Record<string, typeof sessions>
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
                href="/sessions"
                className="text-sm font-medium text-orange-500"
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
              <span className="text-sm text-zinc-400">{user.email}</span>
            </div>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-2xl font-bold text-zinc-100">Sessions</h1>

          {/* Search and filters */}
          <div className="flex items-center gap-4">
            <input
              type="text"
              placeholder="Search sessions..."
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
            />
            <select className="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-100 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500">
              <option value="all">All Agents</option>
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
              <option value="gemini">Gemini</option>
            </select>
          </div>
        </div>

        {/* Sessions list grouped by date */}
        {Object.keys(sessionsByDate).length > 0 ? (
          <div className="space-y-8">
            {Object.entries(sessionsByDate).map(([date, dateSessions]) => (
              <div key={date}>
                <h2 className="text-sm font-medium text-zinc-500 mb-3">{date}</h2>
                <div className="rounded-xl bg-zinc-900 border border-zinc-800 divide-y divide-zinc-800">
                  {dateSessions?.map((session) => (
                    <Link
                      key={session.id}
                      href={`/sessions/${session.id}`}
                      className="block px-4 py-4 hover:bg-zinc-800/50 transition-colors"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-3 mb-1">
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

                            {/* Tags */}
                            {session.tags &&
                              session.tags.slice(0, 3).map((tag: string) => (
                                <span
                                  key={tag}
                                  className="inline-flex items-center rounded-full px-2 py-0.5 text-xs bg-zinc-800 text-zinc-400"
                                >
                                  {tag}
                                </span>
                              ))}
                          </div>

                          {/* Title */}
                          <h3 className="text-zinc-100 font-medium">
                            {session.title || 'Untitled session'}
                          </h3>

                          {/* Summary */}
                          {session.summary && (
                            <p className="text-sm text-zinc-500 mt-1 line-clamp-2">
                              {session.summary}
                            </p>
                          )}
                        </div>

                        <div className="flex flex-col items-end gap-1 text-sm text-zinc-500 ml-4">
                          <span>{session.message_count} messages</span>
                          <span>${Number(session.total_cost_usd).toFixed(4)}</span>
                          <span>
                            {new Date(session.created_at).toLocaleTimeString('en-US', {
                              hour: 'numeric',
                              minute: '2-digit',
                            })}
                          </span>
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-xl bg-zinc-900 border border-zinc-800 px-4 py-16 text-center">
            <div className="mx-auto h-12 w-12 rounded-full bg-zinc-800 flex items-center justify-center mb-4">
              <svg
                className="h-6 w-6 text-zinc-500"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                />
              </svg>
            </div>
            <h3 className="text-lg font-medium text-zinc-100">No sessions yet</h3>
            <p className="mt-2 text-zinc-500">
              Start a session with your AI coding agent to see it here.
            </p>
            <p className="mt-1 text-sm text-zinc-600">
              Run <code className="text-orange-500">styrby chat</code> to get started.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
