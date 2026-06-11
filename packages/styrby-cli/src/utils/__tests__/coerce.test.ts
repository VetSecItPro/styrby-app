/**
 * Unit tests for `utils/coerce` — boundary coercion of untrusted agent output.
 *
 * These pin the contract relied on by the streaming parsers (opencode/kilo)
 * after the #24 DAST fix: a non-number, NaN, Infinity, or negative value from
 * agent stdout must never reach the `number`-typed CostReport / token-count.
 */

import { describe, it, expect } from 'vitest';
import { toNonNegativeNumber } from '../coerce';

describe('toNonNegativeNumber', () => {
  it('passes through finite non-negative numbers', () => {
    expect(toNonNegativeNumber(0)).toBe(0);
    expect(toNonNegativeNumber(42)).toBe(42);
    expect(toNonNegativeNumber(3.14)).toBe(3.14);
  });

  it('parses numeric strings (some CLIs stringify numbers)', () => {
    expect(toNonNegativeNumber('999')).toBe(999);
    expect(toNonNegativeNumber('0')).toBe(0);
    expect(toNonNegativeNumber('1e5')).toBe(100000);
  });

  it('falls back on negative numbers (token/cost are non-negative)', () => {
    expect(toNonNegativeNumber(-5)).toBe(0);
    expect(toNonNegativeNumber('-1')).toBe(0);
    expect(toNonNegativeNumber(-5, 7)).toBe(7);
  });

  it('falls back on NaN and Infinity', () => {
    expect(toNonNegativeNumber(NaN)).toBe(0);
    expect(toNonNegativeNumber(Infinity)).toBe(0);
    expect(toNonNegativeNumber(-Infinity)).toBe(0);
    expect(toNonNegativeNumber('NaN')).toBe(0);
  });

  it('falls back on non-numeric strings and empty/whitespace', () => {
    expect(toNonNegativeNumber('abc')).toBe(0);
    expect(toNonNegativeNumber('')).toBe(0);
    expect(toNonNegativeNumber('   ')).toBe(0);
  });

  it('falls back on non-number/non-string types', () => {
    expect(toNonNegativeNumber(null)).toBe(0);
    expect(toNonNegativeNumber(undefined)).toBe(0);
    expect(toNonNegativeNumber({})).toBe(0);
    expect(toNonNegativeNumber([])).toBe(0);
    expect(toNonNegativeNumber(true)).toBe(0);
  });

  it('uses the provided fallback when coercion fails', () => {
    expect(toNonNegativeNumber({}, 100)).toBe(100);
    expect(toNonNegativeNumber('garbage', 5)).toBe(5);
  });
});
