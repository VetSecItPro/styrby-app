/**
 * Application configuration helpers.
 *
 * Centralizes runtime environment lookups that are used in multiple places,
 * ensuring consistent behavior and a single place to update fallbacks.
 */

/**
 * NEXT_PUBLIC_APP_URL — Canonical public origin of the Styrby web app.
 *
 * Source: Vercel Dashboard > Project Settings > Environment Variables
 *   (or set in .env.local for local dev)
 * Format: "https://styrbyapp.com" (no trailing slash)
 * Required in: all (local / preview / production)
 * Behavior when missing: falls back to "https://styrbyapp.com" in production;
 *   emits a console.warn in non-production environments so the gap is visible
 *   during local dev and preview deployments without crashing the server.
 * Rotation: not a secret — update whenever the canonical domain changes.
 */

/**
 * Returns the canonical app URL used for constructing absolute links
 * (share links, invite URLs, email deep-links, etc.).
 *
 * WHY a helper instead of inlining: two separate route files previously used
 * different hardcoded fallbacks ("https://app.styrby.com" vs
 * "https://styrbyapp.com"). Centralising here enforces a single canonical
 * domain and makes future domain changes a one-line fix.
 *
 * WHY warn instead of throw on missing: NEXT_PUBLIC_APP_URL is not a secret —
 * it's safe to fall back to the canonical domain in production. The warning
 * surfaces the gap in local/preview environments without breaking the server.
 *
 * @returns The app origin URL string, no trailing slash.
 */
export function getAppUrl(): string {
  const url = process.env.NEXT_PUBLIC_APP_URL;

  if (!url && process.env.NODE_ENV !== 'production') {
    // WHY warn, not throw: NEXT_PUBLIC_APP_URL is not a secret. A missing value
    // is a configuration gap worth flagging, but the canonical fallback is safe
    // enough that we should not crash a dev or preview server over it.
    console.warn(
      '[config] NEXT_PUBLIC_APP_URL is not set. ' +
        'Falling back to https://styrbyapp.com. ' +
        'Set it in .env.local or Vercel environment variables.'
    );
  }

  return url ?? 'https://styrbyapp.com';
}
