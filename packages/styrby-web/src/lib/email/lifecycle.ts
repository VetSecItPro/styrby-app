/**
 * Subscription Lifecycle Email Functions
 *
 * Six transactional emails covering every monetary state change a subscriber
 * can experience. Each function is self-contained, reuses the shared Resend
 * client from `@/lib/resend`, and never throws on send failure - delivery
 * failures are logged so the caller (Polar webhook handler) cannot be taken
 * down by transient email-provider issues.
 *
 * WHY this module exists separately from `@/lib/resend` and `@/emails/*`:
 *   The existing Styrby resend.ts wires React-Email components for the
 *   pre-existing transactional emails (welcome, budget alert, weekly digest,
 *   etc). Adding six new React-Email components for every subscription
 *   lifecycle state would balloon the diff and pull design-token decisions
 *   into a webhook bug fix. This module ships the lifecycle copy as inline
 *   HTML strings - the same shape Kaulby (sister product) uses - so the
 *   webhook handler can be wired in a follow-up PR without blocking on a
 *   design pass. React-Email versions can replace these later without
 *   changing the webhook call sites.
 *
 * Reference: Bug #5 / Phase H3 in the Kaulby fulltest hardening taxonomy
 * (mirrored against Styrby in `.audit/styrby-fulltest.md`).
 *
 * Wiring is intentionally NOT done in this PR - that is a follow-up so this
 * change stays narrowly reviewable.
 */

import { Resend } from 'resend';

// ─────────────────────────────────────────────────────────────────────────
// Resend client (lazy-initialized, mirrors @/lib/resend pattern)
// ─────────────────────────────────────────────────────────────────────────

let resendClient: Resend | null = null;
let warnedMissingKey = false;

/**
 * Lazily initialize the Resend client.
 *
 * WHY this returns null instead of throwing: every email helper in this
 * module is best-effort. A missing RESEND_API_KEY (typical in local dev or
 * a misconfigured preview deploy) must not crash the Polar webhook handler;
 * Polar would then retry the webhook indefinitely, causing duplicate state
 * mutations downstream.
 *
 * @returns The Resend client, or null if RESEND_API_KEY is unset
 */
function getResendClient(): Resend | null {
  if (!resendClient) {
    if (!process.env.RESEND_API_KEY) {
      if (!warnedMissingKey) {
        // eslint-disable-next-line no-console
        console.warn(
          '[email/lifecycle] RESEND_API_KEY is not set - lifecycle emails are disabled.'
        );
        warnedMissingKey = true;
      }
      return null;
    }
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }
  return resendClient;
}

/** Sender used for all lifecycle emails. Matches the existing Styrby brand domain. */
const FROM = 'Styrby <hello@styrbyapp.com>';

/** App URL for CTA buttons. Falls back to the production domain. */
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://styrbyapp.com';

// ─────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────

/**
 * Tier identifiers used across Styrby subscriptions.
 * Mirrors the values stored in `subscriptions.tier` (see migration 001).
 */
export type SubscriptionTier = 'free' | 'pro' | 'power' | 'team' | 'business' | 'enterprise';

/** Billing cadence for a paid subscription. */
export type BillingInterval = 'monthly' | 'annual';

// ─────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Escape user-controlled strings before interpolating them into HTML bodies.
 *
 * WHY: Tier and plan names come from the Polar webhook payload. While Polar
 * is a trusted source today, treating its data as user-influenced prevents
 * a future supply-chain bug from injecting markup into outgoing emails.
 *
 * @param value - String to escape
 * @returns HTML-safe string with `& < > " '` escaped
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Render a friendly tier label (e.g. `pro` -> `Pro`).
 *
 * @param tier - Internal tier slug
 * @returns Title-cased label suitable for customer-facing copy
 */
function tierLabel(tier: SubscriptionTier): string {
  if (tier === 'free') return 'Free';
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

/**
 * Format an ISO date string or Date as a long-form US date.
 *
 * @param value - ISO string or Date
 * @returns "April 26, 2026"
 */
function formatDate(value: string | Date): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Format a refund amount given as integer cents.
 *
 * @param cents - Refund amount in USD cents
 * @returns "$12.34" formatted with two decimals
 */
function formatCents(cents: number): string {
  const dollars = (cents / 100).toFixed(2);
  return `$${dollars}`;
}

/**
 * Wrap a body fragment in the minimal Styrby-branded HTML scaffold.
 *
 * @param title - Heading shown in the hero
 * @param body - HTML body (already escaped if it contains user data)
 * @param ctaLabel - Optional CTA button label
 * @param ctaUrl - Optional CTA button URL (required if ctaLabel set)
 * @returns Full HTML document body
 */
function wrap(title: string, body: string, ctaLabel?: string, ctaUrl?: string): string {
  const cta =
    ctaLabel && ctaUrl
      ? `<p style="margin: 32px 0 0; text-align: center;">
           <a href="${ctaUrl}" style="display: inline-block; padding: 12px 28px; background: #111; color: #fff; text-decoration: none; font-weight: 500; font-size: 14px; border-radius: 8px;">${escapeHtml(ctaLabel)}</a>
         </p>`
      : '';
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
      <tr><td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;padding:40px 32px;">
          <tr><td>
            <h1 style="margin:0 0 16px;font-size:22px;font-weight:600;color:#111;">${escapeHtml(title)}</h1>
            ${body}
            ${cta}
            <p style="margin:40px 0 0;font-size:13px;color:#666;line-height:1.6;">- The Styrby Team</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body></html>`;
}

/**
 * Send an email via Resend, swallowing all failures.
 *
 * Logs delivery failures with structured context so they're discoverable in
 * Sentry / log aggregation. Does NOT throw - lifecycle emails must never be
 * able to fail a Polar webhook (which would trigger costly webhook retries).
 *
 * NOTE: A future migration will introduce an `email_delivery_failures` table
 * to capture these for an admin retry UI. Until then, console.error is the
 * fallout sink (it is already piped to Sentry via the structured logger).
 *
 * @param params - Send parameters (to, subject, html, text)
 * @returns Promise that always resolves to void
 */
async function safeSend(params: {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Identifier for log correlation. */
  kind: string;
}): Promise<void> {
  const client = getResendClient();
  if (!client) {
    return;
  }
  try {
    const { error } = await client.emails.send({
      from: FROM,
      to: params.to,
      subject: params.subject,
      html: params.html,
      text: params.text,
    });
    if (error) {
      // eslint-disable-next-line no-console
      console.error('[email/lifecycle] send failed', {
        kind: params.kind,
        to: params.to,
        subject: params.subject,
        error,
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[email/lifecycle] send threw', {
      kind: params.kind,
      to: params.to,
      subject: params.subject,
      error: err,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// buildLifecycleEmail — shared assembly helper
// ─────────────────────────────────────────────────────────────────────────

/**
 * Options consumed by {@link buildLifecycleEmail}.
 *
 * Every field that varies across the 6 lifecycle email types is expressed
 * here. The helper assembles the full HTML document and plain-text
 * alternative, eliminating the ~250 lines of duplicated scaffold that
 * previously lived inside each function.
 */
export interface LifecycleEmailOpts {
  /** Email recipient address. */
  to: string;
  /** Email subject line (verbatim - not modified by the helper). */
  subject: string;
  /**
   * Hero heading rendered inside the branded card.
   * User-controlled values must already be escaped before being placed here;
   * `wrap()` calls `escapeHtml` on the title.
   */
  headline: string;
  /**
   * One or more HTML fragments rendered as the body of the card, in order.
   * Each fragment is a complete `<p>` block or equivalent. The caller is
   * responsible for escaping any user-controlled content inside each fragment.
   */
  bodyHtmlFragments: string[];
  /**
   * Optional call-to-action rendered as a centered button below the body.
   * Omit for emails that have no primary action (e.g. refund confirmation).
   */
  primaryAction?: { text: string; url: string };
  /**
   * Plain-text alternative for the email body content block.
   * The helper appends "- The Styrby Team" sign-off automatically;
   * the caller supplies everything before it.
   */
  plainText: string;
}

/**
 * Build the HTML and plain-text bodies for a lifecycle email, then invoke
 * {@link safeSend}.
 *
 * WHY this exists: all 6 lifecycle email functions share the same
 * HTML scaffold (branded card, CTA button, footer sign-off), the same
 * `safeSend` invocation, and the same escaping discipline. Extracting them
 * here reduces the public API to thin wrappers that supply only the copy
 * that differs per email type.
 *
 * @param opts - Per-email variable content (see {@link LifecycleEmailOpts})
 * @param kind - Short identifier for log correlation (e.g. 'subscription_confirmation')
 * @returns Promise that always resolves; failures are logged not thrown
 *
 * @example
 * await buildLifecycleEmail(
 *   {
 *     to: 'alice@example.com',
 *     subject: 'Subject line',
 *     headline: 'Card heading',
 *     bodyHtmlFragments: ['<p style="...">Body content</p>'],
 *     primaryAction: { text: 'Open dashboard', url: 'https://styrbyapp.com/dashboard' },
 *     plainText: 'Body content\n\nOpen your dashboard: https://styrbyapp.com/dashboard',
 *   },
 *   'subscription_confirmation'
 * );
 */
export async function buildLifecycleEmail(
  opts: LifecycleEmailOpts,
  kind: string
): Promise<void> {
  const html = wrap(
    opts.headline,
    opts.bodyHtmlFragments.join('\n'),
    opts.primaryAction?.text,
    opts.primaryAction?.url
  );
  const text = `${opts.plainText}\n\n- The Styrby Team`;
  await safeSend({ to: opts.to, subject: opts.subject, html, text, kind });
}

// ─────────────────────────────────────────────────────────────────────────
// Public API - 6 lifecycle functions
// ─────────────────────────────────────────────────────────────────────────

/**
 * Send the initial subscription confirmation email.
 *
 * Triggered the first time a `subscription.active` Polar webhook fires for
 * a user (i.e. the moment they become a paying customer).
 *
 * @param params.email - Recipient email address
 * @param params.tier - The tier the user just subscribed to
 * @param params.planName - Polar product name displayed in the email body
 * @param params.billingInterval - 'monthly' or 'annual'
 * @param params.currentPeriodEnd - ISO 8601 timestamp of the next billing date
 * @returns Promise that always resolves; failures are logged not thrown
 *
 * @example
 * await sendSubscriptionConfirmationEmail({
 *   email: 'alice@example.com',
 *   tier: 'pro',
 *   planName: 'Styrby Pro',
 *   billingInterval: 'monthly',
 *   currentPeriodEnd: '2026-05-26T00:00:00Z',
 * });
 */
export async function sendSubscriptionConfirmationEmail(params: {
  email: string;
  tier: SubscriptionTier;
  planName: string;
  billingInterval: BillingInterval;
  currentPeriodEnd: string;
}): Promise<void> {
  const tier = tierLabel(params.tier);
  const plan = escapeHtml(params.planName);
  const renewal = formatDate(params.currentPeriodEnd);
  await buildLifecycleEmail(
    {
      to: params.email,
      subject: `You're now on Styrby ${tier}`,
      headline: `Welcome to Styrby ${tier}`,
      bodyHtmlFragments: [
        `<p style="margin:0;font-size:14px;line-height:1.7;color:#444;">
       Your <strong>${plan}</strong> (${escapeHtml(params.billingInterval)}) subscription is active.
       Your next billing date is <strong>${escapeHtml(renewal)}</strong>.
     </p>`,
      ],
      primaryAction: { text: 'Open dashboard', url: `${APP_URL}/dashboard` },
      plainText: `Welcome to Styrby ${tier}.\n\nYour ${params.planName} (${params.billingInterval}) subscription is active. Your next billing date is ${renewal}.\n\nOpen your dashboard: ${APP_URL}/dashboard`,
    },
    'subscription_confirmation'
  );
}

/**
 * Send a subscription upgrade confirmation email.
 *
 * Triggered when the active tier rank increases (e.g. pro -> power). The
 * caller is responsible for determining direction; this function only formats
 * and sends.
 *
 * @param params.email - Recipient email address
 * @param params.oldTier - The tier the user was on before the change
 * @param params.newTier - The tier the user is now on
 * @param params.billingInterval - Effective billing cadence after upgrade
 * @returns Promise that always resolves; failures are logged not thrown
 *
 * @example
 * await sendSubscriptionUpgradedEmail({
 *   email: 'alice@example.com',
 *   oldTier: 'pro',
 *   newTier: 'power',
 *   billingInterval: 'annual',
 * });
 */
export async function sendSubscriptionUpgradedEmail(params: {
  email: string;
  oldTier: SubscriptionTier;
  newTier: SubscriptionTier;
  billingInterval: BillingInterval;
}): Promise<void> {
  const from = tierLabel(params.oldTier);
  const to = tierLabel(params.newTier);
  await buildLifecycleEmail(
    {
      to: params.email,
      subject: `Your Styrby plan was upgraded to ${to}`,
      headline: `Plan upgraded to ${to}`,
      bodyHtmlFragments: [
        `<p style="margin:0;font-size:14px;line-height:1.7;color:#444;">
       Your account moved from <strong>${escapeHtml(from)}</strong> to <strong>${escapeHtml(to)}</strong>
       (${escapeHtml(params.billingInterval)}). The change is effective immediately and your next bill reflects the new rate.
     </p>`,
      ],
      primaryAction: { text: 'Open dashboard', url: `${APP_URL}/dashboard` },
      plainText: `Your Styrby plan was upgraded.\n\nYou moved from ${from} to ${to} (${params.billingInterval}). The change is effective immediately and your next bill reflects the new rate.\n\nOpen your dashboard: ${APP_URL}/dashboard`,
    },
    'subscription_upgraded'
  );
}

/**
 * Send a subscription downgrade confirmation email.
 *
 * Triggered when the active tier rank decreases (e.g. power -> pro). Differs
 * from cancellation because the customer remains on a paid plan.
 *
 * @param params.email - Recipient email address
 * @param params.oldTier - The tier the user was on before the change
 * @param params.newTier - The tier the user is now on (still a paid tier)
 * @param params.billingInterval - Effective billing cadence after downgrade
 * @returns Promise that always resolves; failures are logged not thrown
 *
 * @example
 * await sendSubscriptionDowngradedEmail({
 *   email: 'alice@example.com',
 *   oldTier: 'power',
 *   newTier: 'pro',
 *   billingInterval: 'monthly',
 * });
 */
export async function sendSubscriptionDowngradedEmail(params: {
  email: string;
  oldTier: SubscriptionTier;
  newTier: SubscriptionTier;
  billingInterval: BillingInterval;
}): Promise<void> {
  const from = tierLabel(params.oldTier);
  const to = tierLabel(params.newTier);
  await buildLifecycleEmail(
    {
      to: params.email,
      subject: `Your Styrby plan was changed to ${to}`,
      headline: `Plan changed to ${to}`,
      bodyHtmlFragments: [
        `<p style="margin:0;font-size:14px;line-height:1.7;color:#444;">
       Your account moved from <strong>${escapeHtml(from)}</strong> to <strong>${escapeHtml(to)}</strong>
       (${escapeHtml(params.billingInterval)}). Your next bill reflects the new rate. Some features may no longer
       be available - review your dashboard for details.
     </p>`,
      ],
      primaryAction: { text: 'Open dashboard', url: `${APP_URL}/dashboard` },
      plainText: `Your Styrby plan was changed.\n\nYou moved from ${from} to ${to} (${params.billingInterval}). Your next bill reflects the new rate. Some features may no longer be available - review your dashboard for details.\n\nOpen your dashboard: ${APP_URL}/dashboard`,
    },
    'subscription_downgraded'
  );
}

/**
 * Send a voluntary cancellation confirmation email.
 *
 * Triggered on `subscription.canceled` (Polar). The user retains access to
 * paid features until `accessUntil`; afterwards they fall back to the free
 * tier. Use {@link sendRevokedEmail} for the access-removed event.
 *
 * @param params.email - Recipient email address
 * @param params.tier - Tier the user is leaving
 * @param params.accessUntil - ISO 8601 timestamp when paid access ends
 * @returns Promise that always resolves; failures are logged not thrown
 *
 * @example
 * await sendCancellationEmail({
 *   email: 'alice@example.com',
 *   tier: 'pro',
 *   accessUntil: '2026-05-26T00:00:00Z',
 * });
 */
export async function sendCancellationEmail(params: {
  email: string;
  tier: SubscriptionTier;
  accessUntil: string;
}): Promise<void> {
  const tier = tierLabel(params.tier);
  const until = formatDate(params.accessUntil);
  await buildLifecycleEmail(
    {
      to: params.email,
      subject: 'Your Styrby cancellation is confirmed',
      headline: 'Cancellation confirmed',
      bodyHtmlFragments: [
        `<p style="margin:0 0 12px;font-size:14px;line-height:1.7;color:#444;">
       Your <strong>${escapeHtml(tier)}</strong> subscription was canceled. You'll keep full access until
       <strong>${escapeHtml(until)}</strong>, after which your account moves to the free tier.
     </p>`,
        `<p style="margin:0;font-size:14px;line-height:1.7;color:#444;">
       Changed your mind? You can resubscribe any time before then to restore your plan.
     </p>`,
      ],
      primaryAction: { text: 'Resubscribe', url: `${APP_URL}/pricing` },
      plainText: `Cancellation confirmed.\n\nYour ${tier} subscription was canceled. You'll keep full access until ${until}, after which your account moves to the free tier.\n\nChanged your mind? Resubscribe any time before then to restore your plan: ${APP_URL}/pricing`,
    },
    'subscription_canceled'
  );
}

/**
 * Send the access-removed email.
 *
 * Triggered on `subscription.revoked` (Polar) - the moment paid access is
 * actually removed (after a grace period or on involuntary revocation). The
 * user is now on the free tier; their data is preserved per the free-tier
 * retention policy.
 *
 * @param params.email - Recipient email address
 * @param params.tier - Tier the user just lost
 * @returns Promise that always resolves; failures are logged not thrown
 *
 * @example
 * await sendRevokedEmail({ email: 'alice@example.com', tier: 'pro' });
 */
export async function sendRevokedEmail(params: {
  email: string;
  tier: SubscriptionTier;
}): Promise<void> {
  const tier = tierLabel(params.tier);
  await buildLifecycleEmail(
    {
      to: params.email,
      subject: 'Your Styrby subscription has ended',
      headline: 'Your subscription has ended',
      bodyHtmlFragments: [
        `<p style="margin:0;font-size:14px;line-height:1.7;color:#444;">
       Your <strong>${escapeHtml(tier)}</strong> subscription has ended and your account is now on the free tier.
       Your data is preserved per the free-tier retention policy. Resubscribe any time to restore full features.
     </p>`,
      ],
      primaryAction: { text: 'Reactivate', url: `${APP_URL}/pricing` },
      plainText: `Your Styrby subscription has ended.\n\nYour ${tier} subscription has ended and your account is now on the free tier. Your data is preserved per the free-tier retention policy. Resubscribe any time to restore full features.\n\nReactivate: ${APP_URL}/pricing`,
    },
    'subscription_revoked'
  );
}

/**
 * Send a refund confirmation email.
 *
 * Triggered on `order.refunded` (Polar). Includes the refund amount and the
 * reason supplied by the merchant for transparency.
 *
 * @param params.email - Recipient email address
 * @param params.tier - Tier associated with the refunded order
 * @param params.refundAmountCents - Refund amount in USD cents
 * @param params.refundReason - Optional human-readable reason. Pass an empty
 *   string or omit if no reason is available.
 * @returns Promise that always resolves; failures are logged not thrown
 *
 * @example
 * await sendRefundEmail({
 *   email: 'alice@example.com',
 *   tier: 'pro',
 *   refundAmountCents: 4900,
 *   refundReason: 'Duplicate charge',
 * });
 */
export async function sendRefundEmail(params: {
  email: string;
  tier: SubscriptionTier;
  refundAmountCents: number;
  refundReason?: string;
}): Promise<void> {
  const tier = tierLabel(params.tier);
  const amount = formatCents(params.refundAmountCents);
  const reason = params.refundReason?.trim() ? params.refundReason.trim() : null;
  await buildLifecycleEmail(
    {
      to: params.email,
      subject: 'Your Styrby refund has been processed',
      headline: 'Refund processed',
      bodyHtmlFragments: [
        `<p style="margin:0 0 12px;font-size:14px;line-height:1.7;color:#444;">
       Your refund of <strong>${escapeHtml(amount)}</strong> for <strong>${escapeHtml(tier)}</strong> has been processed${
         reason ? ` (reason: <em>${escapeHtml(reason)}</em>)` : ''
       }. It typically takes 5-10 business days to appear on your statement, depending on your bank. Your account access has been adjusted accordingly.
     </p>`,
        `<p style="margin:0;font-size:14px;line-height:1.7;color:#444;">
       Questions? Reply to this email and we'll help.
     </p>`,
      ],
      // WHY no primaryAction: refund emails have no meaningful next action for
      // the customer - their money is being returned, not a tier change they
      // should act on. The `wrap()` helper omits the button when undefined.
      plainText: `Refund processed.\n\nYour refund of ${amount} for ${tier} has been processed${reason ? ` (reason: ${reason})` : ''}. It typically takes 5-10 business days to appear on your statement, depending on your bank. Your account access has been adjusted accordingly.\n\nQuestions? Reply to this email.`,
    },
    'refund'
  );
}
