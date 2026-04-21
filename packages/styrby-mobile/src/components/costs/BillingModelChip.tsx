/**
 * BillingModelChip (Mobile)
 *
 * Compact React Native badge showing how a cost was billed.
 * Mirrors the logic in packages/styrby-web/src/components/costs/BillingModelChip.tsx
 * to ensure web/mobile parity per the feedback_web_mobile_parity memory.
 *
 * Four billing models from migration 022:
 *   'api-key'      → "API"   (blue)
 *   'subscription' → "SUB"   (purple)
 *   'credit'       → "CR"    (amber)
 *   'free'         → "FREE"  (zinc)
 *
 * @module components/costs/BillingModelChip
 */

import { View, Text } from 'react-native';
import type { BillingModel, CostSource } from 'styrby-shared';

// ============================================================================
// Label / colour maps
// ============================================================================

/** Short label displayed inside the chip. */
export const BILLING_MODEL_LABEL: Record<BillingModel, string> = {
  'api-key': 'API',
  subscription: 'SUB',
  credit: 'CR',
  free: 'FREE',
};

/** Background colour for each billing model chip. */
const BILLING_BG: Record<BillingModel, string> = {
  'api-key': '#1e3a5f',      // dark blue tint
  subscription: '#3b1d6e',   // dark purple tint
  credit: '#6b4800',         // dark amber tint
  free: '#27272a',           // zinc-800
};

/** Text colour for each billing model chip. */
const BILLING_TEXT: Record<BillingModel, string> = {
  'api-key': '#60a5fa',      // blue-400
  subscription: '#c084fc',   // purple-400
  credit: '#fbbf24',         // amber-400
  free: '#a1a1aa',           // zinc-400
};

// ============================================================================
// BillingModelChip
// ============================================================================

/**
 * Props for {@link BillingModelChip}.
 */
export interface BillingModelChipProps {
  /** Billing model to display. */
  billingModel: BillingModel;
}

/**
 * Compact React Native badge showing the billing model.
 *
 * @param props - Component props
 * @returns View element styled as a badge
 *
 * @example
 * <BillingModelChip billingModel="api-key" />
 * <BillingModelChip billingModel="subscription" />
 */
export function BillingModelChip({ billingModel }: BillingModelChipProps) {
  return (
    <View
      style={{
        backgroundColor: BILLING_BG[billingModel],
        borderRadius: 4,
        paddingHorizontal: 5,
        paddingVertical: 2,
        alignSelf: 'flex-start',
      }}
      accessibilityLabel={`Billing model: ${billingModel}`}
    >
      <Text
        style={{
          color: BILLING_TEXT[billingModel],
          fontSize: 10,
          fontWeight: '700',
          textTransform: 'uppercase',
          letterSpacing: 0.5,
        }}
      >
        {BILLING_MODEL_LABEL[billingModel]}
      </Text>
    </View>
  );
}

// ============================================================================
// SourceBadge
// ============================================================================

/**
 * Props for {@link SourceBadge}.
 */
export interface SourceBadgeProps {
  /** Whether cost data came from the agent or was estimated. */
  source: CostSource;
}

/**
 * Small letter badge indicating cost data provenance.
 * "R" = agent-reported (green), "E" = Styrby estimate (amber).
 *
 * WHY letter badge: Colour alone fails WCAG 1.4.1. A letter + colour
 * combination is perceivable by users with colour blindness.
 *
 * @param props - Component props
 * @returns Compact badge element
 */
export function SourceBadge({ source }: SourceBadgeProps) {
  const isReported = source === 'agent-reported';
  const label = isReported ? 'R' : 'E';
  const bg = isReported ? '#14532d' : '#78350f';        // dark green / dark amber
  const textColor = isReported ? '#4ade80' : '#fbbf24'; // green-400 / amber-400

  return (
    <View
      style={{
        backgroundColor: bg,
        borderRadius: 4,
        paddingHorizontal: 4,
        paddingVertical: 2,
        alignSelf: 'flex-start',
      }}
      accessibilityLabel={isReported ? 'Agent-reported cost' : 'Styrby estimate cost'}
    >
      <Text
        style={{
          color: textColor,
          fontSize: 10,
          fontWeight: '800',
        }}
      >
        {label}
      </Text>
    </View>
  );
}
