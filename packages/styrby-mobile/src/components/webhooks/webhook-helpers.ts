/**
 * Webhook UI Helpers
 *
 * Pure presentation-layer constants, helpers, and the create-form Zod schema
 * shared by the webhooks orchestrator and its sub-components.
 *
 * WHY co-located here (not in the hook):
 * `useWebhooks` owns the network and state contract. The strings, colors, and
 * formatting helpers below are purely presentational, so they live alongside
 * the components that consume them. Keeping them out of the hook keeps the
 * data layer free of UI concerns and lets us swap the design without touching
 * the API surface.
 */

import { z } from 'zod';
import type { WebhookEvent } from '../../types/webhooks';

/**
 * Event options shown in the create/edit form and detail view.
 *
 * WHY ordered explicitly (not derived):
 * The order is product-decided so that the most common event
 * (`session.started`) appears first. Sorting alphabetically would bury it.
 */
export const EVENT_OPTIONS: { value: WebhookEvent; label: string; description: string }[] = [
  {
    value: 'session.started',
    label: 'Session Started',
    description: 'When an agent session begins',
  },
  {
    value: 'session.completed',
    label: 'Session Completed',
    description: 'When an agent session ends',
  },
  {
    value: 'budget.exceeded',
    label: 'Budget Exceeded',
    description: 'When a budget alert threshold is crossed',
  },
  {
    value: 'permission.requested',
    label: 'Permission Requested',
    description: 'When an agent requests permission for an action',
  },
];

/**
 * Colors for event type badges.
 *
 * WHY hex with alpha (`20` suffix):
 * NativeWind's JIT does not support arbitrary alpha values reliably across
 * platforms; passing the colors via inline `style` keeps badge tinting
 * deterministic on iOS, Android, and web.
 */
export const EVENT_COLORS: Record<WebhookEvent, { bg: string; text: string }> = {
  'session.started': { bg: '#16a34a20', text: '#4ade80' },
  'session.completed': { bg: '#2563eb20', text: '#60a5fa' },
  'budget.exceeded': { bg: '#ea580c20', text: '#fb923c' },
  'permission.requested': { bg: '#9333ea20', text: '#c084fc' },
};

/**
 * Zod schema for the create/edit webhook form.
 *
 * WHY HTTPS-only:
 * Webhook secrets are HMAC-signed in transit; sending them over plain HTTP
 * would expose them to network observers. Enforcing HTTPS at the form layer
 * fails fast before the request hits the API.
 */
export const WebhookFormSchema = z.object({
  name: z
    .string()
    .min(1, 'Name is required')
    .max(100, 'Name must be 100 characters or less'),
  url: z
    .string()
    .url('Must be a valid URL')
    .refine((u) => u.startsWith('https://'), 'URL must use HTTPS'),
  events: z.array(z.string()).min(1, 'Select at least one event'),
});

/**
 * Truncates a URL to a fixed character limit for list display.
 *
 * @param url - The URL string to truncate
 * @param maxLength - Maximum display length (default 50)
 * @returns Truncated URL with ellipsis if needed
 */
export function truncateUrl(url: string, maxLength = 50): string {
  if (url.length <= maxLength) return url;
  return url.slice(0, maxLength - 3) + '...';
}

/**
 * Formats an ISO 8601 date string into a short human-readable date.
 *
 * @param iso - ISO 8601 date string
 * @returns Formatted date string (e.g., "Mar 29, 2026")
 */
export function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

/**
 * Formats an ISO 8601 date string into a short time-ago or absolute label
 * for delivery logs.
 *
 * @param iso - ISO 8601 date string
 * @returns Human-friendly relative string
 */
export function formatRelativeTime(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return formatDate(iso);
  } catch {
    return iso;
  }
}
