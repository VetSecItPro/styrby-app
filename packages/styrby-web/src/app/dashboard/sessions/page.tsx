// WHY: force-dynamic ensures this page is always server-rendered at request time.
// Session lists are user-specific and change frequently - caching would show
// stale session status and costs to the user.
export const dynamic = 'force-dynamic';

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { SessionsRealtime } from './sessions-realtime';

/**
 * Number of sessions to fetch for the initial server-side render.
 *
 * WHY: We load only the first page (20 sessions) during SSR instead of the
 * previous limit of 50. The client-side infinite scroll will fetch additional
 * pages as the user scrolls. This reduces initial payload size and aligns
 * with the mobile app's pagination behaviour.
 */
const INITIAL_PAGE_SIZE = 20;

/**
 * Sessions page - lists all user sessions with filtering and search.
 *
 * Server component that fetches session data from Supabase.
 * Delegates the interactive search, filter, real-time updates, infinite
 * scroll, scope filtering, and list rendering to the SessionsRealtime
 * client component wrapper.
 *
 * WHY SessionsRealtime wrapper: We need real-time updates for sessions
 * (new sessions appearing, status changes, cost updates) without requiring
 * a page refresh. The server component fetches initial data for fast SSR,
 * then the client component subscribes to live updates.
 *
 * NOTE: Navigation chrome (sidebar, topnav) is handled by dashboard/layout.tsx.
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

  // Fetch initial page of sessions, bookmark IDs, and team membership in
  // parallel to keep SSR as fast as possible.
  const [sessionsResult, bookmarksResult, teamCountResult] = await Promise.all([
    supabase
      .from('sessions')
      .select('id, title, agent_type, status, total_cost_usd, message_count, created_at, summary, tags')
      .eq('user_id', user.id)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(INITIAL_PAGE_SIZE),

    // WHY: We fetch only the session_id from bookmarks so the client can
    // initialise star icons without a client-side round-trip. Capped at 200
    // because even Power tier users have at most unlimited bookmarks but we
    // only show INITIAL_PAGE_SIZE sessions; this is a reasonable upper bound.
    supabase
      .from('session_bookmarks')
      .select('session_id')
      .eq('user_id', user.id)
      .limit(200),

    // Check if the user belongs to a team (determines whether scope filter is shown).
    // WHY: The scope filter (My Sessions / Team Sessions) should only be visible
    // to users who actually have a team. We check for any session with a non-null
    // team_id as a lightweight proxy - no separate team membership table needed.
    supabase
      .from('sessions')
      .select('id', { count: 'exact', head: true })
      .not('team_id', 'is', null)
      .eq('user_id', user.id)
      .limit(1),
  ]);

  const sessions = sessionsResult.data;
  const hasTeam = (teamCountResult.count ?? 0) > 0;
  const bookmarkedIds = new Set(
    (bookmarksResult.data ?? []).map((b) => b.session_id as string)
  );

  return (
    <SessionsRealtime
      initialSessions={sessions || []}
      userId={user.id}
      hasTeam={hasTeam}
      initialHasMore={(sessions?.length ?? 0) >= INITIAL_PAGE_SIZE}
      initialBookmarkedIds={bookmarkedIds}
    />
  );
}
