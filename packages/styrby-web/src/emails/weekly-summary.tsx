/**
 * Weekly Summary Email
 * Sent every Friday at 5PM in user's local timezone.
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

interface AgentStats {
  name: string;
  sessions: number;
  cost: string;
  tokens: string;
}

interface WeeklySummaryEmailProps {
  displayName?: string;
  weekOf: string;
  totalCost: string;
  totalSessions: number;
  totalTokens: string;
  costChange: number; // percentage vs last week, can be negative
  topProject?: string;
  agentStats: AgentStats[];
  savedWithCache?: string;
}

export default function WeeklySummaryEmail({
  displayName,
  weekOf,
  totalCost,
  totalSessions,
  totalTokens,
  costChange,
  topProject,
  agentStats,
  savedWithCache,
}: WeeklySummaryEmailProps) {
  const name = displayName || 'there';
  const changeLabel =
    costChange > 0
      ? `↑ ${costChange}% vs last week`
      : costChange < 0
      ? `↓ ${Math.abs(costChange)}% vs last week`
      : 'Same as last week';
  const changeColor =
    costChange > 0 ? 'text-red-400' : costChange < 0 ? 'text-green-400' : 'text-zinc-400';

  return (
    <BaseLayout preview={`Your week in AI coding: ${totalCost} spent, ${totalSessions} sessions`}>
      <Heading>Your Week in Review</Heading>

      <Paragraph>Hey {name},</Paragraph>

      <Paragraph>
        Here&apos;s your AI coding summary for the week of{' '}
        <strong className="text-zinc-100">{weekOf}</strong>.
      </Paragraph>

      {/* Overview stats */}
      <Section className="mb-6 rounded-lg bg-zinc-800 p-4">
        <Section className="mb-4 flex justify-between">
          <Section className="text-center flex-1">
            <Text className="m-0 text-2xl font-bold text-zinc-100">{totalCost}</Text>
            <Text className="m-0 text-xs text-zinc-400">Total Spent</Text>
            <Text className={`m-0 text-xs ${changeColor}`}>{changeLabel}</Text>
          </Section>
          <Section className="text-center flex-1">
            <Text className="m-0 text-2xl font-bold text-zinc-100">{totalSessions}</Text>
            <Text className="m-0 text-xs text-zinc-400">Sessions</Text>
          </Section>
          <Section className="text-center flex-1">
            <Text className="m-0 text-2xl font-bold text-zinc-100">{totalTokens}</Text>
            <Text className="m-0 text-xs text-zinc-400">Tokens</Text>
          </Section>
        </Section>

        {savedWithCache && (
          <Section className="rounded-md bg-green-500/10 p-2 text-center">
            <Text className="m-0 text-xs text-green-400">
              💚 Saved {savedWithCache} with prompt caching
            </Text>
          </Section>
        )}
      </Section>

      {/* Agent breakdown */}
      {agentStats.length > 0 && (
        <>
          <Text className="m-0 mb-3 text-sm font-semibold text-zinc-100">
            By Agent
          </Text>
          <Section className="mb-6">
            {agentStats.map((agent, index) => (
              <Section
                key={index}
                className="mb-2 flex items-center justify-between rounded-lg bg-zinc-800/50 p-3"
              >
                <Section>
                  <Text className="m-0 text-sm font-medium text-zinc-100">
                    {agent.name}
                  </Text>
                  <Text className="m-0 text-xs text-zinc-400">
                    {agent.sessions} sessions · {agent.tokens} tokens
                  </Text>
                </Section>
                <Text className="m-0 text-sm font-semibold text-zinc-100">
                  {agent.cost}
                </Text>
              </Section>
            ))}
          </Section>
        </>
      )}

      {topProject && (
        <Section className="mb-6">
          <Text className="m-0 text-sm text-zinc-400">
            <strong className="text-zinc-300">Most active project:</strong> {topProject}
          </Text>
        </Section>
      )}

      <Section className="text-center">
        <Button href="https://www.styrbyapp.com/costs">
          View Full Analytics
        </Button>
      </Section>

      <Divider />

      <Paragraph>
        <strong className="text-zinc-100">Pro tip:</strong> Set up budget alerts to
        get notified before you overspend.{' '}
        <a href="https://www.styrbyapp.com/settings" className="text-brand underline">
          Configure alerts →
        </a>
      </Paragraph>

      <Text className="m-0 text-sm text-zinc-400">
        Have a great weekend!
        <br />— The Styrby Team
      </Text>
    </BaseLayout>
  );
}
