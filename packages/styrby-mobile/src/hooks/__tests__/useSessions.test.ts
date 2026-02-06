/**
 * Unit tests for pure utility functions exported from useSessions hook.
 * Tests formatRelativeTime and getFirstLine utilities only.
 * Does NOT test the React hook itself (requires renderHook setup).
 */

// Mock React hooks to prevent errors on import
jest.mock('react', () => ({
  ...jest.requireActual('react'),
  useState: jest.fn((init) => [init, jest.fn()]),
  useEffect: jest.fn(),
  useCallback: jest.fn((fn) => fn),
  useRef: jest.fn((init) => ({ current: init })),
}));

// Mock Supabase
jest.mock('../../lib/supabase', () => ({
  supabase: {
    auth: { getUser: jest.fn() },
    from: jest.fn(),
  },
}));

import { formatRelativeTime, getFirstLine } from '../useSessions';

describe('formatRelativeTime', () => {
  let dateNowSpy: jest.SpyInstance;

  beforeEach(() => {
    // Set a fixed "now" time: 2024-01-15T12:00:00Z
    dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(
      new Date('2024-01-15T12:00:00Z').getTime()
    );
  });

  afterEach(() => {
    dateNowSpy.mockRestore();
  });

  it('returns "just now" for timestamps less than 1 minute ago', () => {
    // 30 seconds ago
    const timestamp = new Date('2024-01-15T11:59:30Z').toISOString();
    expect(formatRelativeTime(timestamp)).toBe('just now');

    // 0 seconds ago (exactly now)
    const timestampNow = new Date('2024-01-15T12:00:00Z').toISOString();
    expect(formatRelativeTime(timestampNow)).toBe('just now');

    // 59 seconds ago
    const timestamp59s = new Date('2024-01-15T11:59:01Z').toISOString();
    expect(formatRelativeTime(timestamp59s)).toBe('just now');
  });

  it('returns "just now" for future timestamps', () => {
    // 10 seconds in the future
    const futureTimestamp = new Date('2024-01-15T12:00:10Z').toISOString();
    expect(formatRelativeTime(futureTimestamp)).toBe('just now');

    // 1 hour in the future
    const futureHour = new Date('2024-01-15T13:00:00Z').toISOString();
    expect(formatRelativeTime(futureHour)).toBe('just now');
  });

  it('returns "Xm ago" for timestamps < 1 hour ago', () => {
    // 5 minutes ago
    const timestamp5m = new Date('2024-01-15T11:55:00Z').toISOString();
    expect(formatRelativeTime(timestamp5m)).toBe('5m ago');

    // 30 minutes ago
    const timestamp30m = new Date('2024-01-15T11:30:00Z').toISOString();
    expect(formatRelativeTime(timestamp30m)).toBe('30m ago');

    // 59 minutes ago
    const timestamp59m = new Date('2024-01-15T11:01:00Z').toISOString();
    expect(formatRelativeTime(timestamp59m)).toBe('59m ago');

    // 1 minute ago (exactly)
    const timestamp1m = new Date('2024-01-15T11:59:00Z').toISOString();
    expect(formatRelativeTime(timestamp1m)).toBe('1m ago');
  });

  it('returns "Xh ago" for timestamps < 24 hours ago', () => {
    // 3 hours ago
    const timestamp3h = new Date('2024-01-15T09:00:00Z').toISOString();
    expect(formatRelativeTime(timestamp3h)).toBe('3h ago');

    // 12 hours ago
    const timestamp12h = new Date('2024-01-15T00:00:00Z').toISOString();
    expect(formatRelativeTime(timestamp12h)).toBe('12h ago');

    // 23 hours ago
    const timestamp23h = new Date('2024-01-14T13:00:00Z').toISOString();
    expect(formatRelativeTime(timestamp23h)).toBe('23h ago');

    // 1 hour ago (exactly)
    const timestamp1h = new Date('2024-01-15T11:00:00Z').toISOString();
    expect(formatRelativeTime(timestamp1h)).toBe('1h ago');
  });

  it('returns "yesterday" for timestamps 24-48 hours ago', () => {
    // Exactly 24 hours ago
    const timestamp24h = new Date('2024-01-14T12:00:00Z').toISOString();
    expect(formatRelativeTime(timestamp24h)).toBe('yesterday');

    // 30 hours ago
    const timestamp30h = new Date('2024-01-14T06:00:00Z').toISOString();
    expect(formatRelativeTime(timestamp30h)).toBe('yesterday');

    // 47 hours ago (just before 48h boundary)
    const timestamp47h = new Date('2024-01-13T13:00:00Z').toISOString();
    expect(formatRelativeTime(timestamp47h)).toBe('yesterday');
  });

  it('returns "Mon DD" format for timestamps older than 2 days', () => {
    // Exactly 48 hours ago (2 days) - should show date format
    const timestamp48h = new Date('2024-01-13T12:00:00Z').toISOString();
    expect(formatRelativeTime(timestamp48h)).toBe('Jan 13');

    // 3 days ago
    const timestamp3d = new Date('2024-01-12T12:00:00Z').toISOString();
    expect(formatRelativeTime(timestamp3d)).toBe('Jan 12');

    // 1 week ago
    const timestamp1w = new Date('2024-01-08T12:00:00Z').toISOString();
    expect(formatRelativeTime(timestamp1w)).toBe('Jan 8');

    // Different month (30 days ago)
    const timestamp30d = new Date('2023-12-16T12:00:00Z').toISOString();
    expect(formatRelativeTime(timestamp30d)).toBe('Dec 16');

    // Different year (1 year ago)
    const timestamp1y = new Date('2023-01-15T12:00:00Z').toISOString();
    expect(formatRelativeTime(timestamp1y)).toBe('Jan 15');
  });

  it('handles all month abbreviations correctly', () => {
    // Test all 12 months using midday UTC to avoid timezone edge cases.
    // WHY: formatRelativeTime uses `new Date(iso).getMonth()` which returns
    // the LOCAL month. Using midday ensures the local date matches the UTC date
    // in all timezones from UTC-12 to UTC+12.
    const months = [
      { date: '2024-01-15T12:00:00Z', expected: 'Jan 15' },
      { date: '2024-02-15T12:00:00Z', expected: 'Feb 15' },
      { date: '2024-03-15T12:00:00Z', expected: 'Mar 15' },
      { date: '2024-04-15T12:00:00Z', expected: 'Apr 15' },
      { date: '2024-05-15T12:00:00Z', expected: 'May 15' },
      { date: '2024-06-15T12:00:00Z', expected: 'Jun 15' },
      { date: '2024-07-15T12:00:00Z', expected: 'Jul 15' },
      { date: '2024-08-15T12:00:00Z', expected: 'Aug 15' },
      { date: '2024-09-15T12:00:00Z', expected: 'Sep 15' },
      { date: '2024-10-15T12:00:00Z', expected: 'Oct 15' },
      { date: '2024-11-15T12:00:00Z', expected: 'Nov 15' },
      { date: '2024-12-15T12:00:00Z', expected: 'Dec 15' },
    ];

    // Set "now" to a time far in the future so all dates are old
    dateNowSpy.mockReturnValue(new Date('2025-06-01T12:00:00Z').getTime());

    months.forEach(({ date, expected }) => {
      expect(formatRelativeTime(date)).toBe(expected);
    });
  });
});

describe('getFirstLine', () => {
  it('returns null for null input', () => {
    expect(getFirstLine(null)).toBe(null);
  });

  it('returns null for empty string', () => {
    expect(getFirstLine('')).toBe(null);
  });

  it('returns the first line for single-line input', () => {
    expect(getFirstLine('Single line summary')).toBe('Single line summary');
  });

  it('returns the first non-empty line for multi-line input', () => {
    const multiLine = 'First line\nSecond line\nThird line';
    expect(getFirstLine(multiLine)).toBe('First line');
  });

  it('trims whitespace from the first line', () => {
    expect(getFirstLine('   Leading and trailing spaces   ')).toBe(
      'Leading and trailing spaces'
    );
    expect(getFirstLine('\t\tTabbed line\t\t')).toBe('Tabbed line');
    expect(getFirstLine('  \n  Spaces before newline  \n  ')).toBe(
      'Spaces before newline'
    );
  });

  it('returns null for string with only empty lines/whitespace', () => {
    expect(getFirstLine('   ')).toBe(null);
    expect(getFirstLine('\n\n\n')).toBe(null);
    expect(getFirstLine('   \n   \n   ')).toBe(null);
    expect(getFirstLine('\t\t\n\t\t')).toBe(null);
  });

  it('handles \\n and \\r\\n line endings', () => {
    // Unix line endings (\n)
    const unixMultiline = 'First line\nSecond line\nThird line';
    expect(getFirstLine(unixMultiline)).toBe('First line');

    // Windows line endings (\r\n)
    const windowsMultiline = 'First line\r\nSecond line\r\nThird line';
    expect(getFirstLine(windowsMultiline)).toBe('First line');

    // Mixed line endings
    const mixedMultiline = 'First line\r\nSecond line\nThird line';
    expect(getFirstLine(mixedMultiline)).toBe('First line');
  });

  it('skips leading empty lines and returns first non-empty line', () => {
    const withLeadingEmpty = '\n\n\nFirst non-empty line\nSecond line';
    expect(getFirstLine(withLeadingEmpty)).toBe('First non-empty line');

    const withLeadingWhitespace = '   \n\t\t\nFirst non-empty line\nSecond line';
    expect(getFirstLine(withLeadingWhitespace)).toBe('First non-empty line');
  });

  it('handles edge cases with special characters', () => {
    expect(getFirstLine('Line with emoji 🚀\nSecond line')).toBe(
      'Line with emoji 🚀'
    );
    expect(getFirstLine('Special chars: !@#$%^&*()\nSecond line')).toBe(
      'Special chars: !@#$%^&*()'
    );
    expect(getFirstLine('Unicode: 你好世界\nSecond line')).toBe('Unicode: 你好世界');
  });

  it('handles very long first lines', () => {
    const longLine = 'A'.repeat(1000);
    const multilineWithLongFirst = `${longLine}\nSecond line`;
    expect(getFirstLine(multilineWithLongFirst)).toBe(longLine);
  });
});
