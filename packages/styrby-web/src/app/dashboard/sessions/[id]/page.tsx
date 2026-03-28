/**
 * Session detail page - displays chat history and enables interaction.
 *
 * Server component that fetches session data and messages from Supabase,
 * then delegates real-time updates and interaction to client components.
 * Supports both live chat mode for active sessions and replay mode for
 * completed sessions (Pro+ users only).
 *
 * @route GET /sessions/:id
 * @auth Required - redirects to /login if not authenticated
 */

import { createClient } from '@/lib/supabase/server';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { SessionView } from './session-view';
import { SessionTagEditor } from './session-tags';
import { ContextBreakdown } from '@/components/context-breakdown';
import { SessionExportButton } from './session-export-button';

/**
 * Props for the session detail page.
 */
interface SessionPageProps {
  /** Route params containing the session ID */
  params: Promise<{ id: string }>;
}

/**
 * Renders the session detail page with chat thread and input.
 *
 * WHY: The page is a server component for initial data fetching,
 * then hands off to client components for real-time updates.
 * This gives us fast initial load + live updates.
 *
 * @param props - Page props with session ID in params
 */
export default async function SessionPage({ params }: SessionPageProps) {
  const { id } = await params;
  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    redirect('/login');
  }

  // Fetch session with ownership check (RLS enforces user_id = auth.uid())
  const { data: session, error: sessionError } = await supabase
    .from('sessions')
    .select('*')
    .eq('id', id)
    .single();

  if (sessionError || !session) {
    notFound();
  }

  // Fetch messages in chronological order
  // WHY: .limit(500) prevents unbounded memory usage on sessions with thousands of messages.
  // 500 messages covers the vast majority of sessions without hitting serverless limits.
  const { data: messages } = await supabase
    .from('session_messages')
    .select('*')
    .eq('session_id', id)
    .order('sequence_number', { ascending: true })
    .limit(500);

  // Fetch user's subscription tier for feature gating
  const { data: subscription } = await supabase
    .from('subscriptions')
    .select('tier')
    .eq('user_id', user.id)
    .single();

  const userTier = (subscription?.tier as 'free' | 'pro' | 'power') || 'free';

  // Determine if session is active for the header status display
  const isSessionActive = ['starting', 'running', 'idle', 'paused'].includes(
    session.status
  );

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col bg-zinc-950">
      {/* Header with session info */}
      <header className="border-b border-zinc-800 bg-zinc-900/50 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link
              href="/dashboard/sessions"
              className="text-zinc-400 hover:text-zinc-100 transition-colors"
              aria-label="Back to sessions"
            >
              <svg
                className="h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
            </Link>

            <div>
              <h1 className="text-xl font-semibold text-zinc-100">
                {session.title || 'Untitled Session'}
              </h1>
              <div className="flex items-center gap-3 text-sm text-zinc-400">
                {/* Agent badge */}
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                    session.agent_type === 'claude'
                      ? 'bg-orange-500/10 text-orange-400'
                      : session.agent_type === 'codex'
                        ? 'bg-green-500/10 text-green-400'
                        : session.agent_type === 'gemini'
                          ? 'bg-blue-500/10 text-blue-400'
                          : session.agent_type === 'opencode'
                            ? 'bg-purple-500/10 text-purple-400'
                            : session.agent_type === 'aider'
                              ? 'bg-pink-500/10 text-pink-400'
                              : session.agent_type === 'goose'
                                ? 'bg-teal-500/10 text-teal-400'
                                : session.agent_type === 'amp'
                                  ? 'bg-amber-500/10 text-amber-400'
                                  : 'bg-zinc-500/10 text-zinc-400'
                  }`}
                >
                  {session.agent_type}
                </span>

                {/* Status indicator */}
                <span className="flex items-center gap-1">
                  <span
                    className={`h-2 w-2 rounded-full ${
                      isSessionActive
                        ? session.status === 'running'
                          ? 'bg-green-500 animate-pulse'
                          : 'bg-yellow-500'
                        : 'bg-zinc-500'
                    }`}
                  />
                  {session.status}
                </span>

                <span>
                  Started{' '}
                  {new Date(session.created_at).toLocaleString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </span>

                <span>${Number(session.total_cost_usd).toFixed(4)}</span>
              </div>
            </div>
          </div>

          {/* Session actions */}
          <div className="flex items-center gap-2">
            {session.project_path && (
              <span
                className="text-xs text-zinc-500 font-mono max-w-[200px] truncate"
                title={session.project_path}
              >
                {session.project_path}
              </span>
            )}
            {/* Export button — client component that downloads session as JSON */}
            <SessionExportButton
              session={session}
              messages={messages ?? []}
            />
          </div>
        </div>

        {/* Tag editor row */}
        {/* WHY: Tags appear in the header so users can quickly tag or re-tag sessions
            for cost attribution. This is the primary touchpoint for retroactive tagging
            after a session completes, which is the most common workflow for freelancers
            billing multiple clients. */}
        <div className="mt-3 flex items-center gap-2">
          <span className="text-xs text-zinc-500 shrink-0">Tags:</span>
          <SessionTagEditor
            sessionId={session.id}
            initialTags={(session.tags as string[]) ?? []}
          />
        </div>
      </header>

      {/* Main content: chat/replay view + sidebar panels */}
      <div className="flex flex-1 min-h-0">
        {/* Session chat / replay (takes remaining width) */}
        <div className="flex-1 min-w-0">
          <SessionView
            session={session}
            messages={messages || []}
            userId={user.id}
            userTier={userTier}
          />
        </div>

        {/* Right sidebar: Context Budget (collapsed when session is active) */}
        {/* WHY: The context breakdown is most useful for completed sessions where
            users review what the agent loaded. For active sessions it would show
            stale data, so we surface it only when the session is done. */}
        {!isSessionActive && (
          <aside className="hidden lg:flex w-80 shrink-0 flex-col gap-4 overflow-y-auto border-l border-zinc-800 bg-zinc-950 p-4">
            {/* Context budget breakdown
                WHY: context_breakdown is not a Supabase column — it is streamed
                from the CLI via the relay and stored client-side. For now we
                render the empty state on the server; a future real-time hook
                will hydrate this once the relay delivers the breakdown. */}
            <ContextBreakdown breakdown={null} />
          </aside>
        )}
      </div>
    </div>
  );
}
