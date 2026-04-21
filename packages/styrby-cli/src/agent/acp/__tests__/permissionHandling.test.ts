import { describe, expect, it } from 'vitest';
import { mapDecisionToOptionId } from '../permissionHandling';

/**
 * mapDecisionToOptionId is the security-critical bridge between the user's
 * decision and the optionId we send to the agent. Wrong mapping = either
 * silently denying approved work, or silently approving denied work.
 */
describe('mapDecisionToOptionId', () => {
  const fullOptions = [
    { optionId: 'proceed_once', name: 'Proceed once' },
    { optionId: 'proceed_always', name: 'Proceed always' },
    { optionId: 'cancel', name: 'Cancel' },
  ];

  describe('approval decisions', () => {
    it('selects proceed_once for "approved"', () => {
      expect(mapDecisionToOptionId('approved', fullOptions)).toBe('proceed_once');
    });

    it('selects proceed_always for "approved_for_session" when available', () => {
      expect(mapDecisionToOptionId('approved_for_session', fullOptions)).toBe('proceed_always');
    });

    it('falls back to proceed_once for approved_for_session if proceed_always absent', () => {
      const opts = [
        { optionId: 'proceed_once', name: 'Proceed once' },
        { optionId: 'cancel', name: 'Cancel' },
      ];
      expect(mapDecisionToOptionId('approved_for_session', opts)).toBe('proceed_once');
    });

    it('matches by name fragment when optionId is unconventional', () => {
      const opts = [
        { optionId: 'opt_a', name: 'Allow once now' },
        { optionId: 'opt_b', name: 'Cancel please' },
      ];
      expect(mapDecisionToOptionId('approved', opts)).toBe('opt_a');
    });

    it('falls back to first option if no proceed_once-like exists', () => {
      const opts = [{ optionId: 'first', name: 'First' }];
      expect(mapDecisionToOptionId('approved', opts)).toBe('first');
    });

    it('returns "proceed_once" sentinel when options array is empty', () => {
      expect(mapDecisionToOptionId('approved', [])).toBe('proceed_once');
    });
  });

  describe('denial decisions', () => {
    it('selects cancel for "denied"', () => {
      expect(mapDecisionToOptionId('denied', fullOptions)).toBe('cancel');
    });

    it('selects cancel for "abort"', () => {
      expect(mapDecisionToOptionId('abort', fullOptions)).toBe('cancel');
    });

    it('matches cancel by name fragment when optionId differs', () => {
      const opts = [{ optionId: 'opt_x', name: 'Cancel the request' }];
      expect(mapDecisionToOptionId('denied', opts)).toBe('opt_x');
    });

    it('returns literal "cancel" when no cancel option exists', () => {
      const opts = [{ optionId: 'proceed_once' }];
      expect(mapDecisionToOptionId('denied', opts)).toBe('cancel');
    });
  });

  it('handles options with missing optionId gracefully', () => {
    const opts = [{ name: 'Once' }, { name: 'Cancel' }];
    expect(mapDecisionToOptionId('approved', opts)).toBe('proceed_once');
    expect(mapDecisionToOptionId('denied', opts)).toBe('cancel');
  });
});
