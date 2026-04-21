/**
 * Pure presentational helpers for the Budget Alerts feature.
 *
 * WHY pure functions: All visual classification (progress color, badge
 * color, percentage color) is deterministic from inputs. Keeping these
 * pure makes them trivially unit-testable and avoids re-rendering
 * concerns inside React components.
 */

import type { AlertAction, AlertPeriod, AgentType } from './types';

/**
 * Human-readable descriptions for each alert action.
 *
 * WHY: Shown both in the modal (decision-making context) and on alert
 * cards (badge label). Centralized so wording stays consistent if
 * marketing/legal updates copy.
 */
export const ACTION_DESCRIPTIONS: Record<
  AlertAction,
  { label: string; description: string; icon: string }
> = {
  notify: {
    label: 'Notify Only',
    description: 'Send a notification when the threshold is reached',
    icon: 'M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9',
  },
  warn_and_slowdown: {
    label: 'Warn & Slowdown',
    description: 'Notify and throttle agent activity to reduce spending',
    icon: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z',
  },
  hard_stop: {
    label: 'Hard Stop',
    description: 'Notify and immediately stop all agent usage',
    icon: 'M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636',
  },
};

/**
 * Color configuration for agent type badges.
 *
 * WHY: Matches the color scheme used throughout the Styrby dashboard so
 * agents are visually consistent across cost charts, alert cards, and
 * session lists.
 */
export const AGENT_COLORS: Record<AgentType, { bg: string; text: string }> = {
  claude: { bg: 'bg-orange-500/10', text: 'text-orange-400' },
  codex: { bg: 'bg-green-500/10', text: 'text-green-400' },
  gemini: { bg: 'bg-blue-500/10', text: 'text-blue-400' },
  opencode: { bg: 'bg-purple-500/10', text: 'text-purple-400' },
  aider: { bg: 'bg-pink-500/10', text: 'text-pink-400' },
  goose: { bg: 'bg-teal-500/10', text: 'text-teal-400' },
  amp: { bg: 'bg-amber-500/10', text: 'text-amber-400' },
  crush: { bg: 'bg-rose-500/10', text: 'text-rose-400' },
  kilo: { bg: 'bg-sky-500/10', text: 'text-sky-400' },
  kiro: { bg: 'bg-orange-500/10', text: 'text-orange-400' },
  droid: { bg: 'bg-slate-500/10', text: 'text-slate-400' },
};

/** Ordered list of agent types for rendering the agent filter grid. */
export const AGENT_TYPES: AgentType[] = [
  'claude',
  'codex',
  'gemini',
  'opencode',
  'aider',
  'goose',
  'amp',
  'crush',
  'kilo',
  'kiro',
  'droid',
];

/** Ordered list of alert periods for rendering the period selector. */
export const ALERT_PERIODS: AlertPeriod[] = ['daily', 'weekly', 'monthly'];

/** Ordered list of alert actions for rendering the action selector. */
export const ALERT_ACTIONS: AlertAction[] = [
  'notify',
  'warn_and_slowdown',
  'hard_stop',
];

/**
 * Returns the Tailwind CSS color class for a progress bar based on usage
 * percentage.
 *
 * WHY: Visual urgency helps users quickly identify alerts that need
 * attention.
 * - Green (<50%): Safe, well within budget
 * - Yellow (50-80%): Approaching threshold, be aware
 * - Orange (80-100%): Close to threshold, take action soon
 * - Red (>=100%): Over budget, immediate attention needed
 *
 * @param percentage - The percentage of the threshold used (0-100+)
 * @returns Tailwind CSS background color class
 */
export function getProgressColor(percentage: number): string {
  if (percentage >= 100) return 'bg-red-500';
  if (percentage >= 80) return 'bg-orange-500';
  if (percentage >= 50) return 'bg-yellow-500';
  return 'bg-green-500';
}

/**
 * Returns the Tailwind CSS text color class for a usage percentage.
 *
 * @param percentage - The percentage of the threshold used (0-100+)
 * @returns Tailwind CSS text color class
 */
export function getPercentageTextColor(percentage: number): string {
  if (percentage >= 100) return 'text-red-400';
  if (percentage >= 80) return 'text-orange-400';
  if (percentage >= 50) return 'text-yellow-400';
  return 'text-green-400';
}

/**
 * Returns the badge color classes for an alert action.
 *
 * @param action - The alert action type
 * @returns Object with bg and text Tailwind classes
 */
export function getActionBadgeColor(
  action: AlertAction
): { bg: string; text: string } {
  switch (action) {
    case 'notify':
      return { bg: 'bg-blue-500/10', text: 'text-blue-400' };
    case 'warn_and_slowdown':
      return { bg: 'bg-yellow-500/10', text: 'text-yellow-400' };
    case 'hard_stop':
      return { bg: 'bg-red-500/10', text: 'text-red-400' };
  }
}

/**
 * Returns the badge color classes for a period.
 *
 * @param period - The alert period
 * @returns Object with bg and text Tailwind classes
 */
export function getPeriodBadgeColor(
  period: AlertPeriod
): { bg: string; text: string } {
  switch (period) {
    case 'daily':
      return { bg: 'bg-purple-500/10', text: 'text-purple-400' };
    case 'weekly':
      return { bg: 'bg-cyan-500/10', text: 'text-cyan-400' };
    case 'monthly':
      return { bg: 'bg-indigo-500/10', text: 'text-indigo-400' };
  }
}
