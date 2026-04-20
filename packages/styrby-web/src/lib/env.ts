/**
 * Environment variable accessor with whitespace sanitization.
 *
 * WHY this module exists: On 2026-04-20 a production 500 cascade on
 * `/api/sessions` traced back to Vercel environment variables set with a
 * trailing newline character (a common paste-from-dashboard hazard). The
 * leaked `\n` surfaced in the `Access-Control-Allow-Origin` header as
 * `https://styrbyapp.com%0A`, and — critically — caused `new Redis({ url })`
 * in rate-limiter module-import code to throw on URL parsing, crashing the
 * entire route module before any handler could run. Next.js then served
 * the /500 error page even for GETs on endpoints that have no GET handler.
 *
 * The fix: read every security-sensitive env var through `getEnv()` so
 * trailing / leading whitespace is stripped at the boundary. Defensive
 * programming at the env-read site neutralizes an entire class of bugs
 * without requiring callers to remember the idiom.
 *
 * Governing standards:
 * - OWASP ASVS V14.1 (build and deployment — environment config hygiene)
 * - SOC2 CC7.2 (system operations — configuration error detection)
 *
 * @module lib/env
 */

/**
 * Read and trim an environment variable.
 *
 * Returns `undefined` when the variable is unset or trims to empty string.
 * Trims whitespace including ASCII `\n`, `\r`, `\t`, and surrounding spaces.
 *
 * @param name - Exact env var name (case-sensitive)
 * @returns The trimmed value, or undefined if unset/blank
 *
 * @example
 * const url = getEnv('NEXT_PUBLIC_APP_URL');
 * if (url) {
 *   // Safe to use in HTTP headers, URL parsing, etc.
 * }
 */
export function getEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Read a required env var. Throws at read time if unset or blank.
 *
 * Use this for server-only secrets where a missing value is a
 * misconfiguration that should fail fast.
 *
 * @param name - Exact env var name
 * @returns The trimmed value (never empty)
 * @throws Error if unset or trims to empty
 *
 * @example
 * const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
 */
export function requireEnv(name: string): string {
  const value = getEnv(name);
  if (value === undefined) {
    throw new Error(
      `Required environment variable "${name}" is unset or blank. ` +
        `Check Vercel dashboard / .env.local / GitHub Actions secrets.`,
    );
  }
  return value;
}

/**
 * Read an env var with a default fallback.
 *
 * @param name - Exact env var name
 * @param fallback - Returned if the env var is unset or trims to empty
 */
export function getEnvOr(name: string, fallback: string): string {
  return getEnv(name) ?? fallback;
}
