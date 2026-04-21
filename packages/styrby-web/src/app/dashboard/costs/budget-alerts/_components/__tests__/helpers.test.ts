/**
 * Unit tests for budget-alerts presentational helpers.
 *
 * WHY: These pure functions encode the visual urgency thresholds that
 * users rely on to spot over-budget alerts. Regressions in the threshold
 * boundaries would silently change which alerts look "safe" vs "danger".
 */

import { describe, it, expect } from 'vitest';
import {
  getProgressColor,
  getPercentageTextColor,
  getActionBadgeColor,
  getPeriodBadgeColor,
} from '../helpers';

describe('getProgressColor', () => {
  it('returns green below 50%', () => {
    expect(getProgressColor(0)).toBe('bg-green-500');
    expect(getProgressColor(49.9)).toBe('bg-green-500');
  });

  it('returns yellow at 50% boundary and below 80%', () => {
    expect(getProgressColor(50)).toBe('bg-yellow-500');
    expect(getProgressColor(79.9)).toBe('bg-yellow-500');
  });

  it('returns orange at 80% boundary and below 100%', () => {
    expect(getProgressColor(80)).toBe('bg-orange-500');
    expect(getProgressColor(99.9)).toBe('bg-orange-500');
  });

  it('returns red at 100% and above', () => {
    expect(getProgressColor(100)).toBe('bg-red-500');
    expect(getProgressColor(250)).toBe('bg-red-500');
  });
});

describe('getPercentageTextColor', () => {
  it('mirrors progress color thresholds', () => {
    expect(getPercentageTextColor(0)).toBe('text-green-400');
    expect(getPercentageTextColor(50)).toBe('text-yellow-400');
    expect(getPercentageTextColor(80)).toBe('text-orange-400');
    expect(getPercentageTextColor(100)).toBe('text-red-400');
  });
});

describe('getActionBadgeColor', () => {
  it('returns blue palette for notify', () => {
    expect(getActionBadgeColor('notify')).toEqual({
      bg: 'bg-blue-500/10',
      text: 'text-blue-400',
    });
  });

  it('returns yellow palette for warn_and_slowdown', () => {
    expect(getActionBadgeColor('warn_and_slowdown')).toEqual({
      bg: 'bg-yellow-500/10',
      text: 'text-yellow-400',
    });
  });

  it('returns red palette for hard_stop', () => {
    expect(getActionBadgeColor('hard_stop')).toEqual({
      bg: 'bg-red-500/10',
      text: 'text-red-400',
    });
  });
});

describe('getPeriodBadgeColor', () => {
  it('assigns a distinct palette per period', () => {
    expect(getPeriodBadgeColor('daily').text).toBe('text-purple-400');
    expect(getPeriodBadgeColor('weekly').text).toBe('text-cyan-400');
    expect(getPeriodBadgeColor('monthly').text).toBe('text-indigo-400');
  });
});
