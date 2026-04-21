/**
 * Tests for notification priority scoring (utils/notification-priority.ts).
 *
 * Covers: calculateNotificationPriority, calculateNotificationPriorityDetailed,
 * shouldSendNotification, getEstimatedNotificationPercentage,
 * getThresholdDescription, getThresholdExamples.
 *
 * @module utils/__tests__/notification-priority
 */

import { describe, it, expect } from 'vitest';
import {
  calculateNotificationPriority,
  calculateNotificationPriorityDetailed,
  shouldSendNotification,
  getEstimatedNotificationPercentage,
  getThresholdDescription,
  getThresholdExamples,
} from '../notification-priority.js';

// ============================================================================
// calculateNotificationPriority — base scores
// ============================================================================

describe('calculateNotificationPriority — base scores', () => {
  it('budget_exceeded returns 1 (critical)', () => {
    expect(calculateNotificationPriority({ type: 'budget_exceeded' })).toBe(1);
  });

  it('session_started returns 5 (informational)', () => {
    expect(calculateNotificationPriority({ type: 'session_started' })).toBe(5);
  });

  it('session_error returns 2 (high)', () => {
    expect(calculateNotificationPriority({ type: 'session_error' })).toBe(2);
  });

  it('session_completed returns 4 (normal)', () => {
    expect(calculateNotificationPriority({ type: 'session_completed' })).toBe(4);
  });

  it('budget_warning returns 2 (high)', () => {
    expect(calculateNotificationPriority({ type: 'budget_warning' })).toBe(2);
  });

  it('permission_request baseline returns 2', () => {
    expect(calculateNotificationPriority({ type: 'permission_request' })).toBe(2);
  });
});

// ============================================================================
// calculateNotificationPriority — risk adjustments
// ============================================================================

describe('calculateNotificationPriority — risk level adjustments', () => {
  it('high-risk permission request bumps priority to 1', () => {
    expect(calculateNotificationPriority({ type: 'permission_request', riskLevel: 'high' })).toBe(1);
  });

  it('medium-risk permission request stays at base (2)', () => {
    expect(calculateNotificationPriority({ type: 'permission_request', riskLevel: 'medium' })).toBe(2);
  });

  it('low-risk permission request raises priority to 3', () => {
    expect(calculateNotificationPriority({ type: 'permission_request', riskLevel: 'low' })).toBe(3);
  });
});

// ============================================================================
// calculateNotificationPriority — cost adjustments
// ============================================================================

describe('calculateNotificationPriority — cost adjustments', () => {
  it('high cost (>$10) on session_completed makes priority more urgent', () => {
    const priority = calculateNotificationPriority({
      type: 'session_completed',
      costUsd: 15.0,
    });
    // base 4 + cost_adjustment -2 = 2
    expect(priority).toBe(2);
  });

  it('moderate cost ($5-$10) on session_completed adjusts by -1', () => {
    const priority = calculateNotificationPriority({
      type: 'session_completed',
      costUsd: 7.5,
    });
    // base 4 + cost -1 = 3
    expect(priority).toBe(3);
  });

  it('low cost (<$1) on session_completed raises priority number by 1', () => {
    const priority = calculateNotificationPriority({
      type: 'session_completed',
      costUsd: 0.05,
    });
    // base 4 + cost +1 = 5
    expect(priority).toBe(5);
  });
});

// ============================================================================
// calculateNotificationPriority — duration adjustments
// ============================================================================

describe('calculateNotificationPriority — session duration adjustments', () => {
  it('long session (>1hr) completion bumps urgency by -1', () => {
    const priority = calculateNotificationPriority({
      type: 'session_completed',
      sessionDurationMs: 90 * 60 * 1000, // 90 minutes
    });
    // base 4 + duration -1 = 3
    expect(priority).toBe(3);
  });

  it('short session (<30min) completion decreases urgency by +1', () => {
    const priority = calculateNotificationPriority({
      type: 'session_completed',
      sessionDurationMs: 5 * 60 * 1000, // 5 minutes
    });
    // base 4 + duration +1 = 5
    expect(priority).toBe(5);
  });
});

// ============================================================================
// calculateNotificationPriority — dangerous tool adjustments
// ============================================================================

describe('calculateNotificationPriority — dangerous tool adjustments', () => {
  it('bash tool on permission_request bumps urgency by -1', () => {
    // base 2 + tool -1 = 1
    expect(calculateNotificationPriority({ type: 'permission_request', toolName: 'bash' })).toBe(1);
  });

  it('write_file tool on permission_request is treated as dangerous', () => {
    const p = calculateNotificationPriority({ type: 'permission_request', toolName: 'write_file' });
    expect(p).toBeLessThan(2);
  });

  it('a safe tool (e.g. read_file) does not reduce priority', () => {
    // base 2, no tool adjustment
    expect(calculateNotificationPriority({ type: 'permission_request', toolName: 'read_file' })).toBe(2);
  });

  it('tool name matching is case-insensitive', () => {
    const pLower = calculateNotificationPriority({ type: 'permission_request', toolName: 'bash' });
    const pUpper = calculateNotificationPriority({ type: 'permission_request', toolName: 'BASH' });
    expect(pLower).toBe(pUpper);
  });
});

// ============================================================================
// calculateNotificationPriority — clamping
// ============================================================================

describe('calculateNotificationPriority — clamping to [1, 5]', () => {
  it('priority never goes below 1', () => {
    // budget_exceeded (1) + many downward adjustments should clamp at 1
    const p = calculateNotificationPriority({
      type: 'budget_exceeded',
      costUsd: 100,
    });
    expect(p).toBeGreaterThanOrEqual(1);
  });

  it('priority never goes above 5', () => {
    // session_started (5) + low cost should clamp at 5
    const p = calculateNotificationPriority({
      type: 'session_started',
      costUsd: 0.01,
    });
    expect(p).toBeLessThanOrEqual(5);
  });
});

// ============================================================================
// calculateNotificationPriorityDetailed
// ============================================================================

describe('calculateNotificationPriorityDetailed', () => {
  it('returns a PriorityResult with priority, reason, and factors', () => {
    const result = calculateNotificationPriorityDetailed({ type: 'budget_exceeded' });
    expect(result).toHaveProperty('priority');
    expect(result).toHaveProperty('reason');
    expect(result).toHaveProperty('factors');
  });

  it('factors.basePriority matches the event type base', () => {
    const result = calculateNotificationPriorityDetailed({ type: 'session_started' });
    expect(result.factors.basePriority).toBe(5);
  });

  it('reason string is non-empty', () => {
    const result = calculateNotificationPriorityDetailed({ type: 'permission_request', riskLevel: 'high' });
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it('high-risk permission reason mentions the risk level', () => {
    const result = calculateNotificationPriorityDetailed({ type: 'permission_request', riskLevel: 'high' });
    expect(result.reason.toLowerCase()).toContain('high');
  });

  it('dangerous tool reason mentions the tool name', () => {
    const result = calculateNotificationPriorityDetailed({ type: 'permission_request', toolName: 'bash' });
    expect(result.reason).toContain('bash');
  });

  it('factors.riskAdjustment is -1 for high risk', () => {
    const result = calculateNotificationPriorityDetailed({ type: 'permission_request', riskLevel: 'high' });
    expect(result.factors.riskAdjustment).toBe(-1);
  });

  it('factors.riskAdjustment is 0 when no risk level provided', () => {
    const result = calculateNotificationPriorityDetailed({ type: 'permission_request' });
    expect(result.factors.riskAdjustment).toBe(0);
  });

  it('all factor fields are numeric', () => {
    const result = calculateNotificationPriorityDetailed({ type: 'session_completed', costUsd: 5.5 });
    for (const [key, value] of Object.entries(result.factors)) {
      expect(typeof value, `factor "${key}" should be a number`).toBe('number');
    }
  });
});

// ============================================================================
// shouldSendNotification
// ============================================================================

describe('shouldSendNotification', () => {
  it('always returns true for free users regardless of priority', () => {
    expect(shouldSendNotification(5, 1, false)).toBe(true);
    expect(shouldSendNotification(1, 5, false)).toBe(true);
  });

  it('returns true for paid users when priority <= threshold', () => {
    expect(shouldSendNotification(2, 3, true)).toBe(true);
    expect(shouldSendNotification(3, 3, true)).toBe(true);
  });

  it('returns false for paid users when priority > threshold', () => {
    expect(shouldSendNotification(4, 2, true)).toBe(false);
    expect(shouldSendNotification(5, 4, true)).toBe(false);
  });
});

// ============================================================================
// getEstimatedNotificationPercentage
// ============================================================================

describe('getEstimatedNotificationPercentage', () => {
  it('returns 5 for threshold 1 (urgent only)', () => {
    expect(getEstimatedNotificationPercentage(1)).toBe(5);
  });

  it('returns 100 for threshold 5 (all notifications)', () => {
    expect(getEstimatedNotificationPercentage(5)).toBe(100);
  });

  it('percentages increase monotonically with threshold', () => {
    const values = [1, 2, 3, 4, 5].map(getEstimatedNotificationPercentage);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1]);
    }
  });

  it('returns 50 for unknown threshold (safe default)', () => {
    expect(getEstimatedNotificationPercentage(99)).toBe(50);
    expect(getEstimatedNotificationPercentage(0)).toBe(50);
  });
});

// ============================================================================
// getThresholdDescription
// ============================================================================

describe('getThresholdDescription', () => {
  it('returns a non-empty string for thresholds 1-5', () => {
    for (let i = 1; i <= 5; i++) {
      expect(getThresholdDescription(i).length).toBeGreaterThan(0);
    }
  });

  it('returns "Urgent only" for threshold 1', () => {
    expect(getThresholdDescription(1)).toBe('Urgent only');
  });

  it('returns "All notifications" for threshold 5', () => {
    expect(getThresholdDescription(5)).toBe('All notifications');
  });

  it('returns "Unknown" for out-of-range thresholds', () => {
    expect(getThresholdDescription(0)).toBe('Unknown');
    expect(getThresholdDescription(99)).toBe('Unknown');
  });
});

// ============================================================================
// getThresholdExamples
// ============================================================================

describe('getThresholdExamples', () => {
  it('returns an array of strings for each valid threshold', () => {
    for (let i = 1; i <= 5; i++) {
      const examples = getThresholdExamples(i);
      expect(Array.isArray(examples)).toBe(true);
      expect(examples.every((e) => typeof e === 'string')).toBe(true);
    }
  });

  it('accumulates examples: threshold 5 includes threshold 1 examples', () => {
    const t1Examples = getThresholdExamples(1);
    const t5Examples = getThresholdExamples(5);
    // All t1 examples should appear in t5 examples
    for (const ex of t1Examples) {
      expect(t5Examples).toContain(ex);
    }
  });

  it('threshold 5 returns more examples than threshold 1', () => {
    expect(getThresholdExamples(5).length).toBeGreaterThan(getThresholdExamples(1).length);
  });
});
