/**
 * Canonical error-class taxonomy for audit_log and founder-dashboard histogram.
 *
 * WHY this lives in @styrby/shared:
 *   Three consumers need the identical list:
 *     1. daemon/daemonProcess.ts (classifyError() on the CLI side)
 *     2. API routes that write audit_log entries with error_class (web)
 *     3. The founder-dashboard histogram UI that reads and groups by them (web)
 *   A shared constant + type prevents drift between classifier, writer, and
 *   reader. See migration 029 for the matching DB-level CHECK constraint.
 *
 * WHY a frozen tuple + derived type:
 *   Using `as const` + indexed access gives us a string literal union that
 *   TypeScript enforces at every call site, while the runtime array is
 *   iterable (for Zod schemas, dropdown filters in the founder UI, etc.).
 *
 * @module errors/error-class
 */

/**
 * The five canonical error classes Styrby records on audit_log entries.
 *
 * Taxonomy origin: Phase 1.6.10 (PR #126) classifyError() in daemon runtime.
 * Locked in at the DB level by migration 029's CHECK constraint.
 *
 * - `network`: transport-level failures (DNS, TLS, timeout, reset)
 * - `auth`: 401/403 from relay, Supabase Auth, or OAuth exchange
 * - `supabase`: 5xx from Supabase REST/realtime, schema errors, RLS denials surfaced as errors
 * - `agent_crash`: the child agent process exited non-zero unexpectedly
 * - `unknown`: did not match any of the above
 *
 * Adding a new class requires BOTH a new migration AND updating this
 * constant. The DB CHECK constraint will reject inserts that use a class
 * not present in this list.
 */
export const ERROR_CLASSES = [
  'network',
  'auth',
  'supabase',
  'agent_crash',
  'unknown',
] as const;

/**
 * Union type of the five canonical error classes.
 * Derived from ERROR_CLASSES so the tuple is the single source of truth.
 */
export type ErrorClass = typeof ERROR_CLASSES[number];

/**
 * Type guard for runtime validation before writing to audit_log.
 *
 * WHY this exists: before inserting a row with an error_class value, callers
 * that received the value from user-space (e.g., a CLI-reported error) must
 * validate it against the taxonomy. The DB CHECK constraint is the final
 * safety net, but failing fast at the boundary gives a clearer error
 * message and avoids a round-trip to the database.
 *
 * @param value - Any value to test
 * @returns true if value is one of the five canonical error classes
 *
 * @example
 * const raw: unknown = someAgentReportedValue;
 * if (!isErrorClass(raw)) {
 *   throw new Error(`Unknown error class: ${String(raw)}. Must be one of: ${ERROR_CLASSES.join(', ')}`);
 * }
 * await supabase.from('audit_log').insert({ error_class: raw, ... });
 */
export function isErrorClass(value: unknown): value is ErrorClass {
  return typeof value === 'string' && (ERROR_CLASSES as readonly string[]).includes(value);
}
