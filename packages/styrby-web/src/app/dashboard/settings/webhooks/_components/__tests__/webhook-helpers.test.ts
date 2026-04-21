/**
 * Unit tests for webhook helper pure functions.
 *
 * WHY co-located: These helpers are folder-local utilities; tests sit next
 * to them so a future refactor of `_components/` keeps tests in lockstep
 * with implementation.
 */

import { describe, expect, it } from 'vitest';

import {
  formatLastSuccess,
  getDeliveryStatusClasses,
  getEventColors,
  isFormSubmittable,
  toggleEvent,
} from '../webhook-helpers';
import { EVENT_COLORS, FALLBACK_EVENT_COLORS, type WebhookEvent } from '../webhook-types';

describe('getEventColors', () => {
  it('returns the mapped colors for known events', () => {
    expect(getEventColors('session.started')).toEqual(EVENT_COLORS['session.started']);
    expect(getEventColors('session.completed')).toEqual(EVENT_COLORS['session.completed']);
    expect(getEventColors('budget.exceeded')).toEqual(EVENT_COLORS['budget.exceeded']);
    expect(getEventColors('permission.requested')).toEqual(
      EVENT_COLORS['permission.requested'],
    );
  });

  it('returns the neutral fallback for unknown events', () => {
    expect(getEventColors('unknown.event')).toEqual(FALLBACK_EVENT_COLORS);
    expect(getEventColors('')).toEqual(FALLBACK_EVENT_COLORS);
  });
});

describe('formatLastSuccess', () => {
  it('returns the empty-state copy when null', () => {
    expect(formatLastSuccess(null)).toBe('No deliveries yet');
  });

  it('formats a valid ISO timestamp into a short locale string', () => {
    const formatted = formatLastSuccess('2026-04-20T15:30:00.000Z');
    // Just assert non-empty + not the empty-state string. Locale formatting
    // can vary across CI nodes — we don't pin TZ in vitest.setup.
    expect(formatted).not.toBe('No deliveries yet');
    expect(formatted.length).toBeGreaterThan(0);
  });
});

describe('toggleEvent', () => {
  it('adds an event when not present', () => {
    const result = toggleEvent(['session.started'], 'budget.exceeded');
    expect(result).toEqual(['session.started', 'budget.exceeded']);
  });

  it('removes an event when present', () => {
    const result = toggleEvent(
      ['session.started', 'budget.exceeded'],
      'session.started',
    );
    expect(result).toEqual(['budget.exceeded']);
  });

  it('does not mutate the input array', () => {
    const input: WebhookEvent[] = ['session.started'];
    toggleEvent(input, 'session.completed');
    expect(input).toEqual(['session.started']);
  });

  it('handles toggling on an empty list', () => {
    expect(toggleEvent([], 'session.started')).toEqual(['session.started']);
  });
});

describe('isFormSubmittable', () => {
  it('returns true when name + url + at least one event are present', () => {
    expect(
      isFormSubmittable({
        name: 'Slack',
        url: 'https://example.com',
        events: ['session.started'],
      }),
    ).toBe(true);
  });

  it('returns false when name is whitespace only', () => {
    expect(
      isFormSubmittable({
        name: '   ',
        url: 'https://example.com',
        events: ['session.started'],
      }),
    ).toBe(false);
  });

  it('returns false when url is whitespace only', () => {
    expect(
      isFormSubmittable({
        name: 'Slack',
        url: '   ',
        events: ['session.started'],
      }),
    ).toBe(false);
  });

  it('returns false when no events are selected', () => {
    expect(
      isFormSubmittable({ name: 'Slack', url: 'https://example.com', events: [] }),
    ).toBe(false);
  });
});

describe('getDeliveryStatusClasses', () => {
  it('returns green classes for success', () => {
    expect(getDeliveryStatusClasses('success')).toContain('green');
  });

  it('returns yellow classes for pending', () => {
    expect(getDeliveryStatusClasses('pending')).toContain('yellow');
  });

  it('returns red classes for any other status (treated as failure)', () => {
    expect(getDeliveryStatusClasses('failed')).toContain('red');
    expect(getDeliveryStatusClasses('timeout')).toContain('red');
    expect(getDeliveryStatusClasses('')).toContain('red');
  });
});
