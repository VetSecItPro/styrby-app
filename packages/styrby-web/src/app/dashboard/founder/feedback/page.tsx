// WHY force-dynamic: Feedback data is user-generated in real time.
// Caching even for 60 seconds would show stale NPS scores to the founder.
export const dynamic = 'force-dynamic';

import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/admin';
import { NpsTab, GeneralTab, PostmortemTab } from '@/components/dashboard/founder-feedback';

export const metadata: Metadata = {
  title: 'Feedback Dashboard | Styrby Founder',
  description: 'NPS scores, in-app feedback, and session post-mortems for Styrby founders.',
};

/**
 * Founder Feedback Dashboard page.
 *
 * Tabs:
 *  1. NPS - weekly trend + promoter/passive/detractor breakdown + latest 10 comments
 *  2. General - latest 50 general feedback items
 *  3. Post-mortems - latest 50 session ratings with agent/rating filters
 *
 * WHY server component: Initial data is fetched server-side (no loading flash).
 * Subsequent auto-refresh at 60-second intervals is handled client-side in
 * each tab component.
 *
 * WHY admin gate server-side: Defense in depth. Client-side route guards can
 * be bypassed. Server redirect + API 403 = two-layer protection (SOC2 CC6.1).
 *
 * @returns Server-rendered founder feedback dashboard
 */
export default async function FounderFeedbackPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    redirect('/login');
  }

  const adminOk = await isAdmin(user.id);
  if (!adminOk) {
    redirect('/dashboard');
  }

  // ── Tab from URL ──────────────────────────────────────────────────────────
  const params = await searchParams;
  const activeTab = (params.tab as 'nps' | 'general' | 'postmortems') ?? 'nps';

  // ── Server-side data fetch ────────────────────────────────────────────────
  // WHY: Prefetch the active tab's data on the server to avoid a loading flash.
  // Other tabs will fetch client-side on first render.
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

  // Helper to call our own API route with the service-role-equivalent session
  // WHY: We can't use createAdminClient() directly in a page (client/server
  // boundary). Instead we call the API route which handles auth internally.
  // The cookie is forwarded automatically in server component fetches.
  async function fetchTab(tab: string, extra = '') {
    try {
      const res = await fetch(
        `${baseUrl}/api/admin/founder-feedback?tab=${tab}${extra}`,
        {
          headers: { cookie: (await import('next/headers')).cookies().toString() },
          cache: 'no-store',
        }
      );
      if (!res.ok) return null;
      const json = await res.json();
      return json.data;
    } catch {
      return null;
    }
  }

  // Prefetch all three tabs' data in parallel (fast server-to-server fetch)
  const [npsData, generalData, postmortemData] = await Promise.all([
    fetchTab('nps', '&weeks=12'),
    fetchTab('general'),
    fetchTab('postmortems'),
  ]);

  // Fallback shapes if fetch fails (prevents render crash)
  const safeNps = npsData ?? {
    currentNps: { score: 0, promoters: 0, passives: 0, detractors: 0, total: 0, promoterPct: 0, passivePct: 0, detractorPct: 0 },
    trend: [],
    latestComments: [],
  };
  const safeGeneral = generalData ?? { items: [], total: 0 };
  const safePostmortem = postmortemData ?? { items: [], total: 0 };

  const tabs: Array<{ id: 'nps' | 'general' | 'postmortems'; label: string }> = [
    { id: 'nps', label: 'NPS' },
    { id: 'general', label: 'General' },
    { id: 'postmortems', label: 'Post-mortems' },
  ];

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-zinc-100">Feedback Dashboard</h1>
        <p className="mt-1 text-sm text-zinc-400">
          NPS scores, in-app feedback, and session ratings from users.
        </p>
      </div>

      {/* Tab navigation */}
      <div className="mb-6 flex gap-1 rounded-lg border border-zinc-800 bg-zinc-900 p-1">
        {tabs.map(({ id, label }) => (
          <a
            key={id}
            href={`/dashboard/founder/feedback?tab=${id}`}
            className={`flex-1 rounded-md py-2 text-center text-sm font-medium transition-colors ${
              activeTab === id
                ? 'bg-indigo-600 text-white'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {label}
          </a>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'nps' && (
        <NpsTab initialData={safeNps} window="all" />
      )}
      {activeTab === 'general' && (
        <GeneralTab initialItems={safeGeneral.items} initialTotal={safeGeneral.total} />
      )}
      {activeTab === 'postmortems' && (
        <PostmortemTab initialItems={safePostmortem.items} initialTotal={safePostmortem.total} />
      )}
    </div>
  );
}
