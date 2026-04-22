/**
 * Referral Code Attribution API
 *
 * GET /api/referral?code=<referral_code>
 *   - Validate a referral code exists and is active
 *   - Return referrer display name for the landing page banner
 *   - Record a 'click' event in referral_events
 *
 * @auth None required - landing page is public
 * @rateLimit 20 requests per minute per IP
 *
 * @query code - The referral code to validate
 *
 * @returns 200 {
 *   valid: true,
 *   referrerName: string,
 *   referralCode: string
 * }
 *
 * @error 400 { error: string }
 * @error 404 { error: 'Invalid referral code' }
 * @error 429 { error: 'RATE_LIMITED', message: string, retryAfter: number }
 * @error 500 { error: 'Referral validation failed' }
 *
 * POST /api/referral
 *   - Called after signup to attribute a referred user to a referrer
 *   - Validates referral code + checks for abuse (self-referral, disposable email)
 *   - Updates referral_events to 'signup' state
 *
 * @auth Required - Supabase Auth JWT (the newly-signed-up user)
 * @rateLimit 5 requests per minute per user
 *
 * @body {
 *   referralCode: string
 * }
 *
 * @returns 200 { success: true }
 *
 * @error 400 { error: string } - Validation failure or abuse check
 * @error 401 { error: 'Unauthorized' }
 * @error 404 { error: 'Referral not found' }
 * @error 500 { error: 'Referral attribution failed' }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient, createAdminClient } from '@/lib/supabase/server';
import { rateLimit, rateLimitResponse } from '@/lib/rateLimit';
import { isDisposableEmail } from '@/lib/disposable-emails';
import { z } from 'zod';
import crypto from 'crypto';

const GetQuerySchema = z.object({
  code: z.string().min(4).max(32).regex(/^[A-Z0-9_-]+$/i, 'Invalid referral code format'),
});

const PostBodySchema = z.object({
  referralCode: z.string().min(4).max(32).regex(/^[A-Z0-9_-]+$/i, 'Invalid referral code format'),
});

/**
 * GET /api/referral?code=<code>
 * Validate referral code and return referrer name for the landing page banner.
 */
export async function GET(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0] ?? 'unknown';

  // WHY 20 req/min per IP: The GET endpoint is public and called from the
  // landing page. 20/min is generous for normal use while blocking rapid
  // enumeration of referral codes.
  const rl = await rateLimit(
    request,
    { windowMs: 60_000, maxRequests: 20 },
    `referral-validate:${ip}`
  );
  if (!rl.allowed) {
    return rateLimitResponse(rl.retryAfter ?? 60);
  }

  const { searchParams } = new URL(request.url);
  const parsed = GetQuerySchema.safeParse({ code: searchParams.get('code') ?? '' });

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.errors[0]?.message ?? 'Invalid referral code' },
      { status: 400 }
    );
  }

  const { code } = parsed.data;
  const supabase = createAdminClient();

  try {
    // Look up the referral code owner
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('id, display_name, deleted_at')
      .eq('referral_code', code.toUpperCase())
      .maybeSingle();

    if (error) {
      console.error('[referral GET] Profile lookup failed:', error.message);
      return NextResponse.json({ error: 'Referral validation failed' }, { status: 500 });
    }

    if (!profile || profile.deleted_at) {
      return NextResponse.json({ error: 'Invalid referral code' }, { status: 404 });
    }

    // Record the click in referral_events
    await supabase.from('referral_events').insert({
      referrer_user_id: profile.id,
      referral_code: code.toUpperCase(),
      status: 'click',
      referrer_ip_hash: crypto.createHash('sha256').update(ip).digest('hex'),
    });

    return NextResponse.json({
      valid: true,
      referrerName: profile.display_name ?? 'a Styrby user',
      referralCode: code.toUpperCase(),
    });
  } catch (error) {
    console.error('[referral GET] Failed:', error instanceof Error ? error.message : 'Unknown');
    return NextResponse.json({ error: 'Referral validation failed' }, { status: 500 });
  }
}

/**
 * POST /api/referral
 * Attribute a newly-signed-up user to a referrer.
 * Called from the signup flow when a referral cookie is present.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // WHY 5 req/min per user: Attribution is a one-time action per sign-up.
  // Tight limit prevents a user from attributing multiple conversions to
  // the same referral code by repeatedly calling this endpoint.
  const rl = await rateLimit(
    request,
    { windowMs: 60_000, maxRequests: 5 },
    `referral-attribute:${user.id}`
  );
  if (!rl.allowed) {
    return rateLimitResponse(rl.retryAfter ?? 60);
  }

  const body = await request.json().catch(() => null);
  const parsed = PostBodySchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.errors[0]?.message ?? 'Invalid request body' },
      { status: 400 }
    );
  }

  const { referralCode } = parsed.data;
  const adminSupabase = createAdminClient();

  try {
    // Look up referrer
    const { data: referrer, error: referrerError } = await adminSupabase
      .from('profiles')
      .select('id, deleted_at')
      .eq('referral_code', referralCode.toUpperCase())
      .maybeSingle();

    if (referrerError || !referrer || referrer.deleted_at) {
      return NextResponse.json({ error: 'Referral not found' }, { status: 404 });
    }

    // Abuse check 1: Self-referral
    if (referrer.id === user.id) {
      await adminSupabase
        .from('referral_events')
        .update({ status: 'rejected', rejection_reason: 'self_referral' })
        .eq('referrer_user_id', referrer.id)
        .eq('referral_code', referralCode.toUpperCase())
        .eq('status', 'click');

      return NextResponse.json({ error: 'Self-referrals are not allowed' }, { status: 400 });
    }

    // Abuse check 2: Disposable email
    const email = user.email ?? '';
    const emailDomain = email.split('@')[1]?.toLowerCase() ?? '';
    const isDisposable = isDisposableEmail(email);

    if (isDisposable) {
      const emailHash = crypto.createHash('sha256').update(email).digest('hex');

      await adminSupabase
        .from('referral_events')
        .update({
          status: 'rejected',
          rejection_reason: 'disposable_email',
          referree_email_hash: emailHash,
          is_disposable_email: true,
        })
        .eq('referrer_user_id', referrer.id)
        .eq('referral_code', referralCode.toUpperCase())
        .eq('status', 'click');

      return NextResponse.json(
        { error: 'Referral not eligible for this account type' },
        { status: 400 }
      );
    }

    // Abuse check 3: Same email domain as referrer (corporate self-referral)
    const { data: referrerUser } = await adminSupabase.auth.admin.getUserById(referrer.id);
    const referrerEmail = referrerUser?.user?.email ?? '';
    const referrerDomain = referrerEmail.split('@')[1]?.toLowerCase() ?? '';

    // WHY exempt common public providers: alice@gmail.com referring bob@gmail.com
    // is a legitimate referral. The domain check is for corporate accounts
    // where the same employer could farm referral credits (e.g. acmecorp.com).
    const PUBLIC_EMAIL_PROVIDERS = new Set([
      'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com',
      'yahoo.com', 'icloud.com', 'me.com', 'protonmail.com',
    ]);

    const isDomainMatch =
      emailDomain &&
      referrerDomain &&
      emailDomain === referrerDomain &&
      !PUBLIC_EMAIL_PROVIDERS.has(emailDomain);

    if (isDomainMatch) {
      const emailHash = crypto.createHash('sha256').update(email).digest('hex');
      await adminSupabase
        .from('referral_events')
        .update({
          status: 'rejected',
          rejection_reason: 'same_domain',
          referree_email_hash: emailHash,
        })
        .eq('referrer_user_id', referrer.id)
        .eq('referral_code', referralCode.toUpperCase())
        .eq('status', 'click');

      return NextResponse.json(
        { error: 'Referral not eligible: same organization accounts cannot refer each other' },
        { status: 400 }
      );
    }

    // All checks passed - update referral event to signup state
    const emailHash = crypto.createHash('sha256').update(email).digest('hex');
    const { error: updateError } = await adminSupabase
      .from('referral_events')
      .update({
        referred_user_id: user.id,
        referree_email_hash: emailHash,
        status: 'signup',
        signed_up_at: new Date().toISOString(),
        is_disposable_email: false,
      })
      .eq('referrer_user_id', referrer.id)
      .eq('referral_code', referralCode.toUpperCase())
      .eq('status', 'click');

    if (updateError) {
      console.error('[referral POST] Update failed:', updateError.message);
      return NextResponse.json({ error: 'Referral attribution failed' }, { status: 500 });
    }

    // Update the referred user's profile to record who referred them
    await adminSupabase
      .from('profiles')
      .update({ referred_by_user_id: referrer.id })
      .eq('id', user.id);

    // Audit log
    await adminSupabase.from('audit_log').insert({
      user_id: user.id,
      event: 'referral_signup',
      metadata: {
        referrer_user_id: referrer.id,
        referral_code: referralCode.toUpperCase(),
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[referral POST] Failed:', error instanceof Error ? error.message : 'Unknown');
    return NextResponse.json({ error: 'Referral attribution failed' }, { status: 500 });
  }
}
