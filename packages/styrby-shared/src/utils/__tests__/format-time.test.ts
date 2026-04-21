/**
 * Tests for time formatting utilities (utils/format-time.ts).
 *
 * WHY thorough: formatTime converts Postgres TIME strings to 12-hour display
 * for both mobile and web quiet-hours UI. Any edge case divergence between
 * platforms would cause silent display bugs.
 *
 * @module utils/__tests__/format-time
 */

import { describe, it, expect } from 'vitest';
import { formatTime } from '../format-time.js';

describe('formatTime', () => {
  // ── PM conversions ────────────────────────────────────────────────────────
  it('converts 22:00:00 to 10:00 PM', () => {
    expect(formatTime('22:00:00', '--')).toBe('10:00 PM');
  });

  it('converts 12:00:00 to 12:00 PM (noon)', () => {
    expect(formatTime('12:00:00', '--')).toBe('12:00 PM');
  });

  it('converts 13:30:00 to 1:30 PM', () => {
    expect(formatTime('13:30:00', '--')).toBe('1:30 PM');
  });

  it('converts 23:59:00 to 11:59 PM', () => {
    expect(formatTime('23:59:00', '--')).toBe('11:59 PM');
  });

  // ── AM conversions ────────────────────────────────────────────────────────
  it('converts 00:00:00 to 12:00 AM (midnight)', () => {
    expect(formatTime('00:00:00', '--')).toBe('12:00 AM');
  });

  it('converts 07:30:00 to 7:30 AM', () => {
    expect(formatTime('07:30:00', '--')).toBe('7:30 AM');
  });

  it('converts 01:05:00 to 1:05 AM', () => {
    expect(formatTime('01:05:00', '--')).toBe('1:05 AM');
  });

  it('converts 11:59:00 to 11:59 AM', () => {
    expect(formatTime('11:59:00', '--')).toBe('11:59 AM');
  });

  // ── Fallback values ───────────────────────────────────────────────────────
  it('returns the fallback when time is null', () => {
    expect(formatTime(null, 'Not set')).toBe('Not set');
  });

  it('returns the fallback when time is an empty string', () => {
    expect(formatTime('', 'N/A')).toBe('N/A');
  });

  // ── HH:MM format (without seconds) ───────────────────────────────────────
  it('handles HH:MM format without seconds', () => {
    expect(formatTime('22:00', '--')).toBe('10:00 PM');
    expect(formatTime('07:30', '--')).toBe('7:30 AM');
  });

  // ── Minute padding ────────────────────────────────────────────────────────
  it('zero-pads single-digit minutes (e.g. 7:05 not 7:5)', () => {
    expect(formatTime('07:05:00', '--')).toBe('7:05 AM');
    expect(formatTime('14:02:00', '--')).toBe('2:02 PM');
  });

  // ── Fallback string varieties ─────────────────────────────────────────────
  it('returns the exact fallback string provided', () => {
    expect(formatTime(null, '--')).toBe('--');
    expect(formatTime(null, 'N/A')).toBe('N/A');
    expect(formatTime(null, 'Not configured')).toBe('Not configured');
  });
});
