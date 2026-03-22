/**
 * Support Reply Email
 *
 * Sent when an admin replies to a user's support ticket.
 * Includes the ticket subject, the admin's reply, and a link
 * to view the full ticket in the dashboard.
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

interface SupportReplyEmailProps {
  /** The original ticket subject */
  subject: string;
  /** The admin's reply message */
  message: string;
  /** The ticket ID for building the dashboard link */
  ticketId: string;
}

export default function SupportReplyEmail({
  subject,
  message,
  ticketId,
}: SupportReplyEmailProps) {
  return (
    <BaseLayout preview={`Re: ${subject}`}>
      <Heading>Re: {subject}</Heading>

      <Paragraph>We have responded to your support ticket:</Paragraph>

      <Section className="mb-6 rounded-lg bg-zinc-800 p-4">
        <Text className="m-0 whitespace-pre-wrap text-sm leading-6 text-zinc-200">
          {message}
        </Text>
      </Section>

      <Section className="mb-6 text-center">
        <Button href={`https://www.styrbyapp.com/dashboard/support/${ticketId}`}>
          View Ticket
        </Button>
      </Section>

      <Divider />

      <Paragraph>
        You can reply to this ticket directly from your Styrby dashboard.
        If you need anything else, just open a new ticket.
      </Paragraph>

      <Text className="m-0 text-sm text-zinc-400">
        The Styrby Team
      </Text>
    </BaseLayout>
  );
}
