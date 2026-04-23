/**
 * Referral Landing Page
 *
 * /r/[code]
 *
 * Server component that validates a referral code, sets an HttpOnly cookie,
 * and redirects to the signup page with the referrer's display name pre-filled
 * in a banner.
 *
 * WHY server component with redirect: We need to set an HttpOnly cookie
 * (not accessible to client JS) before sending the user to signup. Server
 * components can set cookies via the Next.js cookies() API + redirect().
 *
 * WHY 30-day cookie: Matches the referral_events.expires_at generated column
 * (clicked_at + 30 days). Users who land via a referral link have 30 days
 * to complete signup before the referral expires.
 *
 * @param params.code - The referral code from the URL path segment
 */

import { createAdminClient } from '@/lib/supabase/server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { Metadata } from 'next';

interface Props {
  params: Promise<{ code: string }>;
}

/**
 * Dynamic Open Graph metadata — shows the referrer's name in the link preview.
 *
 * @param params - Route params containing the referral code
 * @returns Next.js Metadata object
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { code } = await params;
  const supabase = createAdminClient();

  const { data: profile } = await supabase
    .from('profiles')
    .select('display_name')
    .eq('referral_code', code.toUpperCase())
    .is('deleted_at', null)
    .maybeSingle();

  const referrerName = profile?.display_name ?? 'a Styrby user';

  return {
    title: `${referrerName} invited you to Styrby`,
    description:
      'Track your AI coding agent spend, sessions, and productivity - all in one mobile dashboard.',
    openGraph: {
      title: `${referrerName} invited you to Styrby`,
      description:
        'Track your AI coding agent spend, sessions, and productivity - all in one mobile dashboard.',
      type: 'website',
    },
  };
}

/**
 * Referral landing page server component.
 *
 * Validates the referral code, sets a 30-day HttpOnly referral cookie,
 * and redirects to /signup with ref + invited_by query params.
 * Invalid codes redirect to /signup without params.
 *
 * @param params - Route params containing the referral code
 */
export default async function ReferralPage({ params }: Props) {
  const { code } = await params;
  const supabase = createAdminClient();

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, display_name, deleted_at')
    .eq('referral_code', code.toUpperCase())
    .maybeSingle();

  // Invalid or deleted referrer - redirect to signup without referral context
  if (!profile || profile.deleted_at) {
    redirect('/signup');
  }

  // Set HttpOnly referral cookie — lasts 30 days to match referral expiry
  // WHY HttpOnly: Prevents client-side JS from reading/tampering with the code.
  // The POST /api/referral route reads this cookie server-side only.
  const cookieStore = await cookies();
  cookieStore.set('styrby_referral_code', code.toUpperCase(), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30 days
    secure: process.env.NODE_ENV === 'production',
  });

  const invitedBy = encodeURIComponent(profile.display_name ?? 'a Styrby user');
  const refCode = encodeURIComponent(code.toUpperCase());

  redirect(`/signup?ref=${refCode}&invited_by=${invitedBy}`);
}
