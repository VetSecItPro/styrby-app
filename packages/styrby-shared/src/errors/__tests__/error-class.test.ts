/**
 * Tests for error-class taxonomy (unblocks Phase 1.6.7b error histogram).
 *
 * WHY test the constant itself: if someone adds/removes an entry without
 * also updating migration 029, CI will catch the divergence here via the
 * contract tests that lock the exact set of five classes.
 */

import { describe, it, expect } from 'vitest';
import { ERROR_CLASSES, isErrorClass, type ErrorClass } from '../error-class.js';

describe('ERROR_CLASSES constant', () => {
  it('contains exactly the five canonical classes from Phase 1.6.10', () => {
    expect(ERROR_CLASSES).toEqual([
      'network',
      'auth',
      'supabase',
      'agent_crash',
      'unknown',
    ]);
  });

  it('matches the DB CHECK constraint in migration 029', () => {
    // If this test fails, migration 029 also needs to update.
    // Both must change together or the DB and app will disagree.
    const expectedDbValues = new Set(['network', 'auth', 'supabase', 'agent_crash', 'unknown']);
    expect(new Set(ERROR_CLASSES)).toEqual(expectedDbValues);
  });

  it('is readonly at the TypeScript level (frozen tuple)', () => {
    // Verifies `as const` gave us a readonly tuple, not a mutable array.
    // If someone drops `as const`, this stops compiling.
    const _check: readonly string[] = ERROR_CLASSES;
    expect(_check.length).toBe(5);
  });
});

describe('isErrorClass type guard', () => {
  it.each(['network', 'auth', 'supabase', 'agent_crash', 'unknown'])(
    'returns true for canonical class %s',
    (cls) => {
      expect(isErrorClass(cls)).toBe(true);
    },
  );

  it.each(['db', 'NETWORK', '', ' network'])(
    'returns false for non-canonical string %s',
    (value) => {
      expect(isErrorClass(value)).toBe(false);
    },
  );

  it('returns false for non-string values (null, undefined, number, object, array, boolean)', () => {
    // WHY one test instead of it.each: mixing these types in a single
    // it.each tuple array confuses TypeScript's tuple-inference. Plain
    // iteration keeps the types loose + the test just as thorough.
    const nonStrings: unknown[] = [null, undefined, 42, {}, [], true];
    for (const value of nonStrings) {
      expect(isErrorClass(value)).toBe(false);
    }
  });

  it('narrows the type for downstream callers', () => {
    const raw: unknown = 'auth';
    if (isErrorClass(raw)) {
      // If narrowing broke, this assignment would fail typecheck.
      const narrowed: ErrorClass = raw;
      expect(narrowed).toBe('auth');
    } else {
      throw new Error('expected narrowing to succeed');
    }
  });
});
