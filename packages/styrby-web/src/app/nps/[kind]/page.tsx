/**
 * Web NPS Survey Page
 *
 * Route: /nps/[kind]  (kind = 'nps_7d' | 'nps_30d')
 * Query params: prompt_id (optional UUID)
 *
 * This is the web equivalent of the mobile NPS survey screen.
 * Provides parity with the mobile experience for users who click
 * the push notification on desktop or access the link via email.
 *
 * WHY web parity: CLAUDE.md mandates mobile + web parity on all
 * user-facing features. The NPS survey prompt fires via push
 * (mobile) and in-app notification (both). Users should be able
 * to respond on either surface.
 */

import type { Metadata } from 'next';
import { NpsSurveyCard } from '@/components/nps/NpsSurveyCard';

export const metadata: Metadata = {
  title: 'Share your feedback | Styrby',
  description: 'Help us improve Styrby - takes 30 seconds.',
};

/**
 * Web NPS survey page. See module doc.
 *
 * @returns Server-rendered page shell with the client NPS survey card
 */
export default async function NpsPage({
  params,
  searchParams,
}: {
  params: Promise<{ kind: string }>;
  searchParams: Promise<{ prompt_id?: string }>;
}) {
  const { kind } = await params;
  const { prompt_id: promptId } = await searchParams;

  // Validate kind
  const validKinds = ['nps_7d', 'nps_30d'];
  const safeKind = validKinds.includes(kind) ? kind : 'nps_7d';
  const window: '7d' | '30d' = safeKind === 'nps_30d' ? '30d' : '7d';

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 p-4">
      <div className="w-full max-w-md">
        <NpsSurveyCard
          window={window}
          promptId={promptId}
        />
      </div>
    </div>
  );
}
