/**
 * Subscription Confirmed Email
 * Sent when user upgrades to Pro or Power tier.
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

interface SubscriptionConfirmedEmailProps {
  displayName?: string;
  tier: 'pro' | 'power';
  amount: string;
  billingCycle: 'monthly' | 'annual';
  nextBillingDate: string;
}

const tierFeatures = {
  pro: [
    'Unlimited machines',
    'Unlimited sessions',
    'Cost analytics dashboard',
    'Budget alerts',
    'Email support',
  ],
  power: [
    'Everything in Pro',
    'Team collaboration',
    'API access',
    'Custom integrations',
    'Priority support',
    'Early access to features',
  ],
};

export default function SubscriptionConfirmedEmail({
  displayName,
  tier,
  amount,
  billingCycle,
  nextBillingDate,
}: SubscriptionConfirmedEmailProps) {
  const name = displayName || 'there';
  const tierName = tier === 'pro' ? 'Pro' : 'Power';
  const features = tierFeatures[tier];

  return (
    <BaseLayout preview={`You're now on Styrby ${tierName}!`}>
      <Heading>You&apos;re on {tierName}!</Heading>

      <Paragraph>Hey {name},</Paragraph>

      <Paragraph>
        Thanks for upgrading to Styrby {tierName}! Your subscription is now active
        and you have access to all {tierName} features.
      </Paragraph>

      {/* Receipt */}
      <Section className="mb-6 rounded-lg bg-zinc-800 p-4">
        <Text className="m-0 mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">
          Receipt
        </Text>
        <Text className="m-0 mb-1 text-sm text-zinc-300">
          <strong className="text-zinc-100">Plan:</strong> Styrby {tierName} ({billingCycle})
        </Text>
        <Text className="m-0 mb-1 text-sm text-zinc-300">
          <strong className="text-zinc-100">Amount:</strong> {amount}
        </Text>
        <Text className="m-0 text-sm text-zinc-300">
          <strong className="text-zinc-100">Next billing:</strong> {nextBillingDate}
        </Text>
      </Section>

      <Paragraph>
        <strong className="text-zinc-100">What&apos;s unlocked:</strong>
      </Paragraph>

      <Section className="mb-6">
        {features.map((feature, index) => (
          <Text key={index} className="m-0 mb-2 text-sm text-zinc-300">
            <span className="mr-2 text-green-500">✓</span>
            {feature}
          </Text>
        ))}
      </Section>

      <Section className="text-center">
        <Button href="https://www.styrbyapp.com/dashboard">
          Explore {tierName} Features
        </Button>
      </Section>

      <Divider />

      <Paragraph>
        Need to manage your subscription? Visit your{' '}
        <a href="https://www.styrbyapp.com/settings" className="text-brand underline">
          account settings
        </a>
        .
      </Paragraph>

      <Text className="m-0 text-sm text-zinc-400">
        — The Styrby Team
      </Text>
    </BaseLayout>
  );
}
