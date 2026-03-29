/**
 * Data Retention Enforcement Cron
 *
 * POST /api/cron/retention
 *
 * Enforces the retention promises made in the privacy policy and subscription
 * lifecycle rules:
 * 1. Purge audit_log records older than 90 days
 * 2. Hard-delete profiles (and cascade) where deleted_at > 30 days ago
 * 3. SEC-LOGIC-004 FIX: Downgrade canceled subscriptions past their period end
 *    back to 'free' tier. Without this, a user who cancels keeps paid access
 *    indefinitely because the webhook only marks status = 'canceled'; it does
 *    not downgrade the tier. The tier downgrade must happen after
 *    current_period_end passes (the user keeps access until then).
 *
 * WHY: GDPR Article 5(1)(e) requires data not be kept longer than necessary.
 * The privacy policy promises 90-day audit log retention and 30-day account
 * deletion window. Without this cron, those promises are unenforceable.
 *
 * @auth Required - CRON_SECRET header must match environment variable
 * @schedule Recommended: daily via Vercel Cron or external scheduler
 *
 * @returns 200 { success: true, purged: { auditLogs: number, accounts: number }, downgraded: number }
 *
 * @error 401 { error: 'Unauthorized' }
 * @error 500 { error: 'Retention enforcement failed' }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import crypto from 'crypto';

/**
 * Maximum number of audit log records to delete per run.
 * WHY: Prevents long-running queries that could hit Supabase timeouts.
 * At ~1000 events/day, 90 days = ~90k records. 10k batch is safe.
 */
const AUDIT_LOG_BATCH_SIZE = 10000;

/**
 * Number of days to retain audit log records.
 * Must match the privacy policy's stated retention period.
 */
const AUDIT_LOG_RETENTION_DAYS = 90;

/**
 * Number of days after soft-delete before hard-deleting an account.
 * Must match the privacy policy's stated deletion recovery window.
 */
const ACCOUNT_DELETION_GRACE_DAYS = 30;

export async function POST(request: NextRequest) {
  // Verify cron secret to prevent unauthorized execution.
  // SEC-LOGIC-007 FIX: Use crypto.timingSafeEqual instead of ===.
  // WHY: String equality (===) is vulnerable to timing attacks - an attacker
  // can measure how long comparisons take to infer how many leading characters
  // of the secret they guessed correctly. timingSafeEqual always takes the
  // same amount of time regardless of where strings diverge, eliminating this
  // side channel. This is especially important for long-lived cron secrets
  // that rotate infrequently.
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');
  const provided = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (
    !cronSecret ||
    !provided ||
    provided.length !== cronSecret.length ||
    !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(cronSecret))
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createAdminClient();

  try {
    // 1. Purge audit log records older than 90 days
    // WHY: Privacy policy Section 5 states "Audit logs: Retained for 90 days"
    const auditCutoff = new Date();
    auditCutoff.setDate(auditCutoff.getDate() - AUDIT_LOG_RETENTION_DAYS);

    const { count: auditCount, error: auditError } = await supabase
      .from('audit_log')
      .delete({ count: 'exact' })
      .lt('created_at', auditCutoff.toISOString())
      .limit(AUDIT_LOG_BATCH_SIZE);

    if (auditError) {
      console.error('Audit log purge failed:', auditError.message);
    }

    // 2. Hard-delete accounts where deleted_at > 30 days ago
    // WHY: Privacy policy states "30-day recovery window" for deleted accounts.
    // CASCADE on profiles.id will clean up: machines, device_tokens, sessions,
    // agent_configs, cost_records, subscriptions, budget_alerts, etc.
    const accountCutoff = new Date();
    accountCutoff.setDate(accountCutoff.getDate() - ACCOUNT_DELETION_GRACE_DAYS);

    // Find profiles past the grace period
    const { data: expiredProfiles, error: findError } = await supabase
      .from('profiles')
      .select('id')
      .not('deleted_at', 'is', null)
      .lt('deleted_at', accountCutoff.toISOString());

    if (findError) {
      console.error('Expired profile lookup failed:', findError.message);
    }

    let accountsDeleted = 0;

    if (expiredProfiles && expiredProfiles.length > 0) {
      const expiredIds = expiredProfiles.map((p) => p.id);

      // Hard-delete the profiles (CASCADE handles related tables)
      const { count: deletedCount, error: deleteError } = await supabase
        .from('profiles')
        .delete({ count: 'exact' })
        .in('id', expiredIds);

      if (deleteError) {
        console.error('Account hard-delete failed:', deleteError.message);
      } else {
        accountsDeleted = deletedCount ?? 0;

        // Also delete from auth.users via Supabase Admin API.
        // WHY: profiles CASCADE only covers public tables. The auth.users
        // record must be deleted separately to fully remove the account.
        // WHY allSettled: one failed deletion must not block the others -
        // partial progress is better than a full abort on a transient error.
        await Promise.allSettled(
          expiredIds.map(async (profileId) => {
            const { error: authDeleteError } =
              await supabase.auth.admin.deleteUser(profileId);
            if (authDeleteError) {
              console.error(
                `Failed to delete auth.users record ${profileId}:`,
                authDeleteError.message
              );
            }
          })
        );
      }
    }

    // 3. SEC-LOGIC-004 FIX: Downgrade canceled subscriptions past their period end.
    //
    // WHY: When a user cancels, the polar-webhook sets status = 'canceled' but
    // intentionally does NOT change the tier - the user should keep paid access
    // until current_period_end (they paid for that period). This cron runs daily
    // and downgrades the tier to 'free' once current_period_end has passed.
    // Without this job, canceled users keep their paid tier forever.
    const now = new Date().toISOString();

    const { data: expiredSubs, error: expiredSubsError } = await supabase
      .from('subscriptions')
      .select('id')
      .eq('status', 'canceled')
      .neq('tier', 'free')
      .lt('current_period_end', now);

    if (expiredSubsError) {
      console.error('Expired subscription lookup failed:', expiredSubsError.message);
    }

    let subscriptionsDowngraded = 0;

    if (expiredSubs && expiredSubs.length > 0) {
      const expiredSubIds = expiredSubs.map((s) => s.id);

      const { count: downgradedCount, error: downgradeError } = await supabase
        .from('subscriptions')
        .update({ tier: 'free' }, { count: 'exact' })
        .in('id', expiredSubIds);

      if (downgradeError) {
        console.error('Subscription tier downgrade failed:', downgradeError.message);
      } else {
        subscriptionsDowngraded = downgradedCount ?? 0;
        console.log(
          `[SEC-LOGIC-004] Downgraded ${subscriptionsDowngraded} canceled subscription(s) to free tier.`
        );
      }
    }

    return NextResponse.json({
      success: true,
      purged: {
        auditLogs: auditCount ?? 0,
        accounts: accountsDeleted,
      },
      downgraded: subscriptionsDowngraded,
      cutoffs: {
        auditLogBefore: auditCutoff.toISOString(),
        accountsDeletedBefore: accountCutoff.toISOString(),
        subscriptionPeriodEndBefore: now,
      },
    });
  } catch (error) {
    console.error(
      'Retention enforcement error:',
      error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json(
      { error: 'Retention enforcement failed' },
      { status: 500 }
    );
  }
}
