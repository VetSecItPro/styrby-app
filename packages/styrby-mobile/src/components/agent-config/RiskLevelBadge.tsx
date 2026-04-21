/**
 * Agent Configuration — RiskLevelBadge
 *
 * Colored pill displayed next to auto-approve toggles to communicate the
 * trust level the user is granting (Low / Medium / High).
 *
 * WHY: Extracted as its own file so the badge styling lives next to the risk
 * constants and can be reused by future settings screens without redefining
 * the pill geometry.
 */

import { View, Text } from 'react-native';
import type { RiskBadge } from '@/types/agent-config';

export interface RiskLevelBadgeProps {
  /** Risk-level metadata (label + colors) to render. */
  risk: RiskBadge;
}

/**
 * A risk-level badge displayed next to auto-approve toggles.
 *
 * @param props - Risk badge metadata (label, colors)
 * @returns React element
 */
export function RiskLevelBadge({ risk }: RiskLevelBadgeProps) {
  return (
    <View
      className="px-2 py-0.5 rounded-full mr-2"
      style={{ backgroundColor: risk.bgColor }}
    >
      <Text className="text-xs font-semibold" style={{ color: risk.textColor }}>
        {risk.label}
      </Text>
    </View>
  );
}
