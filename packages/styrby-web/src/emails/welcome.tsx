/**
 * Welcome Email
 * Sent when a new user signs up.
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

interface WelcomeEmailProps {
  displayName?: string;
}

export default function WelcomeEmail({ displayName }: WelcomeEmailProps) {
  const name = displayName || 'there';

  return (
    <BaseLayout preview="Welcome to Styrby - Control your AI coding agents from anywhere">
      <Heading>Welcome to Styrby!</Heading>

      <Paragraph>Hey {name},</Paragraph>

      <Paragraph>
        Thanks for signing up! Styrby gives you full control over your AI coding
        agents (Claude Code, Codex, Gemini CLI) right from your phone.
      </Paragraph>

      <Paragraph>Here&apos;s what you can do:</Paragraph>

      <Section className="mb-6">
        <Text className="m-0 mb-2 text-sm text-zinc-300">
          <span className="mr-2">📱</span>
          <strong className="text-zinc-100">Approve permissions</strong> — No more
          rushing back to your desk
        </Text>
        <Text className="m-0 mb-2 text-sm text-zinc-300">
          <span className="mr-2">💰</span>
          <strong className="text-zinc-100">Track costs</strong> — Real-time spending
          across all agents
        </Text>
        <Text className="m-0 mb-2 text-sm text-zinc-300">
          <span className="mr-2">🔔</span>
          <strong className="text-zinc-100">Get alerts</strong> — Budget warnings
          before you overspend
        </Text>
        <Text className="m-0 text-sm text-zinc-300">
          <span className="mr-2">📊</span>
          <strong className="text-zinc-100">View sessions</strong> — Full history
          and conversation logs
        </Text>
      </Section>

      <Section className="text-center">
        <Button href="https://www.styrbyapp.com/dashboard">
          Go to Dashboard
        </Button>
      </Section>

      <Divider />

      <Paragraph>
        <strong className="text-zinc-100">Quick start:</strong> Pair your first
        machine by scanning the QR code in the Styrby mobile app.
      </Paragraph>

      <Paragraph>
        Questions? Just reply to this email — we read every message.
      </Paragraph>

      <Text className="m-0 text-sm text-zinc-400">
        — The Styrby Team
      </Text>
    </BaseLayout>
  );
}
