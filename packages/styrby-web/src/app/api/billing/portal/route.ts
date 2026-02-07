/**
 * Customer Portal API Route
 *
 * Redirects to Polar customer portal for subscription management.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';

export async function GET(request: NextRequest) {
  // FIX-047: Add rate limiting to billing portal redirect
  const { allowed, retryAfter } = rateLimit(request, RATE_LIMITS.standard, 'billing-portal');
  if (!allowed) {
    return rateLimitResponse(retryAfter!);
  }

  try {
    const supabase = await createClient();

    // Get authenticated user
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.redirect(new URL('/login', request.url));
    }

    // Get user's subscription from database
    const { data: subscription } = await supabase
      .from('subscriptions')
      .select('polar_subscription_id, polar_customer_id')
      .eq('user_id', user.id)
      .single();

    if (!subscription?.polar_customer_id) {
      // No subscription, redirect to settings
      return NextResponse.redirect(new URL('/settings', request.url));
    }

    // Redirect to Polar customer portal
    // Note: Polar's customer portal URL structure
    const portalUrl = `https://polar.sh/purchases`;

    return NextResponse.redirect(portalUrl);
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error('Portal error:', isDev ? error : (error instanceof Error ? error.message : 'Unknown error'));
    return NextResponse.redirect(new URL('/settings', request.url));
  }
}
