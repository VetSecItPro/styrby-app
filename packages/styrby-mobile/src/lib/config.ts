/**
 * App Configuration
 *
 * Centralizes environment-dependent configuration for the Styrby mobile app.
 * Use this module anywhere you need environment-specific base URLs or settings
 * instead of hardcoding production values.
 *
 * WHY this file exists:
 * Hardcoding `https://styrbyapp.com` breaks staging and local development
 * because API calls always hit production. By reading from `EXPO_PUBLIC_API_URL`,
 * the staging build points to the staging web app and local dev points to
 * localhost, while production builds default to `https://styrbyapp.com`.
 *
 * @module src/lib/config
 */

// ============================================================================
// API Base URL
// ============================================================================

/**
 * The base URL of the Styrby web app that hosts server-side API routes.
 *
 * Reads `EXPO_PUBLIC_API_URL` from the environment. Falls back to the
 * production URL so that release builds work without explicit configuration.
 *
 * Set this in your `.env` file:
 *   - Local dev:  EXPO_PUBLIC_API_URL=http://localhost:3000
 *   - Staging:    EXPO_PUBLIC_API_URL=https://staging.styrbyapp.com
 *   - Production: (leave unset — defaults to https://styrbyapp.com)
 */
const API_BASE_URL: string =
  process.env['EXPO_PUBLIC_API_URL'] ?? 'https://styrbyapp.com';

/**
 * Returns the base URL for web-hosted API routes.
 *
 * Append your route path to this value — do not include a trailing slash.
 *
 * @returns The API base URL string (e.g. `https://styrbyapp.com`)
 *
 * @example
 * const url = `${getApiBaseUrl()}/api/account/delete`;
 * // => 'https://styrbyapp.com/api/account/delete' (production)
 * // => 'http://localhost:3000/api/account/delete'  (local dev)
 */
export function getApiBaseUrl(): string {
  return API_BASE_URL;
}

// ============================================================================
// Static Website URLs
// ============================================================================

/**
 * Static marketing/documentation URLs for the Styrby website.
 *
 * WHY separate from getApiBaseUrl(): These are always production URLs because
 * they point to marketing pages, not API endpoints. Staging builds should still
 * link users to the live help docs and legal pages.
 */
export const SITE_URLS = {
  /** Help and documentation portal */
  help: 'https://styrbyapp.com/help',
  /** Privacy policy page */
  privacy: 'https://styrbyapp.com/privacy',
  /** Terms of service page */
  terms: 'https://styrbyapp.com/terms',
  /** Pricing page */
  pricing: 'https://styrbyapp.com/pricing',
} as const;
