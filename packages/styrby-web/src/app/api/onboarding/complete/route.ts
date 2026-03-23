/**
 * Onboarding Completion Route
 *
 * Marks the authenticated user's onboarding as complete by setting
 * the `onboarding_completed_at` timestamp on their profile. Called
 * automatically when all onboarding steps are finished, or when the
 * user manually dismisses the onboarding banner.
 *
 * POST /api/onboarding/complete
 *
 * @auth Required - Supabase Auth JWT via cookie
 * @rateLimit 5 requests per minute per IP
 *
 * @returns 200 { success: true }
 *
 * @error 401 { error: 'Unauthorized' }
 * @error 429 { error: 'RATE_LIMITED', retryAfter: number }
 * @error 500 { error: 'Failed to complete onboarding' }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { rateLimit, rateLimitResponse } from '@/lib/rateLimit';

// SEC-API-001 FIX: Rate limit config for onboarding completion.
// WHY: Without rate limiting, an attacker who obtains a valid session token
// could spam this endpoint. More importantly, automated scripts could flood
// the endpoint causing unnecessary DB writes. 5 requests per minute is
// generous for a one-time operation (onboarding is completed once per user)
// while preventing any meaningful abuse.
const ONBOARDING_RATE_LIMIT = { windowMs: 60000, maxRequests: 5 };

export async function POST(request: NextRequest) {
  // SEC-API-001: Rate limit before touching auth or DB
  const { allowed, retryAfter } = await rateLimit(request, ONBOARDING_RATE_LIMIT, 'onboarding-complete');
  if (!allowed) {
    return rateLimitResponse(retryAfter!);
  }

  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // SEC-BIZ-002: Onboarding bypass risk — a user can call this endpoint
    // directly without completing any onboarding steps. We do NOT enforce a
    // strict server-side step check here because:
    // 1. Onboarding is a UX aid, not a security gate. Skipping it doesn't
    //    grant access to restricted features — those are tier-gated separately.
    // 2. The minimum meaningful step (CLI install + machine registration) is
    //    async and device-side; verifying it server-side would require polling
    //    the machines table, which adds latency and complexity for no security gain.
    // 3. Users who skip onboarding simply won't have configured their machine,
    //    which prevents them from using the core product regardless.
    // If a future requirement mandates enforced onboarding gates (e.g., "must
    // verify email before use"), that should be implemented at the auth layer,
    // not here.
    const { error: updateError } = await supabase
      .from('profiles')
      .update({ onboarding_completed_at: new Date().toISOString() })
      .eq('id', user.id);

    if (updateError) {
      console.error('Failed to mark onboarding complete:', updateError.message);
      return NextResponse.json(
        { error: 'Failed to complete onboarding' },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      'Onboarding complete POST error:',
      isDev ? error : error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json(
      { error: 'Failed to complete onboarding' },
      { status: 500 }
    );
  }
}
