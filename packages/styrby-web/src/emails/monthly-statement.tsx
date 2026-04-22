/**
 * Monthly Statement Email
 *
 * Sent on the 1st of every month via the send-monthly-statement edge function.
 * Summarizes the prior month's AI coding activity:
 *   - Total spend
 *   - % from API vs subscription quota vs credits
 *   - Session count
 *   - Top agent by usage
 *   - Token totals
 *
 * @module emails/monthly-statement
 */

import { Section, Text, Link as EmailLink } from '@react-email/components';
import * as React from 'react';
import {
  BaseLayout,
  Button,
  Heading,
  Paragraph,
  Divider,
} from './base-layout';

// ============================================================================
// Types
// ============================================================================

/**
 * Billing model summary figures for the monthly statement.
 */
interface BillingBreakdown {
  /** Percentage of activity that came from API-key billing (0-100). */
  apiPct: number;
  /** Percentage of activity that came from subscription quota (0-100). */
  subscriptionPct: number;
  /** Percentage of activity that came from credit billing (0-100). */
  creditPct: number;
}

/**
 * Props for {@link MonthlyStatementEmail}.
 */
export interface MonthlyStatementEmailProps {
  /** User's display name or email prefix. */
  displayName?: string;
  /**
   * Human-readable month label shown in the subject line and heading.
   *
   * @example "April 2026"
   */
  monthLabel: string;
  /** Total USD spend for the month (formatted string, e.g. "$42.70"). */
  totalCost: string;
  /** Total sessions completed during the month. */
  totalSessions: number;
  /** Top agent type by session count, e.g. "Claude Code". */
  topAgent: string;
  /** Total input tokens consumed across all sessions. */
  totalInputTokens: string;
  /** Total output tokens generated across all sessions. */
  totalOutputTokens: string;
  /** Billing model breakdown for the period. */
  billing: BillingBreakdown;
  /**
   * Link to the full cost dashboard for this user.
   * Defaults to the hosted dashboard URL.
   */
  dashboardUrl?: string;
}

// ============================================================================
// Component
// ============================================================================

/**
 * Monthly statement email template.
 *
 * Rendered by the send-monthly-statement edge function using
 * `@react-email/render` and delivered via Resend.
 *
 * @param props - Email content props
 * @returns React Email component tree
 *
 * @example
 * import { render } from '@react-email/render';
 * import MonthlyStatementEmail from './monthly-statement';
 *
 * const html = render(
 *   <MonthlyStatementEmail
 *     displayName="Jordan"
 *     monthLabel="April 2026"
 *     totalCost="$42.70"
 *     totalSessions={31}
 *     topAgent="Claude Code"
 *     totalInputTokens="8.2M"
 *     totalOutputTokens="1.4M"
 *     billing={{ apiPct: 78, subscriptionPct: 18, creditPct: 4 }}
 *   />
 * );
 */
export default function MonthlyStatementEmail({
  displayName,
  monthLabel,
  totalCost,
  totalSessions,
  topAgent,
  totalInputTokens,
  totalOutputTokens,
  billing,
  dashboardUrl = 'https://app.styrbyapp.com/dashboard/costs',
}: MonthlyStatementEmailProps) {
  const name = displayName || 'there';

  // Build billing breakdown label.
  // WHY: Show all non-zero billing types. Subscription and credit users
  // don't pay per-token so "$0" would be misleading without context.
  const billingParts: string[] = [];
  if (billing.apiPct > 0) billingParts.push(`${billing.apiPct}% API`);
  if (billing.subscriptionPct > 0) billingParts.push(`${billing.subscriptionPct}% subscription quota`);
  if (billing.creditPct > 0) billingParts.push(`${billing.creditPct}% credits`);
  const billingLine = billingParts.length > 0 ? billingParts.join(', ') : 'No billed usage';

  return (
    <BaseLayout
      preview={`Your ${monthLabel} summary - ${totalCost} spent, ${totalSessions} sessions, top agent: ${topAgent}`}
    >
      <Heading>Your {monthLabel} in Review</Heading>

      <Paragraph>Hey {name},</Paragraph>

      <Paragraph>
        Here&apos;s your AI coding summary for{' '}
        <strong className="text-zinc-100">{monthLabel}</strong>.
      </Paragraph>

      {/* Overview stats grid */}
      <Section className="mb-6 rounded-lg bg-zinc-800 p-4">
        <Section className="flex justify-between mb-4">
          {/* Total Cost */}
          <Section className="text-center flex-1">
            <Text className="m-0 text-2xl font-bold text-zinc-100">{totalCost}</Text>
            <Text className="m-0 text-xs text-zinc-400">Total Spent</Text>
          </Section>
          {/* Sessions */}
          <Section className="text-center flex-1">
            <Text className="m-0 text-2xl font-bold text-zinc-100">{totalSessions}</Text>
            <Text className="m-0 text-xs text-zinc-400">Sessions</Text>
          </Section>
          {/* Top Agent */}
          <Section className="text-center flex-1">
            <Text className="m-0 text-base font-bold text-zinc-100">{topAgent}</Text>
            <Text className="m-0 text-xs text-zinc-400">Top Agent</Text>
          </Section>
        </Section>

        {/* Token row */}
        <Section className="flex justify-between border-t border-zinc-700 pt-3">
          <Section className="text-center flex-1">
            <Text className="m-0 text-lg font-semibold text-zinc-100">{totalInputTokens}</Text>
            <Text className="m-0 text-xs text-zinc-400">Input Tokens</Text>
          </Section>
          <Section className="text-center flex-1">
            <Text className="m-0 text-lg font-semibold text-zinc-100">{totalOutputTokens}</Text>
            <Text className="m-0 text-xs text-zinc-400">Output Tokens</Text>
          </Section>
        </Section>
      </Section>

      {/* Billing breakdown */}
      <Section className="mb-6">
        <Text className="m-0 text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
          Billing Mix
        </Text>
        <Section className="rounded-lg border border-zinc-700 px-4 py-3">
          <Text className="m-0 text-sm text-zinc-300">{billingLine}</Text>
        </Section>
      </Section>

      <Divider />

      <Paragraph>
        Want to dig deeper? View your full cost dashboard for spending by agent,
        model, and tag.
      </Paragraph>

      <Button href={dashboardUrl}>View Cost Dashboard</Button>

      <Text className="m-0 mb-4 text-xs leading-5 text-zinc-500 mt-6">
        You&apos;re receiving this because you have a Styrby account. Statements are
        sent on the 1st of each month for the prior month.{' '}
        <EmailLink
          href="https://app.styrbyapp.com/dashboard/settings/notifications"
          className="text-zinc-400 underline"
        >
          Manage email preferences
        </EmailLink>
        .
      </Text>
    </BaseLayout>
  );
}
