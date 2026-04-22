/**
 * Session Retention Utilities
 *
 * Pure TypeScript helpers for computing effective session retention windows.
 * Mirrors the PL/pgSQL `resolve_session_retention_days()` function from
 * migration 025 so client-side code (web/mobile) can display "this session
 * will be deleted on <DATE>" without a round-trip to the DB.
 *
 * WHY keep this in @styrby/shared:
 *   The resolution logic is needed in three places:
 *     1. The nightly Postgres cron (PL/pgSQL in migration 025)
 *     2. The per-session retention API endpoint (server-side)
 *     3. The web/mobile UI "expires on" display (client-side)
 *   Sharing the TypeScript version prevents the JS and SQL logic from drifting.
 *
 * Audit: GDPR Art. 5(1)(e) — storage limitation; SOC2 CC7.2
 *
 * @module privacy/retention
 */

/** Allowed global retention windows (days). Null = never. */
export const ALLOWED_RETENTION_DAYS = [7, 30, 90, 365] as const;

/** Type-safe union of allowed retention values. */
export type RetentionDays = (typeof ALLOWED_RETENTION_DAYS)[number] | null;

/**
 * Per-session retention override values.
 *
 * - `'inherit'`      — use the profile-level retention_days (default)
 * - `'pin_forever'`  — never auto-delete this session
 * - `'pin_days:7'`   — delete this session after exactly 7 days
 * - `'pin_days:30'`  — delete this session after exactly 30 days
 * - `'pin_days:90'`  — delete this session after exactly 90 days
 * - `'pin_days:365'` — delete this session after exactly 365 days
 */
export type SessionRetentionOverride =
  | 'inherit'
  | 'pin_forever'
  | 'pin_days:7'
  | 'pin_days:30'
  | 'pin_days:90'
  | 'pin_days:365';

/** Regex that validates a retention_override value. */
export const RETENTION_OVERRIDE_PATTERN =
  /^(inherit|pin_forever|pin_days:(7|30|90|365))$/;

/**
 * Resolve the effective retention window (in days) for a session.
 *
 * Mirrors the PL/pgSQL `resolve_session_retention_days()` function from
 * migration 025. Any change to this logic MUST also be applied to the
 * Postgres function to prevent drift between client display and cron behaviour.
 *
 * @param sessionRetentionOverride - The session's `retention_override` column value
 * @param profileRetentionDays - The user's global `retention_days` profile setting
 * @returns Number of days until deletion, or `null` if the session is pinned forever
 *
 * @example
 * resolveSessionRetentionDays('inherit', 30)  // => 30
 * resolveSessionRetentionDays('pin_forever', 30) // => null
 * resolveSessionRetentionDays('pin_days:7', 90) // => 7
 * resolveSessionRetentionDays('inherit', null)  // => null (profile: never)
 */
export function resolveSessionRetentionDays(
  sessionRetentionOverride: SessionRetentionOverride | null | undefined,
  profileRetentionDays: RetentionDays,
): number | null {
  // pin_forever always wins — session is never auto-deleted
  if (sessionRetentionOverride === 'pin_forever') {
    return null;
  }

  // pin_days:N — use the session-level override regardless of profile
  if (sessionRetentionOverride?.startsWith('pin_days:')) {
    const days = parseInt(sessionRetentionOverride.slice(9), 10);
    if (!isNaN(days)) return days;
  }

  // 'inherit' or anything else — fall back to profile-level retention
  return profileRetentionDays;
}

/**
 * Compute the expiry date for a session given the resolved retention window.
 *
 * @param sessionStartedAt - ISO 8601 timestamp when the session started
 * @param retentionDays - Effective retention window from {@link resolveSessionRetentionDays}
 * @returns The expiry `Date`, or `null` if the session never expires
 *
 * @example
 * computeSessionExpiryDate('2026-01-01T00:00:00Z', 30)
 * // => Date('2026-01-31T00:00:00Z')
 *
 * computeSessionExpiryDate('2026-01-01T00:00:00Z', null)
 * // => null
 */
export function computeSessionExpiryDate(
  sessionStartedAt: string,
  retentionDays: number | null,
): Date | null {
  if (retentionDays === null) return null;

  const started = new Date(sessionStartedAt);
  if (isNaN(started.getTime())) {
    throw new Error(`Invalid session started_at: ${sessionStartedAt}`);
  }

  const expiry = new Date(started);
  expiry.setDate(expiry.getDate() + retentionDays);
  return expiry;
}

/**
 * Human-readable label for a retention_days value.
 *
 * Used by the UI to display the current retention setting in a consistent
 * format without duplicating the label map across web and mobile.
 *
 * @param retentionDays - Current retention value (null = never)
 * @returns Human-readable label
 *
 * @example
 * retentionDaysLabel(30)   // => '30 days'
 * retentionDaysLabel(365)  // => '1 year'
 * retentionDaysLabel(null) // => 'Never'
 */
export function retentionDaysLabel(retentionDays: RetentionDays): string {
  if (retentionDays === null) return 'Never';
  if (retentionDays === 365) return '1 year';
  return `${retentionDays} days`;
}
