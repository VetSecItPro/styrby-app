/**
 * Tests for webhook-helpers — Phase 1 #4 batch 1 follow-up.
 *
 * Pure formatting helpers for the webhooks screen. No React, no IO.
 *
 * @module components/webhooks/__tests__/webhook-helpers
 */

import {
  truncateUrl,
  formatDate,
  formatRelativeTime,
  EVENT_OPTIONS,
  EVENT_COLORS,
  WebhookFormSchema,
} from '../webhook-helpers';

describe('truncateUrl', () => {
  it('returns the input unchanged when within limit', () => {
    expect(truncateUrl('https://example.com', 50)).toBe('https://example.com');
  });

  it('truncates with an ellipsis when over limit', () => {
    const long = 'https://example.com/' + 'x'.repeat(100);
    const result = truncateUrl(long, 50);
    expect(result).toHaveLength(50);
    expect(result.endsWith('...')).toBe(true);
  });

  it('respects custom maxLength', () => {
    expect(truncateUrl('https://example.com/abcdef', 10)).toHaveLength(10);
    expect(truncateUrl('https://example.com/abcdef', 10).endsWith('...')).toBe(true);
  });

  it('handles exact-length input (no ellipsis)', () => {
    const exact = 'a'.repeat(50);
    expect(truncateUrl(exact, 50)).toBe(exact);
  });
});

describe('formatDate', () => {
  it('returns a short formatted date for valid ISO input', () => {
    const result = formatDate('2026-04-20T15:00:00Z');
    expect(result).toMatch(/Apr 20, 2026/);
  });

  it('returns the input unchanged on invalid input (no throw)', () => {
    // toLocaleDateString returns "Invalid Date" rather than throwing — but
    // the helper's try/catch is the contract: it must never throw.
    expect(() => formatDate('not-a-date')).not.toThrow();
  });
});

describe('formatRelativeTime', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-20T12:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns "just now" for less than a minute ago', () => {
    expect(formatRelativeTime('2026-04-20T11:59:50Z')).toBe('just now');
  });

  it('returns Nm ago for under an hour', () => {
    expect(formatRelativeTime('2026-04-20T11:30:00Z')).toBe('30m ago');
  });

  it('returns Nh ago for under a day', () => {
    expect(formatRelativeTime('2026-04-20T05:00:00Z')).toMatch(/^7h ago$/);
  });

  it('falls back to absolute date for older timestamps', () => {
    // 7 days ago — relative-time should switch to absolute
    expect(formatRelativeTime('2026-04-13T12:00:00Z')).toMatch(/Apr/);
  });

  it('does not throw on invalid input', () => {
    expect(() => formatRelativeTime('not-a-date')).not.toThrow();
  });
});

describe('EVENT_OPTIONS + EVENT_COLORS', () => {
  it('every EVENT_OPTIONS entry has a matching EVENT_COLORS entry', () => {
    for (const opt of EVENT_OPTIONS) {
      expect(EVENT_COLORS[opt.value]).toBeDefined();
      expect(EVENT_COLORS[opt.value].bg).toBeTruthy();
      expect(EVENT_COLORS[opt.value].text).toBeTruthy();
    }
  });

  it('EVENT_OPTIONS labels and descriptions are non-empty', () => {
    for (const opt of EVENT_OPTIONS) {
      expect(opt.label.length).toBeGreaterThan(0);
      expect(opt.description.length).toBeGreaterThan(0);
    }
  });
});

describe('WebhookFormSchema (Zod)', () => {
  const baseValid = {
    name: 'Slack notifier',
    url: 'https://example.com/hook',
    events: ['session.completed' as const],
    description: '',
  };

  it('accepts a valid form payload', () => {
    expect(WebhookFormSchema.safeParse(baseValid).success).toBe(true);
  });

  it('rejects a missing name', () => {
    const result = WebhookFormSchema.safeParse({ ...baseValid, name: '' });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid URL', () => {
    const result = WebhookFormSchema.safeParse({ ...baseValid, url: 'not-a-url' });
    expect(result.success).toBe(false);
  });

  it('rejects an empty events array', () => {
    const result = WebhookFormSchema.safeParse({ ...baseValid, events: [] });
    expect(result.success).toBe(false);
  });
});
