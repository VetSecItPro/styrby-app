/**
 * Team Invitation Email
 * Sent when a user is invited to join a team.
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

interface TeamInvitationEmailProps {
  teamName: string;
  inviterName: string;
  inviterEmail: string;
  role: 'admin' | 'member';
  inviteUrl: string;
  expiresAt: string;
}

/**
 * Formats an ISO date string to a human-readable format.
 *
 * @param isoDate - ISO 8601 date string
 * @returns Formatted date like "February 6, 2026"
 */
function formatExpirationDate(isoDate: string): string {
  const date = new Date(isoDate);
  return date.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

export default function TeamInvitationEmail({
  teamName,
  inviterName,
  inviterEmail,
  role,
  inviteUrl,
  expiresAt,
}: TeamInvitationEmailProps) {
  const roleLabel = role === 'admin' ? 'an admin' : 'a member';
  const expirationDate = formatExpirationDate(expiresAt);

  return (
    <BaseLayout preview={`You've been invited to join ${teamName} on Styrby`}>
      <Heading>You&apos;re invited to join {teamName}</Heading>

      <Paragraph>
        <strong className="text-zinc-100">{inviterName}</strong> ({inviterEmail})
        has invited you to join <strong className="text-zinc-100">{teamName}</strong> as{' '}
        {roleLabel} on Styrby.
      </Paragraph>

      <Paragraph>
        As a team member, you&apos;ll be able to view shared coding sessions,
        collaborate on projects, and track costs together.
      </Paragraph>

      <Section className="mb-6 mt-6 text-center">
        <Button href={inviteUrl}>
          Accept Invitation
        </Button>
      </Section>

      <Divider />

      <Section className="mb-4">
        <Text className="m-0 mb-2 text-sm text-zinc-300">
          <strong className="text-zinc-100">Team:</strong> {teamName}
        </Text>
        <Text className="m-0 mb-2 text-sm text-zinc-300">
          <strong className="text-zinc-100">Your role:</strong>{' '}
          {role === 'admin' ? 'Admin' : 'Member'}
        </Text>
        <Text className="m-0 text-sm text-zinc-300">
          <strong className="text-zinc-100">Invited by:</strong> {inviterName}
        </Text>
      </Section>

      <Paragraph>
        This invitation expires on{' '}
        <strong className="text-zinc-100">{expirationDate}</strong>.
        If you don&apos;t want to join this team, you can ignore this email.
      </Paragraph>

      <Text className="m-0 text-sm text-zinc-400">
        — The Styrby Team
      </Text>
    </BaseLayout>
  );
}
