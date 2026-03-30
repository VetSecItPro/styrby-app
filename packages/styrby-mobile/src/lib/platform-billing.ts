/**
 * Platform Billing Utilities
 *
 * WHY this file exists — Apple Reader App compliance:
 * Apple App Store Review Guidelines §3.1.3(a) classifies Styrby as a "Reader
 * App" because it provides access to previously-purchased content (AI agent
 * sessions managed via a web subscription). Reader Apps are explicitly
 * prohibited from:
 *   - Showing in-app purchase buttons or CTAs
 *   - Displaying pricing information
 *   - Linking to external payment flows (Polar checkout, pricing pages)
 *
 * Android has no equivalent restriction, so all upgrade UI remains fully
 * functional on Android.
 *
 * Usage pattern:
 *   if (canShowUpgradePrompt()) {
 *     // render upgrade button + Polar link
 *   } else {
 *     // render informational gate only — NO button, NO price, NO link
 *   }
 *
 * @module src/lib/platform-billing
 */

import { Platform } from 'react-native';

/** Polar customer portal URL used for subscription management on Android. */
export const POLAR_CUSTOMER_PORTAL_URL = 'https://polar.sh/styrby/portal';

// ============================================================================
// Core Gate
// ============================================================================

/**
 * Returns true when the current platform is allowed to show upgrade CTAs,
 * pricing, and links to external payment flows.
 *
 * WHY: iOS (App Store) prohibits Reader Apps from showing purchase prompts
 * or linking to web billing. Android has no such restriction.
 *
 * @returns `true` on Android (and any other non-iOS platform); `false` on iOS
 *
 * @example
 * if (canShowUpgradePrompt()) {
 *   // Android: show "Upgrade — $29/mo" button → Polar
 * } else {
 *   // iOS: show "Pro plan required" — no button, no price, no link
 * }
 */
export function canShowUpgradePrompt(): boolean {
  return Platform.OS !== 'ios';
}

// ============================================================================
// Message Helpers
// ============================================================================

/**
 * Returns an upgrade message appropriate for the current platform.
 *
 * - iOS: Plain informational message, no price, no call-to-action.
 *   Apple Reader App rules prohibit in-app purchase UI.
 * - Android: Full CTA message including plan name and price.
 *
 * @param feature - Human-readable feature name (e.g. "Session Replay")
 * @param tier - Required subscription tier ('pro' | 'power')
 * @returns Platform-appropriate upgrade message string
 *
 * @example
 * <Text>{getUpgradeMessage('Budget Alerts', 'pro')}</Text>
 * // iOS   → "Budget Alerts requires a Pro subscription"
 * // Android → "Budget Alerts requires Pro — Upgrade for $29/mo"
 */
export function getUpgradeMessage(
  feature: string,
  tier: 'pro' | 'power' = 'pro'
): string {
  const tierLabel = tier === 'power' ? 'Power' : 'Pro';

  if (Platform.OS === 'ios') {
    // WHY: Apple prohibits displaying pricing or upgrade CTAs in Reader Apps.
    // Plain informational text only — no price, no action link.
    return `${feature} requires a ${tierLabel} subscription`;
  }

  const price = tier === 'power' ? '$59/mo' : '$29/mo';
  return `${feature} requires ${tierLabel} — Upgrade for ${price}`;
}

/**
 * Returns the upgrade button label for the current platform.
 *
 * iOS returns null — no button should be shown.
 * Android returns a label string suitable for a Pressable.
 *
 * @param tier - Required subscription tier ('pro' | 'power')
 * @returns Button label string on Android; null on iOS
 *
 * @example
 * const label = getUpgradeButtonLabel('pro');
 * if (label) {
 *   return <Pressable><Text>{label}</Text></Pressable>;
 * }
 */
export function getUpgradeButtonLabel(
  tier: 'pro' | 'power' = 'pro'
): string | null {
  if (Platform.OS === 'ios') {
    // WHY: Apple Reader App rules — no purchase/upgrade buttons on iOS.
    return null;
  }
  return tier === 'power' ? 'Upgrade to Power' : 'Upgrade to Pro';
}

/**
 * Returns the iOS-safe "manage subscription" note shown in place of a button.
 *
 * WHY: iOS Reader Apps may tell users *where* they can manage their
 * subscription (e.g. "Manage at styrbyapp.com") but cannot show a button
 * that initiates a purchase or links directly to a payment page.
 * This note satisfies the informational intent without violating §3.1.3(a).
 *
 * @returns Informational string for iOS; null on other platforms (button is shown instead)
 */
export function getIosManageNote(): string | null {
  if (Platform.OS !== 'ios') {
    return null;
  }
  return 'Manage your subscription at styrbyapp.com';
}
