import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { SessionsRealtime } from './sessions-realtime';

/**
 * Sessions page - lists all user sessions with filtering and search.
 *
 * Server component that fetches session data from Supabase.
 * Delegates the interactive search, filter, real-time updates, and list
 * rendering to the SessionsRealtime client component wrapper.
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

  // Fetch all sessions (up to 50, newest first)
  const { data: sessions } = await supabase
    .from('sessions')
    .select('id, title, agent_type, status, total_cost_usd, message_count, created_at, summary, tags')
    .order('created_at', { ascending: false })
    .limit(50);

  return <SessionsRealtime initialSessions={sessions || []} userId={user.id} />;
}
