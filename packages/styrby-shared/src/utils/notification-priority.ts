/**
 * Smart Notification Priority Scoring
 *
 * Calculates a priority score (1-5) for notification events to enable
 * intelligent filtering based on user preferences. Lower scores are
 * more urgent and important.
 *
 * Priority Scale:
 * 1 = Critical/Urgent (permission requests for dangerous tools, budget exceeded)
 * 2 = High (high-risk operations, budget warnings, session errors)
 * 3 = Medium (medium-risk operations, session completion with significant cost)
 * 4 = Normal (low-risk operations, session completion with low cost)
 * 5 = Informational (session started, routine updates)
 *
 * Scoring factors:
 * - Risk level of the operation
 * - Cost impact (higher cost = higher priority)
 * - Session duration (longer sessions are more valuable context)
 * - Permission type (dangerous tools get higher priority)
 * - Time of day (quiet hours may affect threshold)
 */

import type { RiskLevel } from '../types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Notification event types that can be scored.
 * Maps directly to the event types in the push notification Edge Function.
 */
export type NotificationEventType =
  | 'permission_request'
  | 'session_started'
  | 'session_completed'
  | 'session_error'
  | 'budget_warning'
  | 'budget_exceeded';

/**
 * Input data for calculating notification priority.
 * Not all fields are required - the algorithm uses sensible defaults.
 */
export interface NotificationEvent {
  /** The type of notification event */
  type: NotificationEventType;

  /** Risk level for permission requests (low, medium, high) */
  riskLevel?: RiskLevel;

  /** Cost in USD for session/cost-related events */
  costUsd?: number;

  /** Session duration in milliseconds (used for session completion events) */
  sessionDurationMs?: number;

  /**
   * Type of permission being requested.
   * Used to identify dangerous operations like file writes or command execution.
   */
  permissionType?: string;

  /**
   * Tool name for permission requests.
   * Certain tools (bash, write, execute) are considered more dangerous.
   */
  toolName?: string;

  /**
   * Whether the notification is being sent during the user's quiet hours.
   * During quiet hours, only higher-priority notifications should get through.
   */
  isQuietHours?: boolean;

  /** Budget threshold in USD for budget events */
  budgetThreshold?: number;
}

/**
 * Result of the priority calculation with breakdown for debugging.
 */
export interface PriorityResult {
  /**
   * Final priority score (1-5).
   * Lower = more urgent, should always get through.
   * Higher = less urgent, may be filtered.
   */
  priority: number;

  /**
   * Human-readable explanation of how the priority was calculated.
   * Useful for debugging and user-facing explanations.
   */
  reason: string;

  /**
   * Individual factor contributions to the final score.
   * Helps understand why a notification received its priority.
   */
  factors: {
    basePriority: number;
    riskAdjustment: number;
    costAdjustment: number;
    durationAdjustment: number;
    toolAdjustment: number;
  };
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Base priority scores by event type.
 * These are starting points before adjustments are applied.
 */
const BASE_PRIORITY_BY_EVENT: Record<NotificationEventType, number> = {
  permission_request: 2, // Requires user action, fairly urgent
  session_started: 5, // Informational only
  session_completed: 4, // Informational, but cost-relevant
  session_error: 2, // Errors need attention
  budget_warning: 2, // Financial impact
  budget_exceeded: 1, // Critical - budget limit hit
};

/**
 * Risk level adjustments for permission requests.
 * Lower risk = less urgent (higher number = more filtering).
 */
const RISK_LEVEL_ADJUSTMENT: Record<RiskLevel, number> = {
  high: -1, // High risk makes it more urgent (lower priority number)
  medium: 0, // No adjustment
  low: 1, // Low risk makes it less urgent (higher priority number)
};

/**
 * Tools considered dangerous that should have higher priority (lower score).
 * These tools can make significant changes to the system.
 */
const DANGEROUS_TOOLS = new Set([
  'bash',
  'execute',
  'run_command',
  'write',
  'write_file',
  'edit',
  'edit_file',
  'delete',
  'delete_file',
  'rm',
  'mv',
  'git',
  'npm',
  'pip',
  'curl',
  'wget',
]);

/**
 * Cost thresholds in USD for priority adjustments.
 * Higher costs make notifications more urgent.
 */
const COST_THRESHOLDS = {
  HIGH: 10.0, // >$10 is significant
  MEDIUM: 5.0, // >$5 is notable
  LOW: 1.0, // >$1 is worth knowing
};

/**
 * Session duration thresholds in milliseconds.
 * Longer sessions are more valuable context, so their completions matter more.
 */
const DURATION_THRESHOLDS = {
  LONG: 60 * 60 * 1000, // 1 hour
  MEDIUM: 30 * 60 * 1000, // 30 minutes
};

// ============================================================================
// Priority Calculation Functions
// ============================================================================

/**
 * Calculates the notification priority score for an event.
 *
 * The algorithm:
 * 1. Start with base priority for the event type
 * 2. Adjust for risk level (permission requests)
 * 3. Adjust for cost impact
 * 4. Adjust for session duration
 * 5. Adjust for dangerous tools
 * 6. Clamp final result to 1-5 range
 *
 * @param event - The notification event to score
 * @returns Priority score (1-5) where 1 is most urgent
 *
 * @example
 * // High-risk permission request for bash command
 * calculateNotificationPriority({
 *   type: 'permission_request',
 *   riskLevel: 'high',
 *   toolName: 'bash'
 * }); // Returns 1 (urgent)
 *
 * @example
 * // Session completion with low cost
 * calculateNotificationPriority({
 *   type: 'session_completed',
 *   costUsd: 0.15,
 *   sessionDurationMs: 5 * 60 * 1000 // 5 minutes
 * }); // Returns 4 or 5 (low priority)
 */
export function calculateNotificationPriority(
  event: NotificationEvent
): number {
  const result = calculateNotificationPriorityDetailed(event);
  return result.priority;
}

/**
 * Calculates notification priority with detailed breakdown.
 *
 * Same algorithm as calculateNotificationPriority but returns
 * the full breakdown of factors for debugging and UI display.
 *
 * @param event - The notification event to score
 * @returns Priority result with score and breakdown
 *
 * @example
 * const result = calculateNotificationPriorityDetailed({
 *   type: 'budget_warning',
 *   costUsd: 8.50,
 *   budgetThreshold: 10.00
 * });
 * // result.priority = 2
 * // result.reason = "Budget warning (85% of threshold)"
 * // result.factors = { basePriority: 2, costAdjustment: 0, ... }
 */
export function calculateNotificationPriorityDetailed(
  event: NotificationEvent
): PriorityResult {
  const factors = {
    basePriority: BASE_PRIORITY_BY_EVENT[event.type] ?? 3,
    riskAdjustment: 0,
    costAdjustment: 0,
    durationAdjustment: 0,
    toolAdjustment: 0,
  };

  let priority = factors.basePriority;
  const reasons: string[] = [getEventTypeDescription(event.type)];

  // ── Risk Level Adjustment (permission requests) ────────────────────────
  if (event.type === 'permission_request' && event.riskLevel) {
    factors.riskAdjustment = RISK_LEVEL_ADJUSTMENT[event.riskLevel] ?? 0;
    priority += factors.riskAdjustment;

    if (event.riskLevel === 'high') {
      reasons.push('high-risk operation');
    } else if (event.riskLevel === 'low') {
      reasons.push('low-risk operation');
    }
  }

  // ── Cost Impact Adjustment ─────────────────────────────────────────────
  if (event.costUsd !== undefined && event.costUsd > 0) {
    if (event.costUsd > COST_THRESHOLDS.HIGH) {
      factors.costAdjustment = -2; // Very high cost = urgent
      reasons.push(`high cost ($${event.costUsd.toFixed(2)})`);
    } else if (event.costUsd > COST_THRESHOLDS.MEDIUM) {
      factors.costAdjustment = -1; // Notable cost = more important
      reasons.push(`moderate cost ($${event.costUsd.toFixed(2)})`);
    } else if (event.costUsd > COST_THRESHOLDS.LOW) {
      factors.costAdjustment = 0; // Standard cost = no change
    } else {
      factors.costAdjustment = 1; // Low cost = less urgent
    }
    priority += factors.costAdjustment;
  }

  // ── Session Duration Adjustment ────────────────────────────────────────
  if (
    event.sessionDurationMs !== undefined &&
    event.type === 'session_completed'
  ) {
    if (event.sessionDurationMs > DURATION_THRESHOLDS.LONG) {
      // Long sessions are more valuable, completion is more important
      factors.durationAdjustment = -1;
      reasons.push('long session (>1hr)');
    } else if (event.sessionDurationMs > DURATION_THRESHOLDS.MEDIUM) {
      factors.durationAdjustment = 0;
    } else {
      // Short sessions are less important
      factors.durationAdjustment = 1;
    }
    priority += factors.durationAdjustment;
  }

  // ── Dangerous Tool Adjustment ──────────────────────────────────────────
  if (event.type === 'permission_request' && event.toolName) {
    const toolLower = event.toolName.toLowerCase();
    const isDangerous =
      DANGEROUS_TOOLS.has(toolLower) ||
      toolLower.includes('bash') ||
      toolLower.includes('execute') ||
      toolLower.includes('write') ||
      toolLower.includes('delete');

    if (isDangerous) {
      factors.toolAdjustment = -1; // Dangerous tools need more attention
      reasons.push(`dangerous tool (${event.toolName})`);
    }
    priority += factors.toolAdjustment;
  }

  // ── Clamp to valid range ───────────────────────────────────────────────
  priority = Math.max(1, Math.min(5, priority));

  return {
    priority,
    reason: reasons.join(', '),
    factors,
  };
}

/**
 * Checks if a notification should be sent based on priority and user threshold.
 *
 * @param calculatedPriority - The notification's priority score (1-5)
 * @param userThreshold - User's priority threshold setting (1-5)
 * @param isPaidTier - Whether user is on Pro/Power tier (enables filtering)
 * @returns True if the notification should be sent
 *
 * @example
 * // Free user always receives all notifications
 * shouldSendNotification(5, 1, false); // true
 *
 * // Pro user with strict threshold
 * shouldSendNotification(4, 2, true); // false (4 > 2)
 *
 * // Pro user with relaxed threshold
 * shouldSendNotification(3, 5, true); // true (3 <= 5)
 */
export function shouldSendNotification(
  calculatedPriority: number,
  userThreshold: number,
  isPaidTier: boolean
): boolean {
  // Free users get all notifications (no filtering)
  if (!isPaidTier) {
    return true;
  }

  // For paid tiers, send only if priority is urgent enough
  // Lower priority number = more urgent = should get through
  return calculatedPriority <= userThreshold;
}

/**
 * Returns estimated notification percentage for a given threshold.
 *
 * These are static estimates based on typical notification patterns.
 * Used when no historical data is available for the user.
 *
 * @param threshold - Priority threshold (1-5)
 * @returns Estimated percentage of notifications that would be received
 *
 * @example
 * getEstimatedNotificationPercentage(1); // 5 (only ~5% are priority 1)
 * getEstimatedNotificationPercentage(5); // 100 (all notifications)
 */
export function getEstimatedNotificationPercentage(threshold: number): number {
  switch (threshold) {
    case 1:
      return 5; // ~5% are critical/urgent
    case 2:
      return 15; // ~15% are high priority
    case 3:
      return 50; // ~50% are medium priority or above
    case 4:
      return 85; // ~85% are normal priority or above
    case 5:
      return 100; // 100% if no filtering
    default:
      return 50;
  }
}

/**
 * Returns a human-readable description of a threshold level.
 *
 * @param threshold - Priority threshold (1-5)
 * @returns Description string for UI display
 *
 * @example
 * getThresholdDescription(1); // "Urgent only"
 * getThresholdDescription(3); // "Medium priority"
 */
export function getThresholdDescription(threshold: number): string {
  switch (threshold) {
    case 1:
      return 'Urgent only';
    case 2:
      return 'High priority';
    case 3:
      return 'Medium priority';
    case 4:
      return 'Most notifications';
    case 5:
      return 'All notifications';
    default:
      return 'Unknown';
  }
}

/**
 * Returns example notifications that would get through at a given threshold.
 *
 * @param threshold - Priority threshold (1-5)
 * @returns Array of example notification descriptions
 *
 * @example
 * getThresholdExamples(1);
 * // ["Budget exceeded alerts", "High-risk permission requests (bash, delete)"]
 */
export function getThresholdExamples(threshold: number): string[] {
  const examples: string[][] = [
    [], // 0 (invalid)
    [
      // 1 - Urgent only
      'Budget exceeded alerts',
      'High-risk permission requests (bash, delete, file writes)',
    ],
    [
      // 2 - High priority
      'Budget warnings',
      'Session errors',
      'Medium-risk permission requests',
    ],
    [
      // 3 - Medium priority
      'Session completions with significant cost (>$5)',
      'Low-risk permission requests',
    ],
    [
      // 4 - Most notifications
      'Session completions',
      'Long session summaries',
    ],
    [
      // 5 - All notifications
      'Session started notifications',
      'All informational updates',
    ],
  ];

  // Accumulate examples from urgent to current threshold
  const result: string[] = [];
  for (let i = 1; i <= Math.min(threshold, 5); i++) {
    result.push(...(examples[i] || []));
  }
  return result;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Returns a human-readable description of an event type.
 *
 * @param type - The notification event type
 * @returns Description string
 */
function getEventTypeDescription(type: NotificationEventType): string {
  switch (type) {
    case 'permission_request':
      return 'Permission request';
    case 'session_started':
      return 'Session started';
    case 'session_completed':
      return 'Session completed';
    case 'session_error':
      return 'Session error';
    case 'budget_warning':
      return 'Budget warning';
    case 'budget_exceeded':
      return 'Budget exceeded';
    default:
      return 'Notification';
  }
}
