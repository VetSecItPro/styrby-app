/**
 * Negative Session Post-Mortem Alert Email (Founder-Facing)
 *
 * Sent to the founder when a session post-mortem comes in with
 * rating = 'not_useful' AND reason > 20 characters.
 *
 * WHY the 20-char threshold: Short reasons ("bad", "slow") provide
 * no actionable context. This filter ensures the email inbox only
 * receives signals that can actually drive product improvements.
 *
 * Privacy: user_id is anonymized to a 12-char SHA-256 prefix.
 * The full user_id is NOT in this email to reduce exposure in
 * email systems (which may log subjects/bodies). The founder can
 * correlate to Supabase using the feedbackId if needed.
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

interface NegativePostmortemEmailProps {
  /** SHA-256 prefix of user_id (first 12 chars) - anonymized */
  userIdHash: string;
  /** Agent type that ran the session */
  agentType: string;
  /** Session duration in minutes (null if unavailable) */
  durationMin: number | null;
  /** User's free-text reason for the negative rating */
  reason: string;
  /** Session UUID for dashboard correlation */
  sessionId: string;
  /** Feedback UUID for dashboard link */
  feedbackId: string;
}

export default function NegativePostmortemEmail({
  userIdHash,
  agentType,
  durationMin,
  reason,
  sessionId,
  feedbackId,
}: NegativePostmortemEmailProps) {
  const agentLabel =
    agentType.charAt(0).toUpperCase() + agentType.slice(1);
  const durationLabel =
    durationMin != null ? `${durationMin} min` : 'unknown duration';

  const dashboardUrl = `https://www.styrbyapp.com/dashboard/founder/feedback`;

  return (
    <BaseLayout preview={`Negative session feedback - ${agentLabel} - ${durationLabel}`}>
      <Heading>Negative session feedback</Heading>

      <Paragraph>
        A user rated a session as &quot;not useful&quot; and left a reason. This
        is a quality regression signal worth investigating.
      </Paragraph>

      {/* Session metadata */}
      <Section className="mb-4 rounded-lg bg-zinc-800 p-4">
        <Text className="m-0 text-xs text-zinc-400">
          Agent: {agentLabel} - Duration: {durationLabel} - User hash: {userIdHash}
        </Text>
      </Section>

      {/* Reason */}
      <Section className="mb-6 rounded-lg bg-red-900/30 border border-red-700/40 p-4">
        <Text className="mb-1 text-xs font-semibold uppercase tracking-wide text-red-400">
          User reason
        </Text>
        <Text className="m-0 whitespace-pre-wrap text-sm leading-6 text-zinc-100">
          {reason}
        </Text>
      </Section>

      <Paragraph>
        Session ID (for Supabase lookup): {sessionId.slice(0, 8)}...
      </Paragraph>

      <Section className="mb-6 text-center">
        <Button href={`${dashboardUrl}?feedbackId=${feedbackId}&tab=postmortems`}>
          View in Feedback Dashboard
        </Button>
      </Section>

      <Divider />

      <Text className="m-0 text-xs text-zinc-400">
        Feedback ID: {feedbackId} - Anonymized; no PII in this email.
      </Text>
    </BaseLayout>
  );
}
