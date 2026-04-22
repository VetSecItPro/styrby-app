/**
 * Referral Reward Issuance API
 *
 * POST /api/referral/reward
 *
 * Called by the Polar webhook handler when a referred user upgrades to
 * Pro or Power. Issues a 1-month free credit to the referrer via the
 * Polar API and marks the referral_events row as 'rewarded'.
 *
 * WHY this route exists separately from the webhook:
 * The Polar webhook payload is large and handles many event types. Reward
 * issuance needs its own function with explicit idempotency checks (the
 * referral must be in 'upgraded' state, not 'rewarded' state). Separating
 * concerns keeps the webhook handler lean and this logic auditable.
 *
 * This route is called internally by the billing webhook handler — it is
 * NOT a public endpoint. The INTERNAL_API_KEY check prevents external calls.
 *
 * @auth Required - X-Internal-Key header matching INTERNAL_API_KEY env var
 *
 * @body {
 *   referredUserId: string,
 *   upgradedTier: 'pro' | 'power' | 'team' | 'business' | 'enterprise',
 *   polarSubscriptionId: string
 * }
 *
 * @returns 200 { success: true, rewarded: boolean, creditId?: string }
 *
 * @error 400 { error: string }
 * @error 401 { error: 'Unauthorized' }
 * @error 404 { error: 'No eligible referral found' }
 * @error 500 { error: 'Reward issuance failed' }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { z } from 'zod';
import crypto from 'crypto';

const RewardBodySchema = z.object({
  referredUserId: z.string().uuid(),
  upgradedTier: z.enum(['pro', 'power', 'team', 'business', 'enterprise']),
  polarSubscriptionId: z.string().min(1),
});

/**
 * Credit duration for the referral reward (1 month = 1 billing cycle).
 * WHY 30 days: Polar credit API accepts duration in days. 30 days maps
 * cleanly to a monthly subscription cycle without pro-rating complexity.
 */
const REWARD_CREDIT_DAYS = 30;

export async function POST(request: NextRequest) {
  // Internal API key check — timing-safe comparison
  const internalKey = process.env.INTERNAL_API_KEY;
  const provided = request.headers.get('x-internal-key') ?? '';

  if (
    !internalKey ||
    !provided ||
    provided.length !== internalKey.length ||
    !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(internalKey))
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = RewardBodySchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.errors[0]?.message ?? 'Invalid request body' },
      { status: 400 }
    );
  }

  const { referredUserId, upgradedTier, polarSubscriptionId } = parsed.data;
  const supabase = createAdminClient();

  try {
    // Find the most recent eligible referral_events row for this referred user
    const { data: referralEvent, error: findError } = await supabase
      .from('referral_events')
      .select('id, referrer_user_id, referral_code, rewarded_at')
      .eq('referred_user_id', referredUserId)
      .eq('status', 'signup')
      .order('signed_up_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (findError) {
      console.error('[referral/reward] Referral lookup failed:', findError.message);
      return NextResponse.json({ error: 'Reward issuance failed' }, { status: 500 });
    }

    if (!referralEvent) {
      // No eligible referral — not an error (user may have signed up organically)
      return NextResponse.json({ success: true, rewarded: false });
    }

    // Idempotency — already rewarded?
    if (referralEvent.rewarded_at) {
      return NextResponse.json({ success: true, rewarded: false });
    }

    // Mark as 'upgraded' first
    await supabase
      .from('referral_events')
      .update({
        status: 'upgraded',
        upgraded_at: new Date().toISOString(),
        upgraded_to_tier: upgradedTier,
      })
      .eq('id', referralEvent.id);

    // Look up the referrer's Polar subscription to apply the credit
    const { data: referrerSub, error: subError } = await supabase
      .from('subscriptions')
      .select('polar_subscription_id')
      .eq('user_id', referralEvent.referrer_user_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (subError || !referrerSub?.polar_subscription_id) {
      // Referrer has no active subscription — can't credit, but don't error
      console.warn(
        `[referral/reward] Referrer ${referralEvent.referrer_user_id} has no subscription to credit`
      );
      return NextResponse.json({ success: true, rewarded: false });
    }

    // Issue Polar credit via API
    // WHY: Polar's "grant free months" endpoint takes subscription_id + days.
    // Documentation: https://docs.polar.sh/api#credits
    const polarApiKey = process.env.POLAR_API_KEY ?? process.env.POLAR_ACCESS_TOKEN;

    if (!polarApiKey) {
      console.error('[referral/reward] POLAR_API_KEY not configured');
      return NextResponse.json({ error: 'Reward issuance failed' }, { status: 500 });
    }

    const polarResponse = await fetch('https://api.polar.sh/v1/subscriptions/credit', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${polarApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        subscription_id: referrerSub.polar_subscription_id,
        days: REWARD_CREDIT_DAYS,
        reason: `Referral reward: referred user ${referredUserId} upgraded to ${upgradedTier}`,
      }),
    });

    let creditId: string | undefined;
    let polarSuccess = false;

    if (polarResponse.ok) {
      const polarData = (await polarResponse.json()) as { id?: string };
      creditId = polarData.id;
      polarSuccess = true;
    } else {
      const errorText = await polarResponse.text();
      console.error(
        `[referral/reward] Polar credit API error ${polarResponse.status}:`,
        errorText
      );
    }

    // Mark referral as rewarded (regardless of Polar success for now —
    // admin can manually re-issue if Polar fails)
    await supabase
      .from('referral_events')
      .update({
        status: polarSuccess ? 'rewarded' : 'upgraded',
        rewarded_at: polarSuccess ? new Date().toISOString() : null,
        polar_credit_id: creditId,
      })
      .eq('id', referralEvent.id);

    // Send in-app notification to referrer about the reward
    if (polarSuccess) {
      await supabase.from('notifications').insert({
        user_id: referralEvent.referrer_user_id,
        type: 'referral_reward',
        title: 'Referral reward unlocked!',
        body: 'Someone you invited just upgraded. You earned 1 free month.',
        deep_link: '/settings/referral',
        metadata: {
          referred_user_id: referredUserId,
          upgraded_tier: upgradedTier,
          credit_days: REWARD_CREDIT_DAYS,
          polar_credit_id: creditId,
        },
      });
    }

    // Audit log (SOC2 CC7.2 + financial transaction trace)
    await supabase.from('audit_log').insert({
      user_id: referralEvent.referrer_user_id,
      event: 'referral_reward_issued',
      metadata: {
        referral_event_id: referralEvent.id,
        referred_user_id: referredUserId,
        upgraded_tier: upgradedTier,
        polar_subscription_id: polarSubscriptionId,
        referrer_polar_subscription_id: referrerSub.polar_subscription_id,
        credit_days: REWARD_CREDIT_DAYS,
        polar_credit_id: creditId,
        polar_success: polarSuccess,
      },
    });

    return NextResponse.json({
      success: true,
      rewarded: polarSuccess,
      creditId,
    });
  } catch (error) {
    console.error('[referral/reward] Failed:', error instanceof Error ? error.message : 'Unknown');
    return NextResponse.json({ error: 'Reward issuance failed' }, { status: 500 });
  }
}
