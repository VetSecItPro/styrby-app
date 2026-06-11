/**
 * Boundary coercion helpers for untrusted agent output.
 *
 * Agent stdout is semi-trusted: a buggy or compromised agent binary, a schema
 * drift in a new version, or a truncated/corrupt pipe write can deliver a
 * string, null, object, NaN, or +/-Infinity where the protocol promised a
 * number. These helpers normalise such values at the single point where parsed
 * agent output enters our typed model, so downstream code (cost-report,
 * token-count, the cost dashboard) can rely on the declared `number` type.
 *
 * @module utils/coerce
 */

/**
 * Coerce an untrusted value to a finite, non-negative number.
 *
 * WHY non-negative: every numeric field we parse from agent output (token
 * counts, USD cost, cache reads/writes) is non-negative by nature. A negative
 * value is as malformed as a string here, so it degrades to the fallback rather
 * than shipping nonsense (e.g. -5 tokens) to the cost dashboard.
 *
 * Numeric strings ("999") are accepted because some CLIs stringify numbers in
 * JSON output; anything that does not parse to a finite number (NaN, Infinity,
 * "abc", {}, [], true, null, undefined) returns the fallback.
 *
 * @param value - The untrusted value from parsed agent output.
 * @param fallback - Value used when `value` is not a finite, non-negative number. Default 0.
 * @returns A finite, non-negative number.
 *
 * @example
 * toNonNegativeNumber(42)        // 42
 * toNonNegativeNumber("999")     // 999
 * toNonNegativeNumber(-5)        // 0
 * toNonNegativeNumber("NaN")     // 0
 * toNonNegativeNumber({}, 1)     // 1
 */
export function toNonNegativeNumber(value: unknown, fallback = 0): number {
  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    n = Number(value);
  } else {
    return fallback;
  }
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
