/**
 * Platform Billing Utility Tests
 *
 * Tests the Apple App Store §3.1.3(a) Reader App compliance helpers.
 * The helpers gate upgrade CTA visibility and messaging by platform (iOS vs Android).
 *
 * Covers:
 * - canShowUpgradePrompt() returns false on iOS, true on Android
 * - getUpgradeMessage() returns iOS-safe (no price) vs Android (with price)
 * - getUpgradeButtonLabel() returns null on iOS, label string on Android
 * - getIosManageNote() returns note on iOS, null on Android
 * - Default tier argument behaviour ('pro' is default)
 * - 'power' tier produces correct pricing strings
 *
 * WHY Platform.OS is set in jest.setup.js:
 * react-native is mocked globally with Platform.OS = 'ios'. To test Android
 * behaviour we use jest.replaceProperty on the Platform mock.
 */

import { Platform } from 'react-native';
import {
  canShowUpgradePrompt,
  getUpgradeMessage,
  getUpgradeButtonLabel,
  getIosManageNote,
  POLAR_CUSTOMER_PORTAL_URL,
} from '../platform-billing';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Temporarily overrides Platform.OS for the scope of a single test block.
 * Uses jest.replaceProperty so the original value is restored after each test.
 */
function setPlatform(os: 'ios' | 'android') {
  jest.replaceProperty(Platform, 'OS', os);
}

// ============================================================================
// Test Suite
// ============================================================================

describe('Platform Billing Utilities', () => {
  // Reset Platform.OS back to the jest.setup.js default ('ios') after each test.
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // Constants
  // --------------------------------------------------------------------------

  describe('POLAR_CUSTOMER_PORTAL_URL', () => {
    it('exports the Polar portal URL', () => {
      expect(POLAR_CUSTOMER_PORTAL_URL).toBe('https://polar.sh/styrby/portal');
    });
  });

  // --------------------------------------------------------------------------
  // canShowUpgradePrompt()
  // --------------------------------------------------------------------------

  describe('canShowUpgradePrompt()', () => {
    it('returns false on iOS (App Store Reader App rules prohibit upgrade UI)', () => {
      setPlatform('ios');
      expect(canShowUpgradePrompt()).toBe(false);
    });

    it('returns true on Android (no equivalent App Store restriction)', () => {
      setPlatform('android');
      expect(canShowUpgradePrompt()).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // getUpgradeMessage()
  // --------------------------------------------------------------------------

  describe('getUpgradeMessage()', () => {
    describe('on iOS', () => {
      beforeEach(() => setPlatform('ios'));

      it('returns informational text without price for pro tier', () => {
        const msg = getUpgradeMessage('Budget Alerts', 'pro');
        expect(msg).toBe('Budget Alerts requires a Pro subscription');
        // WHY no price: Apple §3.1.3(a) prohibits in-app pricing display
        expect(msg).not.toContain('$');
      });

      it('returns informational text without price for power tier', () => {
        const msg = getUpgradeMessage('Session Replay', 'power');
        expect(msg).toBe('Session Replay requires a Power subscription');
        expect(msg).not.toContain('$');
      });

      it('defaults to pro tier when no tier argument is provided', () => {
        const msg = getUpgradeMessage('Some Feature');
        expect(msg).toBe('Some Feature requires a Pro subscription');
      });

      it('includes the feature name in the message', () => {
        const msg = getUpgradeMessage('Webhook Notifications', 'pro');
        expect(msg).toContain('Webhook Notifications');
      });
    });

    describe('on Android', () => {
      beforeEach(() => setPlatform('android'));

      it('returns upgrade CTA with price for pro tier', () => {
        const msg = getUpgradeMessage('Budget Alerts', 'pro');
        expect(msg).toBe('Budget Alerts requires Pro — Upgrade for $29/mo');
        expect(msg).toContain('$29/mo');
      });

      it('returns upgrade CTA with price for power tier', () => {
        const msg = getUpgradeMessage('Session Replay', 'power');
        expect(msg).toBe('Session Replay requires Power — Upgrade for $59/mo');
        expect(msg).toContain('$59/mo');
      });

      it('defaults to pro tier on Android', () => {
        const msg = getUpgradeMessage('Some Feature');
        expect(msg).toBe('Some Feature requires Pro — Upgrade for $29/mo');
      });

      it('includes the feature name in the Android CTA', () => {
        const msg = getUpgradeMessage('API Keys', 'power');
        expect(msg).toContain('API Keys');
      });
    });
  });

  // --------------------------------------------------------------------------
  // getUpgradeButtonLabel()
  // --------------------------------------------------------------------------

  describe('getUpgradeButtonLabel()', () => {
    describe('on iOS', () => {
      beforeEach(() => setPlatform('ios'));

      it('returns null for pro tier (no button on iOS)', () => {
        expect(getUpgradeButtonLabel('pro')).toBeNull();
      });

      it('returns null for power tier (no button on iOS)', () => {
        expect(getUpgradeButtonLabel('power')).toBeNull();
      });

      it('returns null with default tier argument', () => {
        expect(getUpgradeButtonLabel()).toBeNull();
      });
    });

    describe('on Android', () => {
      beforeEach(() => setPlatform('android'));

      it('returns "Upgrade to Pro" label for pro tier', () => {
        expect(getUpgradeButtonLabel('pro')).toBe('Upgrade to Pro');
      });

      it('returns "Upgrade to Power" label for power tier', () => {
        expect(getUpgradeButtonLabel('power')).toBe('Upgrade to Power');
      });

      it('defaults to pro label when no tier is provided', () => {
        expect(getUpgradeButtonLabel()).toBe('Upgrade to Pro');
      });
    });
  });

  // --------------------------------------------------------------------------
  // getIosManageNote()
  // --------------------------------------------------------------------------

  describe('getIosManageNote()', () => {
    it('returns the manage note on iOS', () => {
      setPlatform('ios');
      const note = getIosManageNote();
      expect(note).toBe('Manage your subscription at styrbyapp.com');
    });

    it('returns null on Android (button is shown instead)', () => {
      setPlatform('android');
      expect(getIosManageNote()).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Integration — typical gating pattern
  // --------------------------------------------------------------------------

  describe('typical gating pattern', () => {
    it('iOS: prompt disabled, note visible, no button', () => {
      setPlatform('ios');

      expect(canShowUpgradePrompt()).toBe(false);
      expect(getUpgradeButtonLabel('pro')).toBeNull();
      expect(getIosManageNote()).not.toBeNull();
      // Message is safe for iOS (no price)
      const msg = getUpgradeMessage('Dashboard', 'pro');
      expect(msg).not.toMatch(/\$\d+/);
    });

    it('Android: prompt enabled, button visible, no manage note', () => {
      setPlatform('android');

      expect(canShowUpgradePrompt()).toBe(true);
      expect(getUpgradeButtonLabel('pro')).toBe('Upgrade to Pro');
      expect(getIosManageNote()).toBeNull();
      // Message includes price
      const msg = getUpgradeMessage('Dashboard', 'pro');
      expect(msg).toMatch(/\$\d+/);
    });
  });
});
