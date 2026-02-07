/**
 * Tests for the Smart Notification Priority Scoring Module
 *
 * Validates priority calculation (1-5 scale), notification filtering
 * based on tier/threshold, percentage estimates, and threshold descriptions.
 *
 * Priority Scale:
 *   1 = Critical/Urgent
 *   2 = High
 *   3 = Medium
 *   4 = Normal
 *   5 = Informational
 */

import { describe, it, expect } from 'vitest';
import {
  calculateNotificationPriority,
  calculateNotificationPriorityDetailed,
  shouldSendNotification,
  getEstimatedNotificationPercentage,
  getThresholdDescription,
} from '../../src/utils/notification-priority';

describe('Notification Priority Module', () => {
  // ==========================================================================
  // calculateNotificationPriority()
  // ==========================================================================

  describe('calculateNotificationPriority()', () => {
    it('returns a number between 1 and 5', () => {
      const priority = calculateNotificationPriority({
        type: 'session_started',
      });
      expect(priority).toBeGreaterThanOrEqual(1);
      expect(priority).toBeLessThanOrEqual(5);
    });

    it('returns 1 for budget_exceeded (always critical)', () => {
      const priority = calculateNotificationPriority({
        type: 'budget_exceeded',
      });
      expect(priority).toBe(1);
    });

    it('returns 5 for session_started (always informational)', () => {
      const priority = calculateNotificationPriority({
        type: 'session_started',
      });
      expect(priority).toBe(5);
    });

    it('returns 1 for permission_request with high risk and dangerous tool', () => {
      const priority = calculateNotificationPriority({
        type: 'permission_request',
        riskLevel: 'high',
        toolName: 'bash',
      });
      // Base 2 + risk(-1) + tool(-1) = 0, clamped to 1
      expect(priority).toBe(1);
    });

    it('returns 3 or 4 for permission_request with low risk', () => {
      const priority = calculateNotificationPriority({
        type: 'permission_request',
        riskLevel: 'low',
      });
      // Base 2 + low risk(+1) = 3
      expect(priority).toBeGreaterThanOrEqual(3);
      expect(priority).toBeLessThanOrEqual(4);
    });

    it('gives session_completed with high cost a lower priority number (more urgent)', () => {
      const highCost = calculateNotificationPriority({
        type: 'session_completed',
        costUsd: 15.0,
      });
      const lowCost = calculateNotificationPriority({
        type: 'session_completed',
        costUsd: 0.10,
      });
      // High cost should have lower priority number (more urgent)
      expect(highCost).toBeLessThan(lowCost);
    });

    it('gives session_completed with long duration a lower priority number (more urgent)', () => {
      const longSession = calculateNotificationPriority({
        type: 'session_completed',
        sessionDurationMs: 2 * 60 * 60 * 1000, // 2 hours
      });
      const shortSession = calculateNotificationPriority({
        type: 'session_completed',
        sessionDurationMs: 5 * 60 * 1000, // 5 minutes
      });
      // Longer session should have lower priority number (more urgent)
      expect(longSession).toBeLessThan(shortSession);
    });

    it('clamps results that would go below 1 to 1', () => {
      // This combination would produce a negative raw score:
      // budget_exceeded (1) + high cost(-2) = -1, clamped to 1
      const priority = calculateNotificationPriority({
        type: 'budget_exceeded',
        costUsd: 50.0,
      });
      expect(priority).toBe(1);
    });

    it('clamps results that would go above 5 to 5', () => {
      // session_started (5) + low cost(+1) = 6, clamped to 5
      const priority = calculateNotificationPriority({
        type: 'session_started',
        costUsd: 0.01,
      });
      expect(priority).toBe(5);
    });

    it('returns base priority 2 for session_error', () => {
      const priority = calculateNotificationPriority({
        type: 'session_error',
      });
      expect(priority).toBe(2);
    });

    it('returns base priority 2 for budget_warning', () => {
      const priority = calculateNotificationPriority({
        type: 'budget_warning',
      });
      expect(priority).toBe(2);
    });
  });

  // ==========================================================================
  // Permission Request Priority Scenarios
  // ==========================================================================

  describe('permission_request priority scenarios', () => {
    it('high risk + dangerous tool (bash) = priority 1', () => {
      const priority = calculateNotificationPriority({
        type: 'permission_request',
        riskLevel: 'high',
        toolName: 'bash',
      });
      expect(priority).toBe(1);
    });

    it('high risk + dangerous tool (write_file) = priority 1', () => {
      const priority = calculateNotificationPriority({
        type: 'permission_request',
        riskLevel: 'high',
        toolName: 'write_file',
      });
      expect(priority).toBe(1);
    });

    it('high risk + safe tool = priority 1', () => {
      const priority = calculateNotificationPriority({
        type: 'permission_request',
        riskLevel: 'high',
        toolName: 'read_file',
      });
      // Base 2 + high risk(-1) = 1
      expect(priority).toBe(1);
    });

    it('medium risk + no specific tool = priority 2', () => {
      const priority = calculateNotificationPriority({
        type: 'permission_request',
        riskLevel: 'medium',
      });
      // Base 2 + medium risk(0) = 2
      expect(priority).toBe(2);
    });

    it('low risk + safe tool = priority 3', () => {
      const priority = calculateNotificationPriority({
        type: 'permission_request',
        riskLevel: 'low',
        toolName: 'read_file',
      });
      // Base 2 + low risk(+1) = 3
      expect(priority).toBe(3);
    });

    it('recognizes tools containing "execute" as dangerous', () => {
      const priority = calculateNotificationPriority({
        type: 'permission_request',
        riskLevel: 'medium',
        toolName: 'execute_command',
      });
      // Base 2 + medium risk(0) + dangerous tool(-1) = 1
      expect(priority).toBe(1);
    });

    it('recognizes tools containing "delete" as dangerous', () => {
      const priority = calculateNotificationPriority({
        type: 'permission_request',
        riskLevel: 'medium',
        toolName: 'delete_record',
      });
      // Base 2 + medium risk(0) + dangerous tool(-1) = 1
      expect(priority).toBe(1);
    });

    it('recognizes tools containing "write" as dangerous', () => {
      const priority = calculateNotificationPriority({
        type: 'permission_request',
        riskLevel: 'medium',
        toolName: 'overwrite_config',
      });
      // Base 2 + medium risk(0) + dangerous tool(-1) = 1
      expect(priority).toBe(1);
    });
  });

  // ==========================================================================
  // Cost and Duration Scenarios
  // ==========================================================================

  describe('cost and duration adjustments', () => {
    it('high cost (>$10) lowers priority number by 2', () => {
      const withCost = calculateNotificationPriority({
        type: 'session_completed',
        costUsd: 15.0,
      });
      const basePriority = calculateNotificationPriority({
        type: 'session_completed',
      });
      // Base 4 + cost(-2) = 2
      expect(withCost).toBe(basePriority - 2);
    });

    it('moderate cost ($5-$10) lowers priority number by 1', () => {
      const withCost = calculateNotificationPriority({
        type: 'session_completed',
        costUsd: 7.50,
      });
      const basePriority = calculateNotificationPriority({
        type: 'session_completed',
      });
      // Base 4 + cost(-1) = 3
      expect(withCost).toBe(basePriority - 1);
    });

    it('low cost (<$1) raises priority number by 1 (less urgent)', () => {
      const withCost = calculateNotificationPriority({
        type: 'session_completed',
        costUsd: 0.25,
      });
      // Base 4 + cost(+1) = 5
      expect(withCost).toBe(5);
    });

    it('long session duration (>1hr) lowers priority number by 1', () => {
      const longSession = calculateNotificationPriority({
        type: 'session_completed',
        sessionDurationMs: 2 * 60 * 60 * 1000,
      });
      // Base 4 + duration(-1) = 3
      expect(longSession).toBe(3);
    });

    it('short session duration (<30min) raises priority number by 1', () => {
      const shortSession = calculateNotificationPriority({
        type: 'session_completed',
        sessionDurationMs: 5 * 60 * 1000,
      });
      // Base 4 + duration(+1) = 5
      expect(shortSession).toBe(5);
    });

    it('duration adjustment only applies to session_completed', () => {
      // session_error with long duration should not get duration adjustment
      const errorPriority = calculateNotificationPriority({
        type: 'session_error',
        sessionDurationMs: 2 * 60 * 60 * 1000,
      });
      // Base 2, no duration adjustment for non-session_completed
      expect(errorPriority).toBe(2);
    });
  });

  // ==========================================================================
  // shouldSendNotification()
  // ==========================================================================

  describe('shouldSendNotification()', () => {
    it('returns true for free tier regardless of priority', () => {
      expect(shouldSendNotification(1, 1, false)).toBe(true);
      expect(shouldSendNotification(3, 1, false)).toBe(true);
      expect(shouldSendNotification(5, 1, false)).toBe(true);
    });

    it('returns true for free tier even with threshold 1', () => {
      expect(shouldSendNotification(5, 1, false)).toBe(true);
    });

    it('filters correctly for paid tier - sends when priority <= threshold', () => {
      // Priority 2, threshold 3 -> should send (2 <= 3)
      expect(shouldSendNotification(2, 3, true)).toBe(true);
    });

    it('filters correctly for paid tier - blocks when priority > threshold', () => {
      // Priority 4, threshold 2 -> should not send (4 > 2)
      expect(shouldSendNotification(4, 2, true)).toBe(false);
    });

    it('sends when priority equals threshold (paid tier)', () => {
      expect(shouldSendNotification(3, 3, true)).toBe(true);
    });

    it('blocks priority 5 when threshold is 1 (paid tier)', () => {
      expect(shouldSendNotification(5, 1, true)).toBe(false);
    });

    it('sends priority 1 for any threshold (paid tier)', () => {
      expect(shouldSendNotification(1, 1, true)).toBe(true);
      expect(shouldSendNotification(1, 3, true)).toBe(true);
      expect(shouldSendNotification(1, 5, true)).toBe(true);
    });

    it('sends all when threshold is 5 (paid tier)', () => {
      expect(shouldSendNotification(1, 5, true)).toBe(true);
      expect(shouldSendNotification(3, 5, true)).toBe(true);
      expect(shouldSendNotification(5, 5, true)).toBe(true);
    });
  });

  // ==========================================================================
  // getEstimatedNotificationPercentage()
  // ==========================================================================

  describe('getEstimatedNotificationPercentage()', () => {
    it('returns 5 for threshold 1 (only critical)', () => {
      expect(getEstimatedNotificationPercentage(1)).toBe(5);
    });

    it('returns 15 for threshold 2 (high priority)', () => {
      expect(getEstimatedNotificationPercentage(2)).toBe(15);
    });

    it('returns 50 for threshold 3 (medium priority)', () => {
      expect(getEstimatedNotificationPercentage(3)).toBe(50);
    });

    it('returns 85 for threshold 4 (most notifications)', () => {
      expect(getEstimatedNotificationPercentage(4)).toBe(85);
    });

    it('returns 100 for threshold 5 (all notifications)', () => {
      expect(getEstimatedNotificationPercentage(5)).toBe(100);
    });

    it('returns 50 for an out-of-range threshold', () => {
      expect(getEstimatedNotificationPercentage(0)).toBe(50);
      expect(getEstimatedNotificationPercentage(6)).toBe(50);
      expect(getEstimatedNotificationPercentage(-1)).toBe(50);
    });

    it('returns increasing percentages as threshold increases', () => {
      const pct1 = getEstimatedNotificationPercentage(1);
      const pct2 = getEstimatedNotificationPercentage(2);
      const pct3 = getEstimatedNotificationPercentage(3);
      const pct4 = getEstimatedNotificationPercentage(4);
      const pct5 = getEstimatedNotificationPercentage(5);

      expect(pct1).toBeLessThan(pct2);
      expect(pct2).toBeLessThan(pct3);
      expect(pct3).toBeLessThan(pct4);
      expect(pct4).toBeLessThan(pct5);
    });
  });

  // ==========================================================================
  // getThresholdDescription()
  // ==========================================================================

  describe('getThresholdDescription()', () => {
    it('returns a string for each valid threshold', () => {
      for (let i = 1; i <= 5; i++) {
        const description = getThresholdDescription(i);
        expect(typeof description).toBe('string');
        expect(description.length).toBeGreaterThan(0);
      }
    });

    it('returns "Urgent only" for threshold 1', () => {
      expect(getThresholdDescription(1)).toBe('Urgent only');
    });

    it('returns "High priority" for threshold 2', () => {
      expect(getThresholdDescription(2)).toBe('High priority');
    });

    it('returns "Medium priority" for threshold 3', () => {
      expect(getThresholdDescription(3)).toBe('Medium priority');
    });

    it('returns "Most notifications" for threshold 4', () => {
      expect(getThresholdDescription(4)).toBe('Most notifications');
    });

    it('returns "All notifications" for threshold 5', () => {
      expect(getThresholdDescription(5)).toBe('All notifications');
    });

    it('returns "Unknown" for out-of-range thresholds', () => {
      expect(getThresholdDescription(0)).toBe('Unknown');
      expect(getThresholdDescription(6)).toBe('Unknown');
      expect(getThresholdDescription(-1)).toBe('Unknown');
    });
  });

  // ==========================================================================
  // calculateNotificationPriorityDetailed()
  // ==========================================================================

  describe('calculateNotificationPriorityDetailed()', () => {
    it('returns an object with priority, reason, and factors', () => {
      const result = calculateNotificationPriorityDetailed({
        type: 'session_started',
      });

      expect(result).toHaveProperty('priority');
      expect(result).toHaveProperty('reason');
      expect(result).toHaveProperty('factors');
    });

    it('returns factors with all expected fields', () => {
      const result = calculateNotificationPriorityDetailed({
        type: 'session_started',
      });

      expect(result.factors).toHaveProperty('basePriority');
      expect(result.factors).toHaveProperty('riskAdjustment');
      expect(result.factors).toHaveProperty('costAdjustment');
      expect(result.factors).toHaveProperty('durationAdjustment');
      expect(result.factors).toHaveProperty('toolAdjustment');
    });

    it('returns correct base priority for each event type', () => {
      const types: Array<{ type: 'permission_request' | 'session_started' | 'session_completed' | 'session_error' | 'budget_warning' | 'budget_exceeded'; base: number }> = [
        { type: 'permission_request', base: 2 },
        { type: 'session_started', base: 5 },
        { type: 'session_completed', base: 4 },
        { type: 'session_error', base: 2 },
        { type: 'budget_warning', base: 2 },
        { type: 'budget_exceeded', base: 1 },
      ];

      for (const { type, base } of types) {
        const result = calculateNotificationPriorityDetailed({ type });
        expect(result.factors.basePriority).toBe(base);
      }
    });

    it('shows risk adjustment of -1 for high-risk permission request', () => {
      const result = calculateNotificationPriorityDetailed({
        type: 'permission_request',
        riskLevel: 'high',
      });
      expect(result.factors.riskAdjustment).toBe(-1);
    });

    it('shows risk adjustment of +1 for low-risk permission request', () => {
      const result = calculateNotificationPriorityDetailed({
        type: 'permission_request',
        riskLevel: 'low',
      });
      expect(result.factors.riskAdjustment).toBe(1);
    });

    it('shows risk adjustment of 0 for medium-risk permission request', () => {
      const result = calculateNotificationPriorityDetailed({
        type: 'permission_request',
        riskLevel: 'medium',
      });
      expect(result.factors.riskAdjustment).toBe(0);
    });

    it('shows tool adjustment of -1 for dangerous tool', () => {
      const result = calculateNotificationPriorityDetailed({
        type: 'permission_request',
        toolName: 'bash',
      });
      expect(result.factors.toolAdjustment).toBe(-1);
    });

    it('shows tool adjustment of 0 for safe tool', () => {
      const result = calculateNotificationPriorityDetailed({
        type: 'permission_request',
        toolName: 'read_file',
      });
      expect(result.factors.toolAdjustment).toBe(0);
    });

    it('shows cost adjustment of -2 for high cost (>$10)', () => {
      const result = calculateNotificationPriorityDetailed({
        type: 'session_completed',
        costUsd: 15.0,
      });
      expect(result.factors.costAdjustment).toBe(-2);
    });

    it('shows cost adjustment of -1 for moderate cost ($5-$10)', () => {
      const result = calculateNotificationPriorityDetailed({
        type: 'session_completed',
        costUsd: 7.50,
      });
      expect(result.factors.costAdjustment).toBe(-1);
    });

    it('includes a reason string', () => {
      const result = calculateNotificationPriorityDetailed({
        type: 'budget_exceeded',
      });
      expect(typeof result.reason).toBe('string');
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.reason).toContain('Budget exceeded');
    });

    it('includes tool name in reason when dangerous tool is used', () => {
      const result = calculateNotificationPriorityDetailed({
        type: 'permission_request',
        toolName: 'bash',
      });
      expect(result.reason).toContain('bash');
    });

    it('includes cost amount in reason when cost is notable', () => {
      const result = calculateNotificationPriorityDetailed({
        type: 'session_completed',
        costUsd: 12.50,
      });
      expect(result.reason).toContain('12.50');
    });
  });
});
