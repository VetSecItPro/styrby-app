/**
 * Team Invitation Email (Phase 2.2 — updated to support 'viewer' role)
 *
 * Sent when a team owner or admin invites someone to join a team.
 * Supports all three invitation roles: admin, member, and viewer.
 *
 * WHY 'viewer' added in Phase 2.2:
 *   The team invitation flow spec requires the role enum to include 'viewer'.
 *   The DB migration 027 extended the team_invitations.role CHECK constraint.
 *   The email must reflect the correct role label so recipients understand
 *   their access level before accepting.
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

/**
 * Props for the team invitation email template.
 */
interface TeamInvitationEmailProps {
  /** The team's display name. */
  teamName: string;
  /** Display name of the person who sent the invite. */
  inviterName: string;
  /** Email address of the inviter (shown for transparency). */
  inviterEmail: string;
  /**
   * Role the invitee will have upon acceptance.
   * 'viewer' was added in Phase 2.2 — viewers can read sessions but not
   * contribute or manage team settings.
   */
  role: 'admin' | 'member' | 'viewer';
  /** Full accept URL including the raw invite token (query param). */
  inviteUrl: string;
  /** ISO 8601 expiration timestamp (24h from invitation creation). */
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

/**
 * Returns the display label for a role.
 *
 * @param role - Team role
 * @returns Human-readable article + label string
 */
function roleLabel(role: 'admin' | 'member' | 'viewer'): string {
  switch (role) {
    case 'admin':
      return 'an admin';
    case 'viewer':
      return 'a viewer';
    default:
      return 'a member';
  }
}

/**
 * Returns the capitalized display name for a role.
 *
 * @param role - Team role
 * @returns Capitalized role name
 */
function roleDisplay(role: 'admin' | 'member' | 'viewer'): string {
  switch (role) {
    case 'admin':
      return 'Admin';
    case 'viewer':
      return 'Viewer';
    default:
      return 'Member';
  }
}

/**
 * Team invitation React Email template.
 *
 * Rendered by the web server's Resend integration for Next.js API routes.
 * The edge function (teams-invite) uses an inline HTML fallback that mirrors
 * this template's structure but renders without React.
 */
export default function TeamInvitationEmail({
  teamName,
  inviterName,
  inviterEmail,
  role,
  inviteUrl,
  expiresAt,
}: TeamInvitationEmailProps) {
  const label = roleLabel(role);
  const display = roleDisplay(role);
  const expirationDate = formatExpirationDate(expiresAt);

  return (
    <BaseLayout preview={`You've been invited to join ${teamName} on Styrby`}>
      <Heading>You&apos;re invited to join {teamName}</Heading>

      <Paragraph>
        <strong className="text-zinc-100">{inviterName}</strong> ({inviterEmail})
        has invited you to join <strong className="text-zinc-100">{teamName}</strong> as{' '}
        {label} on Styrby.
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
          {display}
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
        The Styrby Team
      </Text>
    </BaseLayout>
  );
}
