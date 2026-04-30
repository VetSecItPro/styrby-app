/**
 * Tests for sessions/grouping helpers (Phase 1 #4 batch 1 follow-up).
 *
 * Pure data transforms — no React, no IO. Locks the day-bucketing
 * behavior so a future timezone-handling refactor can't silently break
 * the SessionList grouping.
 *
 * @module components/sessions/__tests__/grouping
 */

import { formatSectionDate, getDateKey, groupSessionsByDate } from '../grouping';

// Minimal SessionRow stub — we only consume `started_at`.
// WHY `as never`: the real SessionRow has 13+ fields irrelevant to grouping.
// Casting through `never` keeps the test focused on the contract under test.
type StubSessionRow = { id: string; started_at: string };
const asSessions = (s: StubSessionRow[]) =>
  s as unknown as Parameters<typeof groupSessionsByDate>[0];

describe('formatSectionDate', () => {
  beforeEach(() => {
    // Lock "now" so "Today"/"Yesterday" assertions are deterministic.
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-20T15:00:00'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns "Today" for the current local date', () => {
    expect(formatSectionDate(new Date('2026-04-20T08:00:00'))).toBe('Today');
  });

  it('returns "Yesterday" for one local day ago', () => {
    expect(formatSectionDate(new Date('2026-04-19T08:00:00'))).toBe('Yesterday');
  });

  it('returns short day-month-date for older dates', () => {
    // 2026-04-13 is a Monday
    expect(formatSectionDate(new Date('2026-04-13T08:00:00'))).toBe('Mon Apr 13');
  });

  it('handles year boundaries — December 31 prior year', () => {
    expect(formatSectionDate(new Date('2025-12-31T08:00:00'))).toMatch(/^\w{3} Dec 31$/);
  });
});

describe('getDateKey', () => {
  it('returns YYYY-MM-DD in local timezone', () => {
    // 2026-04-20 in local TZ regardless of host
    const key = getDateKey('2026-04-20T15:00:00');
    expect(key).toBe('2026-04-20');
  });

  it('zero-pads single-digit months and days', () => {
    expect(getDateKey('2026-01-05T10:00:00')).toBe('2026-01-05');
  });

  it('groups two timestamps from the same local day to the same key', () => {
    const a = getDateKey('2026-04-20T01:00:00');
    const b = getDateKey('2026-04-20T23:00:00');
    expect(a).toBe(b);
  });
});

describe('groupSessionsByDate', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-20T15:00:00'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns an empty array for empty input', () => {
    expect(groupSessionsByDate([])).toEqual([]);
  });

  it('groups sessions from the same day into one section', () => {
    const sessions: StubSessionRow[] = [
      { id: 's1', started_at: '2026-04-20T08:00:00' },
      { id: 's2', started_at: '2026-04-20T10:30:00' },
      { id: 's3', started_at: '2026-04-20T22:00:00' },
    ];
    const result = groupSessionsByDate(asSessions(sessions));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ title: 'Today', count: 3 });
    expect(result[0].data.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
  });

  it('preserves input order within each section', () => {
    const sessions: StubSessionRow[] = [
      { id: 's3', started_at: '2026-04-20T22:00:00' }, // newer first
      { id: 's1', started_at: '2026-04-20T08:00:00' },
    ];
    const result = groupSessionsByDate(asSessions(sessions));
    expect(result[0].data.map((s) => s.id)).toEqual(['s3', 's1']);
  });

  it('creates separate sections for different days, labeled correctly', () => {
    const sessions: StubSessionRow[] = [
      { id: 'today', started_at: '2026-04-20T08:00:00' },
      { id: 'yest', started_at: '2026-04-19T08:00:00' },
      { id: 'older', started_at: '2026-04-13T08:00:00' },
    ];
    const result = groupSessionsByDate(asSessions(sessions));
    expect(result).toHaveLength(3);
    expect(result.map((s) => s.title)).toEqual(['Today', 'Yesterday', 'Mon Apr 13']);
  });

  it('section count matches data length', () => {
    const sessions: StubSessionRow[] = Array.from({ length: 5 }, (_, i) => ({
      id: `s${i}`,
      started_at: `2026-04-20T${String(i).padStart(2, '0')}:00:00`,
    }));
    const result = groupSessionsByDate(asSessions(sessions));
    expect(result[0].count).toBe(5);
    expect(result[0].data).toHaveLength(5);
  });
});
