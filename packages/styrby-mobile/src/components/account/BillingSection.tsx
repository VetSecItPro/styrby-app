/**
 * Account Settings — Billing Section
 *
 * Renders the Subscription row (read-only on iOS to comply with App Store
 * Guideline §3.1.3(a)) and the Usage & Costs row that links to the costs
 * tab.
 */

import { View, Linking } from 'react-native';
import { SectionHeader, SettingRow } from '@/components/ui';
import {
  canShowUpgradePrompt,
  POLAR_CUSTOMER_PORTAL_URL,
} from '@/lib/platform-billing';

/**
 * Props consumed by {@link BillingSection}.
 */
export interface BillingSectionProps {
  /** Subscription tier label ('free' | 'power' | …); rendered title-cased */
  tier: string;
  isLoadingTier: boolean;
  monthlySpend: number;
  isLoadingSpend: boolean;
  onPressUsageAndCosts: () => void;
}

/**
 * Billing section: subscription + usage rows.
 *
 * WHY iOS conditional: Apple §3.1.3(a) prohibits linking to external
 * payment flows from within the app. Android shows the upgrade link;
 * iOS shows the subscription row as read-only.
 */
export function BillingSection(props: BillingSectionProps) {
  const { tier, isLoadingTier, monthlySpend, isLoadingSpend, onPressUsageAndCosts } = props;

  return (
    <>
      <SectionHeader title="Billing" />
      <View className="bg-background-secondary">
        <SettingRow
          icon="card"
          iconColor="#22c55e"
          title="Subscription"
          subtitle={isLoadingTier ? 'Loading...' : `${tier.charAt(0).toUpperCase() + tier.slice(1)} Plan`}
          onPress={canShowUpgradePrompt()
            ? () => Linking.openURL(POLAR_CUSTOMER_PORTAL_URL)
            : undefined}
        />
        <SettingRow
          icon="stats-chart"
          iconColor="#3b82f6"
          title="Usage & Costs"
          subtitle={isLoadingSpend ? 'Loading...' : `$${monthlySpend.toFixed(2)} this month`}
          onPress={onPressUsageAndCosts}
        />
      </View>
    </>
  );
}
