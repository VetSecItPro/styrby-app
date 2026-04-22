/**
 * Feedback Alert Email (Founder-Facing)
 *
 * Sent to the founder email when a user submits general in-app feedback.
 * This is an internal operational email — not a user-facing template.
 *
 * WHY: Founders need immediate visibility into every general feedback
 * submission. At launch volume (< 100/day), per-submission emails are
 * the right mechanism. When volume grows, this becomes a daily digest.
 *
 * Privacy: user_id is partially shown (last 8 chars) to allow correlation
 * without exposing the full UUID in email clients that might log headers.
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

interface FeedbackAlertEmailProps {
  /** The full user_id (shown truncated in email) */
  userId: string;
  /** The feedback message body */
  message: string;
  /** Optional user-provided reply email */
  replyEmail?: string;
  /** The feedback UUID for the founder dashboard link */
  feedbackId: string;
  /** Screen/route context (no PII) */
  screen?: string;
}

export default function FeedbackAlertEmail({
  userId,
  message,
  replyEmail,
  feedbackId,
  screen,
}: FeedbackAlertEmailProps) {
  const userRef = userId.slice(-8);
  const dashboardUrl = `https://www.styrbyapp.com/dashboard/founder/feedback`;

  return (
    <BaseLayout preview={`New feedback: ${message.slice(0, 80)}`}>
      <Heading>New user feedback</Heading>

      <Paragraph>
        A user just submitted feedback via the Styrby app.
      </Paragraph>

      {/* Metadata row */}
      <Section className="mb-4 rounded-lg bg-zinc-800 p-4">
        <Text className="m-0 text-xs text-zinc-400">
          User ref: ...{userRef}
          {screen ? ` - From: ${screen}` : ''}
          {replyEmail ? ` - Reply: ${replyEmail}` : ''}
        </Text>
      </Section>

      {/* Message body */}
      <Section className="mb-6 rounded-lg bg-zinc-700 p-4">
        <Text className="m-0 whitespace-pre-wrap text-sm leading-6 text-zinc-100">
          {message}
        </Text>
      </Section>

      {replyEmail ? (
        <Paragraph>
          The user provided a reply email. You can reply directly to this
          email to reach them at {replyEmail}.
        </Paragraph>
      ) : (
        <Paragraph>
          The user did not provide a reply email. To follow up, view their
          account in the founder dashboard.
        </Paragraph>
      )}

      <Section className="mb-6 text-center">
        <Button href={`${dashboardUrl}?feedbackId=${feedbackId}`}>
          View in Dashboard
        </Button>
      </Section>

      <Divider />

      <Text className="m-0 text-xs text-zinc-400">
        Feedback ID: {feedbackId}
      </Text>
    </BaseLayout>
  );
}
