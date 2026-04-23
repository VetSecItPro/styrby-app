/**
 * Resend email client and send utilities.
 *
 * Usage:
 *   import { sendEmail, sendWelcomeEmail } from '@/lib/resend';
 *   await sendWelcomeEmail({ email: 'user@example.com', displayName: 'John' });
 */

import { Resend } from 'resend';
import * as React from 'react';

import WelcomeEmail from '@/emails/welcome';
import SubscriptionConfirmedEmail from '@/emails/subscription-confirmed';
import SubscriptionCanceledEmail from '@/emails/subscription-canceled';
import PaymentFailedEmail from '@/emails/payment-failed';
import BudgetAlertEmail from '@/emails/budget-alert';
import WeeklySummaryEmail from '@/emails/weekly-summary';
import WeeklyDigestEmail from '@/emails/weekly-digest';
import SupportReplyEmail from '@/emails/support-reply';
import TeamInvitationEmail from '@/emails/team-invitation';

// Lazy-initialize Resend client to avoid build-time errors
let resendClient: Resend | null = null;
let warnedMissingKey = false;

/**
 * Get the lazily-initialized Resend client.
 *
 * WHY this returns null instead of throwing: Email is a nice-to-have feature
 * in Styrby. The app should function fully without it - welcome emails, budget
 * alerts, and weekly summaries are enhancements, not hard requirements.
 * Throwing here would crash API routes and auth callbacks just because the
 * RESEND_API_KEY is missing in development or a misconfigured deployment.
 *
 * @returns The Resend client instance, or null if RESEND_API_KEY is not set
 */
function getResendClient(): Resend | null {
  if (!resendClient) {
    if (!process.env.RESEND_API_KEY) {
      if (!warnedMissingKey) {
        console.warn(
          '[resend] RESEND_API_KEY is not set - email sending is disabled. ' +
          'Set this environment variable to enable transactional emails.'
        );
        warnedMissingKey = true;
      }
      return null;
    }
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }
  return resendClient;
}

// Default sender
const FROM_EMAIL = 'hello@styrbyapp.com';
const FROM_NAME = 'Styrby';
const from = `${FROM_NAME} <${FROM_EMAIL}>`;

/**
 * Generic email send function.
 *
 * Gracefully no-ops if the Resend client is not configured (RESEND_API_KEY
 * missing). This ensures the app works without email - callers do not need
 * to check for null before calling.
 *
 * @param to - Recipient email address
 * @param subject - Email subject line
 * @param react - React Email component to render as the email body
 * @param replyTo - Reply-to address (defaults to hello@styrbyapp.com)
 * @returns Result object with `success` boolean and optional `id` or `error`
 */
export async function sendEmail({
  to,
  subject,
  react,
  replyTo = FROM_EMAIL,
}: {
  to: string;
  subject: string;
  react: React.ReactElement;
  replyTo?: string;
}) {
  const client = getResendClient();

  if (!client) {
    return { success: false, error: 'Email sending is disabled (RESEND_API_KEY not set)' };
  }

  try {
    const { data, error } = await client.emails.send({
      from,
      to,
      subject,
      // @ts-ignore React 19 types may be incompatible with Resend ReactElement type in CI
      react,
      replyTo,
    });

    if (error) {
      console.error('Failed to send email:', error);
      return { success: false, error };
    }

    return { success: true, id: data?.id };
  } catch (error) {
    console.error('Email send error:', error);
    return { success: false, error };
  }
}

// ============================================================================
// TYPED EMAIL SENDERS
// ============================================================================

/**
 * Send welcome email to new user.
 */
export async function sendWelcomeEmail({
  email,
  displayName,
}: {
  email: string;
  displayName?: string;
}) {
  return sendEmail({
    to: email,
    subject: 'Welcome to Styrby!',
    react: React.createElement(WelcomeEmail, { displayName }),
  });
}

/**
 * Send subscription confirmation email.
 */
export async function sendSubscriptionConfirmedEmail({
  email,
  displayName,
  tier,
  amount,
  billingCycle,
  nextBillingDate,
}: {
  email: string;
  displayName?: string;
  tier: 'pro' | 'power';
  amount: string;
  billingCycle: 'monthly' | 'annual';
  nextBillingDate: string;
}) {
  const tierName = tier === 'pro' ? 'Pro' : 'Power';
  return sendEmail({
    to: email,
    subject: `You're now on Styrby ${tierName}!`,
    react: React.createElement(SubscriptionConfirmedEmail, {
      displayName,
      tier,
      amount,
      billingCycle,
      nextBillingDate,
    }),
  });
}

/**
 * Send subscription canceled email.
 */
export async function sendSubscriptionCanceledEmail({
  email,
  displayName,
  tier,
  accessUntil,
}: {
  email: string;
  displayName?: string;
  tier: 'pro' | 'power';
  accessUntil: string;
}) {
  return sendEmail({
    to: email,
    subject: 'Your Styrby subscription has been canceled',
    react: React.createElement(SubscriptionCanceledEmail, {
      displayName,
      tier,
      accessUntil,
    }),
  });
}

/**
 * Send payment failed email.
 */
export async function sendPaymentFailedEmail({
  email,
  displayName,
  tier,
  amount,
  lastFourDigits,
  retryDate,
}: {
  email: string;
  displayName?: string;
  tier: 'pro' | 'power';
  amount: string;
  lastFourDigits?: string;
  retryDate: string;
}) {
  return sendEmail({
    to: email,
    subject: 'Action required: Your Styrby payment failed',
    react: React.createElement(PaymentFailedEmail, {
      displayName,
      tier,
      amount,
      lastFourDigits,
      retryDate,
    }),
  });
}

/**
 * Send budget alert email.
 */
export async function sendBudgetAlertEmail({
  email,
  displayName,
  alertName,
  threshold,
  currentSpend,
  period,
  percentUsed,
  topAgent,
  topAgentSpend,
}: {
  email: string;
  displayName?: string;
  alertName: string;
  threshold: string;
  currentSpend: string;
  period: 'daily' | 'weekly' | 'monthly';
  percentUsed: number;
  topAgent?: string;
  topAgentSpend?: string;
}) {
  return sendEmail({
    to: email,
    subject: `Budget alert: ${alertName}`,
    react: React.createElement(BudgetAlertEmail, {
      displayName,
      alertName,
      threshold,
      currentSpend,
      period,
      percentUsed,
      topAgent,
      topAgentSpend,
    }),
  });
}

/**
 * Send weekly summary email.
 */
export async function sendWeeklySummaryEmail({
  email,
  displayName,
  weekOf,
  totalCost,
  totalSessions,
  totalTokens,
  costChange,
  topProject,
  agentStats,
  savedWithCache,
}: {
  email: string;
  displayName?: string;
  weekOf: string;
  totalCost: string;
  totalSessions: number;
  totalTokens: string;
  costChange: number;
  topProject?: string;
  agentStats: Array<{
    name: string;
    sessions: number;
    cost: string;
    tokens: string;
  }>;
  savedWithCache?: string;
}) {
  return sendEmail({
    to: email,
    subject: `Your week in AI coding: ${totalCost} spent`,
    react: React.createElement(WeeklySummaryEmail, {
      displayName,
      weekOf,
      totalCost,
      totalSessions,
      totalTokens,
      costChange,
      topProject,
      agentStats,
      savedWithCache,
    }),
  });
}

/**
 * Send weekly digest email with cost/session/agent stats and referral CTA.
 *
 * Called by the /api/cron/weekly-digest route on Sunday evenings.
 * Distinct from sendWeeklySummaryEmail (which uses a different template
 * with token counts and cache stats for the dashboard-triggered summary).
 *
 * @param email - Recipient email address
 * @param displayName - User's display name for personalization
 * @param weekOf - Formatted week start date string (e.g. "April 14")
 * @param totalCost - Formatted total cost string (e.g. "$12.34")
 * @param totalSessions - Number of sessions in the period
 * @param costChange - Percentage change vs prior week (positive = increase)
 * @param agentStats - Top 3 agents by spend with name, sessions, cost
 * @param referralCode - User's referral code for the invite CTA (optional)
 * @returns Result object with `success` boolean
 */
export async function sendWeeklyDigestEmail({
  email,
  displayName,
  weekOf,
  totalCost,
  totalSessions,
  costChange,
  agentStats,
  referralCode,
}: {
  email: string;
  displayName?: string;
  weekOf: string;
  totalCost: string;
  totalSessions: number;
  costChange: number;
  agentStats: Array<{ name: string; sessions: number; cost: string }>;
  referralCode?: string;
}) {
  return sendEmail({
    to: email,
    subject: `Your Styrby week: ${totalCost} — ${totalSessions} session${totalSessions !== 1 ? 's' : ''}`,
    react: React.createElement(WeeklyDigestEmail, {
      displayName,
      weekOf,
      totalCost,
      totalSessions,
      costChange,
      agentStats,
      referralCode,
    }),
  });
}

/**
 * Send support ticket reply notification to a user.
 *
 * @param email - Recipient email address (ticket owner)
 * @param subject - The original ticket subject
 * @param message - The admin's reply message
 * @param ticketId - The ticket UUID for the dashboard link
 * @returns Result object with `success` boolean and optional `id` or `error`
 */
export async function sendSupportReplyEmail({
  email,
  subject,
  message,
  ticketId,
}: {
  email: string;
  subject: string;
  message: string;
  ticketId: string;
}) {
  return sendEmail({
    to: email,
    subject: `Re: ${subject}`,
    react: React.createElement(SupportReplyEmail, { subject, message, ticketId }),
    replyTo: 'support@styrbyapp.com',
  });
}

/**
 * Send team invitation email via the web server's Resend integration.
 *
 * WHY this exists alongside the edge function's inline HTML sender:
 *   The edge function (teams-invite) renders invitation emails as inline HTML
 *   because it cannot import React Email templates. This function is for
 *   web API routes (e.g., a future /api/teams/[id]/invite route) that run
 *   in Next.js and have access to the full React Email template with the
 *   Styrby design system.
 *
 * WHY 'viewer' is supported here:
 *   Migration 027 extended team_invitations.role CHECK to include 'viewer'.
 *   The email template (team-invitation.tsx) was updated in Phase 2.2 to
 *   display the correct label for all three roles.
 *
 * @param email - Recipient email address
 * @param teamName - Display name of the team
 * @param inviterName - Display name of the inviter
 * @param inviterEmail - Email address of the inviter
 * @param role - Role the invitee will have: 'admin' | 'member' | 'viewer'
 * @param inviteUrl - Full accept URL including the raw invite token
 * @param expiresAt - ISO 8601 expiration timestamp
 * @returns Result object with `success` boolean and optional `id` or `error`
 */
export async function sendTeamInvitationEmail({
  email,
  teamName,
  inviterName,
  inviterEmail,
  role,
  inviteUrl,
  expiresAt,
}: {
  email: string;
  teamName: string;
  inviterName: string;
  inviterEmail: string;
  role: 'admin' | 'member' | 'viewer';
  inviteUrl: string;
  expiresAt: string;
}) {
  return sendEmail({
    to: email,
    subject: `You've been invited to join ${teamName} on Styrby`,
    react: React.createElement(TeamInvitationEmail, {
      teamName,
      inviterName,
      inviterEmail,
      role,
      inviteUrl,
      expiresAt,
    }),
  });
}
