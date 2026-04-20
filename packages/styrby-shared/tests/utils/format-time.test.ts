/**
 * Tests for the formatTime utility.
 *
 * Characterizes the exact behavior of the previous inline implementation
 * at packages/styrby-mobile/app/(tabs)/settings.tsx so we can extract with
 * confidence that no user-visible time label changes.
 */

import { describe, it, expect } from 'vitest';
import { formatTime } from '../../src/utils/format-time.js';

describe('formatTime', () => {
  it('returns the fallback when time is null', () => {
    expect(formatTime(null, '--')).toBe('--');
  });

  it('returns the fallback when time is empty string', () => {
    expect(formatTime('', 'Not set')).toBe('Not set');
  });

  it('formats 22:00:00 as 10:00 PM', () => {
    expect(formatTime('22:00:00', '--')).toBe('10:00 PM');
  });

  it('formats 07:00:00 as 7:00 AM', () => {
    expect(formatTime('07:00:00', '--')).toBe('7:00 AM');
  });

  it('formats 07:30:00 as 7:30 AM (zero-pads minutes)', () => {
    expect(formatTime('07:30:00', '--')).toBe('7:30 AM');
  });

  it('formats 00:00:00 as 12:00 AM (midnight)', () => {
    expect(formatTime('00:00:00', '--')).toBe('12:00 AM');
  });

  it('formats 12:00:00 as 12:00 PM (noon)', () => {
    expect(formatTime('12:00:00', '--')).toBe('12:00 PM');
  });

  it('formats 13:05:00 as 1:05 PM', () => {
    expect(formatTime('13:05:00', '--')).toBe('1:05 PM');
  });

  it('handles HH:MM format (no seconds) identically', () => {
    expect(formatTime('09:15', '--')).toBe('9:15 AM');
  });
});
