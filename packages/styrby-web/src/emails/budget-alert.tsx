/**
 * Budget Alert Email
 * Sent when user hits a spending threshold.
 */

import { Section, Text } from '@react-email/components';
import * as React from 'react';
import {
  BaseLayout,
  Button,
  Heading,
  Paragraph,
  Divider,
} from './base-layout';

interface BudgetAlertEmailProps {
  displayName?: string;
  alertName: string;
  threshold: string;
  currentSpend: string;
  period: 'daily' | 'weekly' | 'monthly';
  percentUsed: number;
  topAgent?: string;
  topAgentSpend?: string;
}

export default function BudgetAlertEmail({
  displayName,
  alertName,
  threshold,
  currentSpend,
  period,
  percentUsed,
  topAgent,
  topAgentSpend,
}: BudgetAlertEmailProps) {
  const name = displayName || 'there';
  const periodLabel = period === 'daily' ? 'today' : period === 'weekly' ? 'this week' : 'this month';
  const isOver = percentUsed >= 100;

  return (
    <BaseLayout preview={`Budget alert: You've used ${percentUsed}% of your ${period} limit`}>
      {/* Alert banner */}
      <Section
        className={`mb-6 rounded-lg p-4 ${
          isOver
            ? 'bg-red-500/10 border border-red-500/20'
            : 'bg-yellow-500/10 border border-yellow-500/20'
        }`}
      >
        <Text
          className={`m-0 text-center text-sm font-semibold ${
            isOver ? 'text-red-400' : 'text-yellow-400'
          }`}
        >
          {isOver ? '🚨 Budget Exceeded' : '⚠️ Budget Warning'}
        </Text>
      </Section>

      <Heading>{alertName}</Heading>

      <Paragraph>Hey {name},</Paragraph>

      <Paragraph>
        You&apos;ve {isOver ? 'exceeded' : 'reached'}{' '}
        <strong className="text-zinc-100">{percentUsed}%</strong> of your {period} budget
        ({threshold}).
      </Paragraph>

      {/* Spending summary */}
      <Section className="mb-6 rounded-lg bg-zinc-800 p-4">
        <Text className="m-0 mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-400">
          Spending {periodLabel}
        </Text>

        {/* Progress bar */}
        <Section className="mb-3">
          <Section className="h-2 w-full overflow-hidden rounded-full bg-zinc-700">
            <Section
              className={`h-full rounded-full ${isOver ? 'bg-red-500' : 'bg-yellow-500'}`}
              style={{ width: `${Math.min(percentUsed, 100)}%` }}
            />
          </Section>
        </Section>

        <Text className="m-0 mb-1 text-sm text-zinc-300">
          <strong className="text-zinc-100">{currentSpend}</strong> of {threshold} used
        </Text>

        {topAgent && topAgentSpend && (
          <Text className="m-0 text-sm text-zinc-400">
            Top spender: {topAgent} ({topAgentSpend})
          </Text>
        )}
      </Section>

      <Section className="text-center">
        <Button href="https://www.styrbyapp.com/costs">
          View Cost Breakdown
        </Button>
      </Section>

      <Divider />

      <Paragraph>
        <strong className="text-zinc-100">Manage this alert:</strong> You can adjust
        thresholds or disable alerts in your{' '}
        <a href="https://www.styrbyapp.com/settings" className="text-brand underline">
          notification settings
        </a>
        .
      </Paragraph>

      <Text className="m-0 text-sm text-zinc-400">
        — The Styrby Team
      </Text>
    </BaseLayout>
  );
}
