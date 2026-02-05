/**
 * Budget Actions
 *
 * Implements actions triggered when budget thresholds are reached:
 * - notify: Send warning via Realtime to mobile + optional email
 * - warn_and_slowdown: Send warning + add delay between agent responses
 * - hard_stop: Send critical alert + gracefully stop the session
 *
 * WHY: Budget alerts need to translate into concrete actions that protect
 * users from unexpected costs while being minimally disruptive to workflow.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { RelayClient, AgentType } from 'styrby-shared';
import type {
  BudgetCheckResult,
  BudgetAlertAction,
  BudgetMonitor,
} from './budget-monitor.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Notification channel for budget alerts
 */
export type NotificationChannel = 'push' | 'in_app' | 'email';

/**
 * Budget alert notification payload sent via Realtime
 */
export interface BudgetAlertPayload {
  /** Type discriminator for relay message handling */
  type: 'budget_alert';
  /** Alert severity level */
  level: 'warning' | 'critical' | 'exceeded';
  /** Alert name for display */
  alertName: string;
  /** Alert ID for reference */
  alertId: string;
  /** Action being taken */
  action: BudgetAlertAction;
  /** Current spending in USD */
  currentSpendUsd: number;
  /** Threshold in USD */
  thresholdUsd: number;
  /** Percentage of budget used */
  percentUsed: number;
  /** Budget period */
  period: 'daily' | 'weekly' | 'monthly';
  /** Optional: which agent is affected */
  agentType?: AgentType;
  /** ISO timestamp */
  timestamp: string;
}

/**
 * Stop session command payload
 */
export interface StopSessionPayload {
  /** Type discriminator */
  type: 'budget_stop';
  /** Reason for stopping */
  reason: 'budget_exceeded';
  /** Alert that triggered the stop */
  alertId: string;
  /** Alert name for display */
  alertName: string;
  /** Final spending amount */
  finalSpendUsd: number;
  /** ISO timestamp */
  timestamp: string;
}

/**
 * Slowdown configuration
 */
export interface SlowdownConfig {
  /** Delay in milliseconds between agent responses */
  delayMs: number;
  /** Whether to show a warning message to the user */
  showWarning: boolean;
  /** Warning message to display */
  warningMessage?: string;
}

/**
 * Configuration for budget actions
 */
export interface BudgetActionsConfig {
  /** Supabase client for database operations */
  supabase: SupabaseClient;
  /** User ID for the current session */
  userId: string;
  /** Relay client for real-time notifications */
  relayClient?: RelayClient;
  /** Session ID for the current agent session */
  sessionId?: string;
  /** Current agent type */
  agentType?: AgentType;
  /** Callback when session should stop */
  onStopSession?: () => Promise<void>;
  /** Callback to apply slowdown */
  onSlowdown?: (config: SlowdownConfig) => void;
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Result of executing a budget action
 */
export interface ActionResult {
  /** Whether the action was successful */
  success: boolean;
  /** Action that was executed */
  action: BudgetAlertAction;
  /** Notifications sent */
  notificationsSent: NotificationChannel[];
  /** Error message if failed */
  error?: string;
  /** Whether session was stopped */
  sessionStopped: boolean;
  /** Whether slowdown was applied */
  slowdownApplied: boolean;
}

// ============================================================================
// Budget Actions Class
// ============================================================================

/**
 * Executes actions in response to budget alerts.
 *
 * @example
 * const actions = new BudgetActions({
 *   supabase,
 *   userId: user.id,
 *   relayClient: relay,
 *   sessionId: session.id,
 *   onStopSession: async () => {
 *     await agent.stop();
 *   },
 * });
 *
 * const result = await actions.executeAction(budgetCheckResult);
 */
export class BudgetActions {
  private config: BudgetActionsConfig;
  private slowdownActive = false;
  private slowdownDelayMs = 0;

  constructor(config: BudgetActionsConfig) {
    this.config = config;
  }

  // --------------------------------------------------------------------------
  // Public Methods
  // --------------------------------------------------------------------------

  /**
   * Execute the appropriate action for a budget check result.
   *
   * @param result - Budget check result from BudgetMonitor
   * @param monitor - Optional BudgetMonitor to mark alert as triggered
   * @returns Action result
   */
  async executeAction(result: BudgetCheckResult, monitor?: BudgetMonitor): Promise<ActionResult> {
    const { alert, level, isNewTrigger } = result;

    // Only execute action if this is a new trigger
    if (!isNewTrigger && level !== 'warning' && level !== 'critical') {
      this.log(`Skipping action for "${alert.name}" - already triggered this period`);
      return {
        success: true,
        action: alert.action,
        notificationsSent: [],
        sessionStopped: false,
        slowdownApplied: false,
      };
    }

    this.log(`Executing action "${alert.action}" for alert "${alert.name}" (${level})`);

    const actionResult: ActionResult = {
      success: true,
      action: alert.action,
      notificationsSent: [],
      sessionStopped: false,
      slowdownApplied: false,
    };

    try {
      // Always send notifications for actionable alerts
      if (level !== 'ok') {
        actionResult.notificationsSent = await this.sendNotifications(result);
      }

      // Execute action-specific behavior
      switch (alert.action) {
        case 'notify':
          // Notifications already sent above
          break;

        case 'warn_and_slowdown':
          if (level === 'warning' || level === 'critical' || level === 'exceeded') {
            this.applySlowdown(result);
            actionResult.slowdownApplied = true;
          }
          break;

        case 'hard_stop':
          if (level === 'exceeded') {
            await this.stopSession(result);
            actionResult.sessionStopped = true;
          }
          break;
      }

      // Mark alert as triggered in database
      if (monitor && result.exceeded && isNewTrigger) {
        await monitor.markAlertTriggered(alert.id);
      }
    } catch (error) {
      this.log('Error executing action:', error);
      actionResult.success = false;
      actionResult.error = error instanceof Error ? error.message : 'Unknown error';
    }

    return actionResult;
  }

  /**
   * Execute actions for all budget check results.
   *
   * @param results - Array of budget check results
   * @param monitor - Optional BudgetMonitor to mark alerts as triggered
   * @returns Array of action results
   */
  async executeAllActions(results: BudgetCheckResult[], monitor?: BudgetMonitor): Promise<ActionResult[]> {
    const actionResults: ActionResult[] = [];

    for (const result of results) {
      // Only process actionable alerts (not 'ok')
      if (result.level === 'ok') continue;

      const actionResult = await this.executeAction(result, monitor);
      actionResults.push(actionResult);

      // If session was stopped, don't process more alerts
      if (actionResult.sessionStopped) {
        this.log('Session stopped - skipping remaining alerts');
        break;
      }
    }

    return actionResults;
  }

  /**
   * Send warning notification via configured channels.
   *
   * @param result - Budget check result
   * @returns Channels that received notifications
   */
  async notifyBudgetWarning(result: BudgetCheckResult): Promise<NotificationChannel[]> {
    return this.sendNotifications(result);
  }

  /**
   * Send critical/exceeded notification via configured channels.
   *
   * @param result - Budget check result
   * @returns Channels that received notifications
   */
  async notifyBudgetExceeded(result: BudgetCheckResult): Promise<NotificationChannel[]> {
    return this.sendNotifications(result);
  }

  /**
   * Apply slowdown to agent responses.
   * Adds a configurable delay between responses to reduce cost accumulation rate.
   *
   * @param result - Budget check result (for context in warnings)
   */
  triggerSlowdown(result: BudgetCheckResult): void {
    this.applySlowdown(result);
  }

  /**
   * Remove slowdown from agent responses.
   */
  clearSlowdown(): void {
    this.slowdownActive = false;
    this.slowdownDelayMs = 0;
    this.log('Slowdown cleared');
  }

  /**
   * Check if slowdown is currently active.
   */
  isSlowdownActive(): boolean {
    return this.slowdownActive;
  }

  /**
   * Get current slowdown delay in milliseconds.
   */
  getSlowdownDelay(): number {
    return this.slowdownDelayMs;
  }

  /**
   * Apply slowdown delay (call this before agent responses).
   */
  async applySlowdownDelay(): Promise<void> {
    if (this.slowdownActive && this.slowdownDelayMs > 0) {
      this.log(`Applying slowdown delay: ${this.slowdownDelayMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, this.slowdownDelayMs));
    }
  }

  /**
   * Stop the current session gracefully due to budget exceeded.
   *
   * @param result - Budget check result
   */
  async triggerStop(result: BudgetCheckResult): Promise<void> {
    await this.stopSession(result);
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  /**
   * Send notifications via all configured channels.
   */
  private async sendNotifications(result: BudgetCheckResult): Promise<NotificationChannel[]> {
    const { alert, level, currentSpendUsd, percentUsed } = result;
    const sentTo: NotificationChannel[] = [];

    // Build notification payload
    const payload: BudgetAlertPayload = {
      type: 'budget_alert',
      level: level === 'ok' ? 'warning' : level, // Map 'ok' to 'warning' just in case
      alertName: alert.name,
      alertId: alert.id,
      action: alert.action,
      currentSpendUsd,
      thresholdUsd: alert.threshold_usd,
      percentUsed,
      period: alert.period,
      agentType: alert.agent_type ?? undefined,
      timestamp: new Date().toISOString(),
    };

    // Send via Realtime (in-app notification)
    if (
      alert.notification_channels.includes('in_app') ||
      alert.notification_channels.includes('push')
    ) {
      const realtimeSent = await this.sendRealtimeNotification(payload);
      if (realtimeSent) {
        sentTo.push('in_app');
        if (alert.notification_channels.includes('push')) {
          sentTo.push('push'); // Push is triggered by mobile receiving realtime
        }
      }
    }

    // Queue email notification (handled by Edge Function or API route)
    if (alert.notification_channels.includes('email')) {
      const emailSent = await this.queueEmailNotification(result);
      if (emailSent) {
        sentTo.push('email');
      }
    }

    this.log(`Notifications sent to: ${sentTo.join(', ') || 'none'}`);
    return sentTo;
  }

  /**
   * Send notification via Supabase Realtime.
   */
  private async sendRealtimeNotification(payload: BudgetAlertPayload): Promise<boolean> {
    try {
      // Option 1: Use RelayClient if available
      if (this.config.relayClient) {
        await this.config.relayClient.send({
          type: 'command',
          payload: {
            action: 'ping', // Using ping as carrier, mobile handles budget_alert in payload
            params: payload as unknown as Record<string, unknown>,
          },
        });
        this.log('Sent budget alert via RelayClient');
        return true;
      }

      // Option 2: Broadcast directly to user's channel
      const channel = this.config.supabase.channel(`user:${this.config.userId}:alerts`);
      await channel.subscribe();
      await channel.send({
        type: 'broadcast',
        event: 'budget_alert',
        payload,
      });
      await channel.unsubscribe();
      this.log('Sent budget alert via Supabase channel');
      return true;
    } catch (error) {
      this.log('Failed to send Realtime notification:', error);
      return false;
    }
  }

  /**
   * Queue email notification by inserting into notification queue table.
   * The actual email is sent by an Edge Function or scheduled job.
   */
  private async queueEmailNotification(result: BudgetCheckResult): Promise<boolean> {
    try {
      // Get user's email from profile
      const { data: profile, error: profileError } = await this.config.supabase
        .from('profiles')
        .select('email')
        .eq('id', this.config.userId)
        .single();

      if (profileError || !profile?.email) {
        this.log('Could not get user email for notification:', profileError?.message);
        return false;
      }

      // Check if user has email budget alerts enabled
      const { data: prefs } = await this.config.supabase
        .from('notification_preferences')
        .select('email_budget_alerts')
        .eq('user_id', this.config.userId)
        .single();

      if (prefs && !prefs.email_budget_alerts) {
        this.log('User has email budget alerts disabled');
        return false;
      }

      // Instead of queueing, we'll rely on the web API to send emails
      // The CLI should call the web API endpoint to trigger the email
      // For now, log that email would be sent
      // WHY: Do not log PII (email addresses) - use generic message instead
      this.log(`Email notification queued for user - alert: ${result.alert.name}`);

      // Store the pending notification for the web API to pick up
      // This is a simplified approach - in production, use a proper queue
      await this.config.supabase.from('offline_command_queue').insert({
        user_id: this.config.userId,
        command: JSON.stringify({
          type: 'send_budget_alert_email',
          email: profile.email,
          alertName: result.alert.name,
          threshold: result.alert.threshold_usd.toFixed(2),
          currentSpend: result.currentSpendUsd.toFixed(2),
          period: result.alert.period,
          percentUsed: Math.round(result.percentUsed),
        }),
      });

      return true;
    } catch (error) {
      this.log('Failed to queue email notification:', error);
      return false;
    }
  }

  /**
   * Apply slowdown to agent responses.
   */
  private applySlowdown(result: BudgetCheckResult): void {
    // Calculate delay based on how far over budget
    // Base: 2 seconds at warning, 5 seconds at critical, 10 seconds if exceeded
    let delayMs = 2000;
    if (result.level === 'critical') {
      delayMs = 5000;
    } else if (result.level === 'exceeded') {
      delayMs = 10000;
    }

    // Additional delay based on percentage over threshold
    if (result.percentUsed > 100) {
      const overPercent = result.percentUsed - 100;
      delayMs += Math.min(overPercent * 100, 10000); // Max 10s additional
    }

    this.slowdownActive = true;
    this.slowdownDelayMs = delayMs;

    // Call the slowdown callback if configured
    if (this.config.onSlowdown) {
      this.config.onSlowdown({
        delayMs,
        showWarning: true,
        warningMessage: `Budget ${result.level}: Responses slowed to reduce costs. ${result.currentSpendUsd.toFixed(2)}/${result.alert.threshold_usd.toFixed(2)}`,
      });
    }

    this.log(`Slowdown applied: ${delayMs}ms delay`);
  }

  /**
   * Stop the current session gracefully.
   */
  private async stopSession(result: BudgetCheckResult): Promise<void> {
    this.log(`Stopping session due to budget exceeded: ${result.alert.name}`);

    // Build stop payload
    const payload: StopSessionPayload = {
      type: 'budget_stop',
      reason: 'budget_exceeded',
      alertId: result.alert.id,
      alertName: result.alert.name,
      finalSpendUsd: result.currentSpendUsd,
      timestamp: new Date().toISOString(),
    };

    // Send stop notification via Realtime
    try {
      if (this.config.relayClient) {
        await this.config.relayClient.send({
          type: 'command',
          payload: {
            action: 'end_session',
            params: payload as unknown as Record<string, unknown>,
          },
        });
      }
    } catch (error) {
      this.log('Failed to send stop notification:', error);
    }

    // Call the stop callback if configured
    if (this.config.onStopSession) {
      await this.config.onStopSession();
    }
  }

  /**
   * Log a message if debug is enabled.
   */
  private log(...args: unknown[]): void {
    if (this.config.debug) {
      console.log('[BudgetActions]', ...args);
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a budget actions instance.
 *
 * @param config - Budget actions configuration
 * @returns Budget actions instance
 */
export function createBudgetActions(config: BudgetActionsConfig): BudgetActions {
  return new BudgetActions(config);
}

// ============================================================================
// Integration Helper
// ============================================================================

/**
 * Check budgets and execute actions in one call.
 * Convenience function for integrating budget monitoring into cost reporting.
 *
 * @param monitor - Budget monitor instance
 * @param actions - Budget actions instance
 * @returns Object with check results and action results
 *
 * @example
 * // After each cost report
 * const { checkResults, actionResults } = await checkAndExecuteBudgetActions(
 *   monitor,
 *   actions
 * );
 *
 * if (actionResults.some(r => r.sessionStopped)) {
 *   // Session was stopped, handle cleanup
 * }
 */
export async function checkAndExecuteBudgetActions(
  monitor: BudgetMonitor,
  actions: BudgetActions
): Promise<{
  checkResults: BudgetCheckResult[];
  actionResults: ActionResult[];
}> {
  // Check all budgets
  const checkResults = await monitor.checkAllAlerts();

  // Execute actions for actionable alerts
  const actionResults = await actions.executeAllActions(checkResults, monitor);

  return { checkResults, actionResults };
}
