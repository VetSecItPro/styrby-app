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

// Initialize Resend client
const resend = new Resend(process.env.RESEND_API_KEY);

// Default sender
const FROM_EMAIL = 'hello@styrbyapp.com';
const FROM_NAME = 'Styrby';
const from = `${FROM_NAME} <${FROM_EMAIL}>`;

/**
 * Generic email send function.
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
  try {
    const { data, error } = await resend.emails.send({
      from,
      to,
      subject,
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
