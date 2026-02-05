/**
 * Payment Failed Email
 * Sent when a subscription payment fails (card declined, expired, etc.)
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

interface PaymentFailedEmailProps {
  displayName?: string;
  tier: 'pro' | 'power';
  amount: string;
  lastFourDigits?: string;
  retryDate: string;
}

export default function PaymentFailedEmail({
  displayName,
  tier,
  amount,
  lastFourDigits,
  retryDate,
}: PaymentFailedEmailProps) {
  const name = displayName || 'there';
  const tierName = tier === 'pro' ? 'Pro' : 'Power';
  const cardInfo = lastFourDigits ? ` ending in ${lastFourDigits}` : '';

  return (
    <BaseLayout preview="Action required: Your Styrby payment failed">
      {/* Alert banner */}
      <Section className="mb-6 rounded-lg bg-red-500/10 border border-red-500/20 p-4">
        <Text className="m-0 text-center text-sm font-semibold text-red-400">
          ⚠️ Payment Failed
        </Text>
      </Section>

      <Heading>Payment Issue</Heading>

      <Paragraph>Hey {name},</Paragraph>

      <Paragraph>
        We couldn&apos;t process your payment of <strong className="text-zinc-100">{amount}</strong>
        {' '}for Styrby {tierName}. Your card{cardInfo} was declined.
      </Paragraph>

      <Section className="mb-6 rounded-lg bg-zinc-800 p-4">
        <Text className="m-0 mb-2 text-sm text-zinc-300">
          <strong className="text-zinc-100">What happens next:</strong>
        </Text>
        <Text className="m-0 mb-1 text-sm text-zinc-400">
          • We&apos;ll retry the payment on <strong className="text-zinc-300">{retryDate}</strong>
        </Text>
        <Text className="m-0 mb-1 text-sm text-zinc-400">
          • Your {tierName} access continues until then
        </Text>
        <Text className="m-0 text-sm text-zinc-400">
          • Update your card to avoid interruption
        </Text>
      </Section>

      <Section className="text-center">
        <Button href="https://www.styrbyapp.com/settings">
          Update Payment Method
        </Button>
      </Section>

      <Divider />

      <Paragraph>
        <strong className="text-zinc-100">Common fixes:</strong>
      </Paragraph>
      <Section className="mb-4">
        <Text className="m-0 mb-1 text-sm text-zinc-400">
          • Check if your card has expired
        </Text>
        <Text className="m-0 mb-1 text-sm text-zinc-400">
          • Ensure sufficient funds are available
        </Text>
        <Text className="m-0 mb-1 text-sm text-zinc-400">
          • Contact your bank if the card is active
        </Text>
        <Text className="m-0 text-sm text-zinc-400">
          • Try a different payment method
        </Text>
      </Section>

      <Paragraph>
        Questions? Reply to this email and we&apos;ll help you out.
      </Paragraph>

      <Text className="m-0 text-sm text-zinc-400">
        — The Styrby Team
      </Text>
    </BaseLayout>
  );
}
