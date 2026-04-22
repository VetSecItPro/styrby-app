/**
 * Weekly Digest Email
 *
 * Sent every Sunday at 17:00 CT via the /api/cron/weekly-digest route.
 * Distinct from weekly-summary.tsx (which is the Friday cost summary email).
 *
 * This digest focuses on:
 *   - Total cost + comparison to last week
 *   - Session count
 *   - Top 3 agents by spend
 *   - Referral program CTA (invite a friend)
 *   - Deep link to the dashboard
 *
 * WHY a separate template from weekly-summary:
 * The weekly-summary email (already shipped) is a general "here are your stats"
 * email. The digest is a retention-focused email with referral CTA and
 * re-engagement copy. Different templates let us A/B test them independently.
 */

import { Section, Text, Link, Row, Column } from '@react-email/components';
import * as React from 'react';
import {
  BaseLayout,
  Button,
  Heading,
  Paragraph,
  Divider,
} from './base-layout';

/** Per-agent stats to render in the digest. */
interface AgentStats {
  /** Display name (e.g. "Claude Code") */
  name: string;
  /** Number of sessions this week */
  sessions: number;
  /** Formatted cost string (e.g. "$3.42") */
  cost: string;
}

export interface WeeklyDigestEmailProps {
  /** User display name for personalization */
  displayName?: string;
  /** Formatted week string (e.g. "April 14") */
  weekOf: string;
  /** Total cost this week (e.g. "$12.47") */
  totalCost: string;
  /** Total session count this week */
  totalSessions: number;
  /** Percentage change vs last week (negative = lower spend) */
  costChange: number;
  /** Top 3 agents by spend */
  agentStats: AgentStats[];
  /** User's referral code (for invite CTA) */
  referralCode?: string;
}

export default function WeeklyDigestEmail({
  displayName,
  weekOf,
  totalCost,
  totalSessions,
  costChange,
  agentStats,
  referralCode,
}: WeeklyDigestEmailProps) {
  const name = displayName || 'there';

  const changeLabel =
    costChange > 0
      ? `${costChange}% more than last week`
      : costChange < 0
      ? `${Math.abs(costChange)}% less than last week`
      : 'Same as last week';

  const changeColor =
    costChange > 0 ? '#f87171' : costChange < 0 ? '#4ade80' : '#a1a1aa';

  const referralUrl = referralCode
    ? `https://www.styrbyapp.com/r/${referralCode}`
    : 'https://www.styrbyapp.com/settings/referral';

  return (
    <BaseLayout
      preview={`Week of ${weekOf}: ${totalCost} spent, ${totalSessions} session${totalSessions !== 1 ? 's' : ''}`}
    >
      <Heading>Your weekly AI coding digest</Heading>

      <Paragraph>Hey {name},</Paragraph>
      <Paragraph>
        Here is your Styrby digest for the week of{' '}
        <strong style={{ color: '#f4f4f5' }}>{weekOf}</strong>.
      </Paragraph>

      {/* Cost highlight */}
      <Section
        style={{
          backgroundColor: '#18181b',
          borderRadius: '8px',
          padding: '20px',
          marginBottom: '24px',
          border: '1px solid #27272a',
        }}
      >
        <Row>
          <Column align="center">
            <Text
              style={{
                margin: '0',
                fontSize: '32px',
                fontWeight: '700',
                color: '#f4f4f5',
                lineHeight: '1.2',
              }}
            >
              {totalCost}
            </Text>
            <Text style={{ margin: '4px 0 0', fontSize: '12px', color: '#a1a1aa' }}>
              Total spent
            </Text>
            <Text style={{ margin: '4px 0 0', fontSize: '12px', color: changeColor }}>
              {changeLabel}
            </Text>
          </Column>
          <Column align="center">
            <Text
              style={{
                margin: '0',
                fontSize: '32px',
                fontWeight: '700',
                color: '#f4f4f5',
                lineHeight: '1.2',
              }}
            >
              {totalSessions}
            </Text>
            <Text style={{ margin: '4px 0 0', fontSize: '12px', color: '#a1a1aa' }}>
              {totalSessions === 1 ? 'Session' : 'Sessions'}
            </Text>
          </Column>
        </Row>
      </Section>

      {/* Agent breakdown */}
      {agentStats.length > 0 && (
        <>
          <Text
            style={{
              margin: '0 0 12px',
              fontSize: '14px',
              fontWeight: '600',
              color: '#f4f4f5',
            }}
          >
            Top agents this week
          </Text>
          {agentStats.map((agent, index) => (
            <Section
              key={index}
              style={{
                backgroundColor: '#18181b',
                borderRadius: '6px',
                padding: '12px 16px',
                marginBottom: '8px',
                border: '1px solid #27272a',
              }}
            >
              <Row>
                <Column>
                  <Text
                    style={{ margin: '0', fontSize: '14px', fontWeight: '500', color: '#f4f4f5' }}
                  >
                    {agent.name}
                  </Text>
                  <Text style={{ margin: '2px 0 0', fontSize: '12px', color: '#a1a1aa' }}>
                    {agent.sessions} session{agent.sessions !== 1 ? 's' : ''}
                  </Text>
                </Column>
                <Column align="right">
                  <Text
                    style={{ margin: '0', fontSize: '14px', fontWeight: '600', color: '#f4f4f5' }}
                  >
                    {agent.cost}
                  </Text>
                </Column>
              </Row>
            </Section>
          ))}
        </>
      )}

      <Divider />

      {/* CTA to dashboard */}
      <Section style={{ textAlign: 'center', marginBottom: '24px' }}>
        <Button href="https://www.styrbyapp.com/dashboard">View Full Dashboard</Button>
      </Section>

      {/* Referral CTA */}
      <Section
        style={{
          backgroundColor: '#1c1917',
          borderRadius: '8px',
          padding: '16px',
          border: '1px solid #292524',
          marginBottom: '24px',
        }}
      >
        <Text
          style={{ margin: '0 0 8px', fontSize: '14px', fontWeight: '600', color: '#f4f4f5' }}
        >
          Know another developer who would love Styrby?
        </Text>
        <Text style={{ margin: '0 0 12px', fontSize: '13px', color: '#a1a1aa' }}>
          Share your invite link. When they upgrade to Power, you both get one free month.
        </Text>
        <Link
          href={referralUrl}
          style={{
            color: '#f97316',
            fontSize: '13px',
            fontWeight: '500',
            textDecoration: 'underline',
          }}
        >
          Get your invite link
        </Link>
      </Section>

      <Text style={{ margin: '0', fontSize: '13px', color: '#71717a' }}>
        Have a great week ahead.
        <br />
        The Styrby Team
      </Text>
    </BaseLayout>
  );
}
