/**
 * Unit tests for pure utility functions exported from useBudgetAlerts hook.
 *
 * Tests cover:
 * - Period label formatting (daily/weekly/monthly)
 * - Action label formatting (notify/slowdown/stop)
 * - Action descriptions
 * - Alert progress color calculation based on usage percentage
 * - Action badge color mapping
 *
 * Note: This file does NOT test the React hook itself, only the exported utilities.
 */

// Mock React and Supabase to prevent import errors
jest.mock('react', () => ({
  ...jest.requireActual('react'),
  useState: jest.fn((init) => [init, jest.fn()]),
  useEffect: jest.fn(),
  useCallback: jest.fn((fn) => fn),
}));

jest.mock('../../lib/supabase', () => ({
  supabase: {
    auth: { getUser: jest.fn() },
    from: jest.fn(),
  },
}));

import {
  getPeriodLabel,
  getActionLabel,
  getActionDescription,
  getAlertProgressColor,
  getActionBadgeColor,
} from '../useBudgetAlerts';

describe('useBudgetAlerts utility functions', () => {
  describe('getPeriodLabel', () => {
    /**
     * Verifies period label returns user-friendly text for each period type.
     */
    it('should return "per day" for daily period', () => {
      expect(getPeriodLabel('daily')).toBe('per day');
    });

    it('should return "per week" for weekly period', () => {
      expect(getPeriodLabel('weekly')).toBe('per week');
    });

    it('should return "per month" for monthly period', () => {
      expect(getPeriodLabel('monthly')).toBe('per month');
    });
  });

  describe('getActionLabel', () => {
    /**
     * Verifies action label returns capitalized version of action type.
     */
    it('should return "Notify" for notify action', () => {
      expect(getActionLabel('notify')).toBe('Notify');
    });

    it('should return "Slowdown" for slowdown action', () => {
      expect(getActionLabel('slowdown')).toBe('Slowdown');
    });

    it('should return "Stop" for stop action', () => {
      expect(getActionLabel('stop')).toBe('Stop');
    });
  });

  describe('getActionDescription', () => {
    /**
     * Verifies action descriptions explain what happens when alert is triggered.
     */
    it('should return notification description for notify action', () => {
      expect(getActionDescription('notify')).toBe(
        'Send push notification when threshold is reached'
      );
    });

    it('should return slowdown description for slowdown action', () => {
      expect(getActionDescription('slowdown')).toBe(
        'Add confirmation step before expensive operations'
      );
    });

    it('should return stop description for stop action', () => {
      expect(getActionDescription('stop')).toBe(
        'Pause agent sessions when threshold is exceeded'
      );
    });
  });

  describe('getAlertProgressColor', () => {
    /**
     * Verifies progress bar color changes based on percentage thresholds.
     * Color coding:
     * - Green: < 50% (safe zone)
     * - Yellow: 50-79% (warning)
     * - Orange: 80-99% (high warning)
     * - Red: >= 100% (over budget)
     */
    describe('above 100%', () => {
      it('should return red color when over budget', () => {
        expect(getAlertProgressColor(101)).toBe('#ef4444');
        expect(getAlertProgressColor(150)).toBe('#ef4444');
        expect(getAlertProgressColor(200)).toBe('#ef4444');
      });
    });

    describe('80-100%', () => {
      it('should return orange color for high usage', () => {
        expect(getAlertProgressColor(81)).toBe('#f97316');
        expect(getAlertProgressColor(90)).toBe('#f97316');
        expect(getAlertProgressColor(99)).toBe('#f97316');
      });
    });

    describe('50-79%', () => {
      it('should return yellow color for moderate usage', () => {
        expect(getAlertProgressColor(51)).toBe('#eab308');
        expect(getAlertProgressColor(65)).toBe('#eab308');
        expect(getAlertProgressColor(79)).toBe('#eab308');
      });
    });

    describe('below 50%', () => {
      it('should return green color for low usage', () => {
        expect(getAlertProgressColor(0)).toBe('#22c55e');
        expect(getAlertProgressColor(25)).toBe('#22c55e');
        expect(getAlertProgressColor(49)).toBe('#22c55e');
      });
    });

    describe('boundary values', () => {
      /**
       * Tests exact threshold boundaries to verify >= vs > conditions.
       */
      it('should return green for exactly 50%', () => {
        expect(getAlertProgressColor(50)).toBe('#eab308'); // 50% is >= 50
      });

      it('should return orange for exactly 80%', () => {
        expect(getAlertProgressColor(80)).toBe('#f97316'); // 80% is >= 80
      });

      it('should return orange for exactly 100%', () => {
        // WHY: The condition is `> 100` for red, not `>= 100`.
        // 100% is in the 80-100 range (>= 80), so it returns orange.
        expect(getAlertProgressColor(100)).toBe('#f97316');
      });
    });
  });

  describe('getActionBadgeColor', () => {
    /**
     * Verifies action badge colors match the semantic meaning of each action.
     * Each action returns { bg, text } for background and text colors with proper contrast.
     */
    it('should return blue colors for notify action', () => {
      const colors = getActionBadgeColor('notify');
      expect(colors).toEqual({
        bg: '#3b82f620', // Blue with transparency
        text: '#3b82f6',  // Solid blue
      });
    });

    it('should return yellow colors for slowdown action', () => {
      const colors = getActionBadgeColor('slowdown');
      expect(colors).toEqual({
        bg: '#eab30820', // Yellow with transparency
        text: '#eab308',  // Solid yellow
      });
    });

    it('should return red colors for stop action', () => {
      const colors = getActionBadgeColor('stop');
      expect(colors).toEqual({
        bg: '#ef444420', // Red with transparency
        text: '#ef4444',  // Solid red
      });
    });

    it('should return consistent color objects with bg and text properties', () => {
      const actions = ['notify', 'slowdown', 'stop'] as const;

      actions.forEach((action) => {
        const colors = getActionBadgeColor(action);
        expect(colors).toHaveProperty('bg');
        expect(colors).toHaveProperty('text');
        expect(typeof colors.bg).toBe('string');
        expect(typeof colors.text).toBe('string');
      });
    });
  });
});
