/**
 * Digest Email
 *
 * Sent by /api/cron/generate-digest after a daily (Growth) or weekly
 * (Pro+Growth) digest is generated. Body is the LLM-written narrative
 * + a CTA to view the dashboard. Footer carries an unsubscribe link
 * to notification preferences.
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

export interface DigestEmailProps {
  /** 'daily' or 'weekly' — controls the subject and intro copy. */
  period: 'daily' | 'weekly';
  /** Human label for the period (e.g. "May 4" or "week of May 4"). */
  dateLabel: string;
  /** Number of sessions in the digest window. */
  sessionCount: number;
  /** AI-generated digest narrative (2-3 sentences). */
  content: string;
  /** Optional display name for personalization. */
  displayName?: string;
}

export default function DigestEmail({
  period,
  dateLabel,
  sessionCount,
  content,
  displayName,
}: DigestEmailProps) {
  const name = displayName || 'there';
  const periodWord = period === 'weekly' ? 'week' : 'day';

  return (
    <BaseLayout preview="Here's what your AI got up to.">
      <Heading>Your Styrby digest</Heading>

      <Paragraph>Hey {name},</Paragraph>
      <Paragraph>
        Here&apos;s a quick look at your coding {periodWord}, {dateLabel}.
      </Paragraph>

      <Section
        style={{
          backgroundColor: '#18181b',
          borderRadius: '8px',
          padding: '20px',
          marginBottom: '24px',
          border: '1px solid #27272a',
        }}
      >
        <Text
          style={{
            margin: '0 0 8px',
            fontSize: '12px',
            fontWeight: '600',
            color: '#a1a1aa',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          {sessionCount} session{sessionCount === 1 ? '' : 's'}
        </Text>
        <Text
          style={{
            margin: '0',
            fontSize: '15px',
            lineHeight: '1.6',
            color: '#f4f4f5',
          }}
        >
          {content}
        </Text>
      </Section>

      <Section style={{ textAlign: 'center', marginBottom: '24px' }}>
        <Button href="https://www.styrbyapp.com/dashboard">View in dashboard</Button>
      </Section>

      <Divider />

      <Paragraph>
        <span style={{ fontSize: '12px', color: '#71717a' }}>
          You&apos;re receiving this because digest emails are enabled on your
          Styrby account. Manage your preferences in{' '}
          <a
            href="https://www.styrbyapp.com/settings/notifications"
            style={{ color: '#a1a1aa', textDecoration: 'underline' }}
          >
            notification settings
          </a>
          .
        </span>
      </Paragraph>
    </BaseLayout>
  );
}
