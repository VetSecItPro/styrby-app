/**
 * TierCapWarning (Mobile)
 *
 * React Native parity for the web TierCapWarning component.
 * Shows a dismissable banner when month-to-date spend hits 80%+ of tier cap.
 *
 * WHY: Mobile parity rule (feedback_web_mobile_parity.md) — every user-facing
 * feature must ship on BOTH platforms.
 *
 * Snooze: persisted via AsyncStorage for 24 hours.
 *
 * @module components/costs/TierCapWarning
 */

import { useState, useEffect } from 'react';
import { View, Text, Pressable } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

// ============================================================================
// Constants
// ============================================================================

/** Tier monthly caps in USD — mirrors TIERS config and web version */
const TIER_MONTHLY_CAP_USD: Record<string, number> = {
  free: 0,
  power: 49,
  team: 19,
  business: 39,
};

/** Upgrade copy per tier */
const UPGRADE_COPY: Record<string, string> = {
  free: 'Upgrade to Power',
  power: 'Upgrade to Team',
  team: 'Upgrade to Business',
  business: 'Contact us',
};

const SNOOZE_KEY = 'tier_cap_warning_snoozed_until';
const SNOOZE_DURATION_MS = 24 * 60 * 60 * 1000;

// ============================================================================
// Types
// ============================================================================

/**
 * Props for {@link TierCapWarning}.
 */
export interface TierCapWarningProps {
  /** User's current subscription tier */
  tier: string;
  /** Month-to-date USD spend */
  monthToDateSpendUsd: number;
}

// ============================================================================
// Component
// ============================================================================

/**
 * Renders a dismissable warning banner when spend hits 80%+ of tier cap.
 *
 * Taps "Upgrade" navigate to the pricing page.
 * Dismiss button snoozes for 24h via AsyncStorage.
 *
 * @param props - Component props
 * @returns Banner or null
 *
 * @example
 * <TierCapWarning tier="power" monthToDateSpendUsd={39.50} />
 */
export function TierCapWarning({ tier, monthToDateSpendUsd }: TierCapWarningProps) {
  const [visible, setVisible] = useState(false);
  const router = useRouter();

  const cap = TIER_MONTHLY_CAP_USD[tier] ?? 0;
  if (cap === 0) return null;

  const pct = Math.round((monthToDateSpendUsd / cap) * 100);

  useEffect(() => {
    if (pct < 80) {
      setVisible(false);
      return;
    }

    void (async () => {
      try {
        const snoozeUntil = await AsyncStorage.getItem(SNOOZE_KEY);
        if (snoozeUntil && Date.now() < Number(snoozeUntil)) {
          setVisible(false);
          return;
        }
      } catch {
        // AsyncStorage unavailable — show the banner
      }
      setVisible(true);
    })();
  }, [pct]);

  if (!visible) return null;

  const upgradeCta = UPGRADE_COPY[tier] ?? 'Upgrade';

  async function handleSnooze() {
    try {
      await AsyncStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_DURATION_MS));
    } catch {
      // Ignore storage errors
    }
    setVisible(false);
  }

  return (
    <View
      className="mx-4 mb-3 rounded-xl flex-row items-start gap-2 p-3"
      style={{ backgroundColor: '#451a03', borderWidth: 1, borderColor: '#92400e' }}
      accessibilityRole="alert"
    >
      <Ionicons name="warning-outline" size={16} color="#fde68a" style={{ marginTop: 2 }} />

      <View className="flex-1">
        <Text className="text-xs leading-5" style={{ color: '#fde68a' }}>
          You&apos;ve used{' '}
          <Text style={{ fontWeight: '700' }}>{pct}%</Text> of your{' '}
          <Text style={{ textTransform: 'capitalize' }}>{tier}</Text> tier ($
          {monthToDateSpendUsd.toFixed(2)} of ${cap}).{'  '}
          <Text
            style={{ fontWeight: '700', textDecorationLine: 'underline' }}
            onPress={() => router.push('/pricing' as never)}
          >
            {upgradeCta}
          </Text>
        </Text>
      </View>

      <Pressable
        onPress={handleSnooze}
        accessibilityLabel="Dismiss for 24 hours"
        accessibilityRole="button"
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Ionicons name="close" size={16} color="#a16207" />
      </Pressable>
    </View>
  );
}
