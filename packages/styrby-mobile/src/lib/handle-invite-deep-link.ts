/**
 * Invite Deep-Link Utilities
 *
 * Provides URL parsing and API-call helpers for the mobile team invitation
 * accept flow. Separated from the main deep-links.ts module because invite
 * handling includes token validation logic and an authenticated fetch wrapper
 * that is not needed for other deep-link routes.
 *
 * WHY a dedicated module:
 * - Token extraction needs regex-validated security (hex-only, min 64 chars)
 * - acceptInvitationFromToken is the only place in mobile that calls the web API
 *   directly with a Bearer token; isolating it simplifies mocking in tests.
 * - Keeps deep-links.ts focused on route-mapping concerns.
 *
 * Security note (OWASP A03:2021 - Injection):
 * extractInviteToken validates token characters to hex only before forwarding
 * to the API. This prevents URL-encoded payloads or path-traversal strings from
 * reaching the backend accept endpoint.
 */

import type { Session } from '@supabase/supabase-js';

// ============================================================================
// Constants
// ============================================================================

/** Domain used for https universal links */
const INVITE_DOMAIN = 'styrbyapp.com' as const;

/** Custom URL scheme registered in app.json */
const INVITE_SCHEME = 'styrby' as const;

/**
 * Minimum token length (characters).
 *
 * WHY 64: The backend generates SHA-256 tokens which produce 64 hex characters.
 * Shorter values are definitively not valid Styrby invite tokens.
 */
const MIN_TOKEN_LENGTH = 64;

/**
 * Regex for validating a hex-only invite token.
 *
 * WHY hex-only: The backend uses crypto.randomBytes().toString('hex') to
 * generate tokens. Any other character indicates a tampered or invalid URL
 * and must be rejected before reaching the API.
 */
const HEX_TOKEN_RE = /^[0-9a-fA-F]+$/;

// ============================================================================
// Types
// ============================================================================

/**
 * Result of calling acceptInvitationFromToken.
 *
 * Uses a discriminated union so callers can exhaustively handle every outcome
 * without silent fallthrough.
 */
export type AcceptResult =
  | {
      /** Invitation accepted successfully */
      status: 'accepted';
      /** The team the user just joined */
      teamId: string;
      /** The role assigned to the user */
      role: string;
    }
  | {
      /** Invitation could not be accepted */
      status: 'error';
      /** Machine-readable error code from the API or 'NETWORK_ERROR' */
      code: string;
      /** Human-readable error message for display */
      message: string;
    };

// ============================================================================
// extractInviteToken
// ============================================================================

/**
 * Extracts and validates an invite token from an invitation URL.
 *
 * Accepts two URL forms:
 * - `https://styrbyapp.com/invite/<token>` — universal link (iOS/Android)
 * - `styrby://invite/<token>`              — custom scheme (dev/manual testing)
 *
 * Token validation rules (matching backend generator output):
 * - Characters: hex only (0-9, a-f, A-F)
 * - Length: >= 64 characters
 *
 * This function NEVER throws. Any malformed input returns null.
 *
 * @param url - The URL to extract the invite token from
 * @returns The raw token string, or null if the URL is not a valid invite link
 *
 * @example
 * extractInviteToken('https://styrbyapp.com/invite/abc123...(64+ hex chars)');
 * // => 'abc123...'
 *
 * @example
 * extractInviteToken('styrby://invite/abc123...(64+ hex chars)');
 * // => 'abc123...'
 *
 * @example
 * extractInviteToken('https://styrbyapp.com/dashboard');
 * // => null
 */
export function extractInviteToken(url: string): string | null {
  // WHY guard: Protect against null/undefined passed from Linking callbacks
  // where the value may be coerced from a native null.
  if (!url || typeof url !== 'string') return null;

  const httpsPrefix = `https://${INVITE_DOMAIN}/invite/`;
  const schemePrefix = `${INVITE_SCHEME}://invite/`;

  let rawToken: string | undefined;

  if (url.startsWith(httpsPrefix)) {
    rawToken = url.slice(httpsPrefix.length);
  } else if (url.startsWith(schemePrefix)) {
    rawToken = url.slice(schemePrefix.length);
  } else {
    return null;
  }

  // Strip trailing slash that some email clients append
  rawToken = rawToken.replace(/\/$/, '');

  // Must have at least MIN_TOKEN_LENGTH characters
  if (rawToken.length < MIN_TOKEN_LENGTH) return null;

  // WHY hex-only check before passing to API: prevents path-traversal or
  // injection payloads from reaching the /api/invitations/accept endpoint.
  if (!HEX_TOKEN_RE.test(rawToken)) return null;

  return rawToken;
}

// ============================================================================
// acceptInvitationFromToken
// ============================================================================

/**
 * Calls POST /api/invitations/accept on the Styrby web API to accept an
 * invitation using the provided token and Supabase session.
 *
 * This function NEVER throws. All errors are returned as AcceptResult objects
 * with status 'error' so callers can render the appropriate UI state without
 * try/catch at the call site.
 *
 * WHY call the web API (not Supabase directly):
 * The accept endpoint enforces seat-cap advisory locking, role mapping, and
 * audit logging that are implemented as server-side logic in Unit A. Calling
 * the API keeps business logic in one place (web server) rather than
 * duplicating it in mobile.
 *
 * @param token - The raw invite token extracted from the deep-link URL
 * @param session - The current user's Supabase session (provides access_token)
 * @returns A promise resolving to AcceptResult — never rejects
 *
 * @example
 * const result = await acceptInvitationFromToken(token, session);
 * if (result.status === 'accepted') {
 *   router.replace(`/team/${result.teamId}`);
 * } else {
 *   // handle result.code (EMAIL_MISMATCH, EXPIRED, etc.)
 * }
 */
export async function acceptInvitationFromToken(
  token: string,
  session: Session,
): Promise<AcceptResult> {
  /**
   * EXPO_PUBLIC_APP_URL — Base URL for the Styrby web app.
   *
   * Source: .env.local / EAS environment / Vercel
   * Format: "https://styrbyapp.com" (no trailing slash)
   * Required: all environments
   * Behavior when missing: falls back to production URL so the app degrades
   *   gracefully, but env-vars doc and .env.example must document it.
   * See: docs/infrastructure/environment-variables.md
   *
   * WHY read inside the function (not at module scope):
   * Jest sets process.env before individual tests run. If we read the value
   * at module-load time it captures the value from when the module was first
   * imported (before per-test env overrides take effect). Reading it lazily
   * here ensures each test gets the env value it set.
   */
  // eslint-disable-next-line prefer-destructuring
  const appUrl = process.env['EXPO_PUBLIC_APP_URL'] ?? 'https://styrbyapp.com';
  const endpoint = `${appUrl}/api/invitations/accept`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // WHY Bearer header: The web API uses the Supabase JWT to authenticate
        // the request and verify the requesting user matches the invited email.
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ token }),
    });

    // Parse the JSON body for both success and error cases
    const body = await response.json() as Record<string, unknown>;

    if (response.ok) {
      return {
        status: 'accepted',
        teamId: body.team_id as string,
        role: body.role as string,
      };
    }

    // Non-2xx: return a structured error using the API's error code
    return {
      status: 'error',
      code: (body.error as string) ?? `HTTP_${response.status}`,
      message: (body.message as string) ?? 'An unexpected error occurred.',
    };
  } catch (err) {
    // WHY catch-all: Network failures (fetch rejects) or JSON parse errors
    // must not propagate as unhandled rejections. We surface them as a
    // NETWORK_ERROR result so the UI can show a retry button.
    const message = err instanceof Error ? err.message : 'Network request failed.';
    return {
      status: 'error',
      code: 'NETWORK_ERROR',
      message,
    };
  }
}
