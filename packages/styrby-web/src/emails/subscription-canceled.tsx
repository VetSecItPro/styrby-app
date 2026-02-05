/**
 * Subscription Canceled Email
 * Sent when user cancels their subscription.
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

interface SubscriptionCanceledEmailProps {
  displayName?: string;
  tier: 'pro' | 'power';
  accessUntil: string;
}

export default function SubscriptionCanceledEmail({
  displayName,
  tier,
  accessUntil,
}: SubscriptionCanceledEmailProps) {
  const name = displayName || 'there';
  const tierName = tier === 'pro' ? 'Pro' : 'Power';

  return (
    <BaseLayout preview="Your Styrby subscription has been canceled">
      <Heading>Subscription Canceled</Heading>

      <Paragraph>Hey {name},</Paragraph>

      <Paragraph>
        We&apos;ve canceled your Styrby {tierName} subscription as requested. You&apos;ll
        continue to have access to {tierName} features until{' '}
        <strong className="text-zinc-100">{accessUntil}</strong>.
      </Paragraph>

      <Section className="mb-6 rounded-lg bg-zinc-800 p-4">
        <Text className="m-0 mb-2 text-sm text-zinc-300">
          <strong className="text-zinc-100">After {accessUntil}:</strong>
        </Text>
        <Text className="m-0 mb-1 text-sm text-zinc-400">
          • Your account will revert to the Free plan
        </Text>
        <Text className="m-0 mb-1 text-sm text-zinc-400">
          • Sessions and data will be preserved
        </Text>
        <Text className="m-0 text-sm text-zinc-400">
          • You can resubscribe anytime
        </Text>
      </Section>

      <Paragraph>
        Changed your mind? You can reactivate your subscription before {accessUntil} and
        keep all your {tierName} features.
      </Paragraph>

      <Section className="text-center">
        <Button href="https://www.styrbyapp.com/pricing">
          Reactivate Subscription
        </Button>
      </Section>

      <Divider />

      <Paragraph>
        <strong className="text-zinc-100">We&apos;d love your feedback.</strong> What could
        we have done better? Just reply to this email — it goes straight to our team.
      </Paragraph>

      <Text className="m-0 text-sm text-zinc-400">
        — The Styrby Team
      </Text>
    </BaseLayout>
  );
}
