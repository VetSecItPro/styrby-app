/**
 * Deep Link Configuration & Utilities
 *
 * Central reference for all deep link routes supported by the Styrby mobile app.
 * Provides utilities for building and parsing deep link URLs.
 *
 * WHY this file exists:
 * Deep links are referenced in multiple places (Supabase auth config, push
 * notification payloads, email templates, marketing materials). Having a
 * single source of truth for route mappings prevents drift between what the
 * backend sends and what the app expects. The `buildDeepLink` and
 * `parseDeepLink` functions are used by the CLI and backend to generate
 * links that the app can reliably handle.
 *
 * Expo-router uses file-system-based routing, so most of these mappings
 * are implicit (the URL path maps directly to a file). This file makes
 * the mappings explicit for documentation, testing, and programmatic use.
 */

// ============================================================================
// Constants
// ============================================================================

/** The custom URL scheme registered in app.json */
export const APP_SCHEME = 'styrby' as const;

/** The domain used for universal links (iOS) and app links (Android) */
export const UNIVERSAL_LINK_DOMAIN = 'styrbyapp.com' as const;

// ============================================================================
// Route Mapping
// ============================================================================

/**
 * Maps custom-scheme deep link URLs to their corresponding expo-router paths.
 *
 * With expo-router, the file system defines routes automatically:
 * - `app/(auth)/callback.tsx` -> `/(auth)/callback`
 * - `app/(tabs)/index.tsx`    -> `/(tabs)/`
 * - `app/(tabs)/chat.tsx`     -> `/(tabs)/chat`
 *
 * This map makes those relationships explicit for reference and validation.
 */
export const DEEP_LINK_ROUTES = {
  'styrby://auth/callback': '/(auth)/callback',
  'styrby://dashboard': '/(tabs)/',
  'styrby://chat': '/(tabs)/chat',
  'styrby://sessions': '/(tabs)/sessions',
  'styrby://costs': '/(tabs)/costs',
  'styrby://settings': '/(tabs)/settings',
  'styrby://scan': '/(auth)/scan',
} as const;

/** All known deep link URL strings */
export type DeepLinkUrl = keyof typeof DEEP_LINK_ROUTES;

/** All known expo-router path strings */
export type RouterPath = (typeof DEEP_LINK_ROUTES)[DeepLinkUrl];

/**
 * Screens that accept a `sessionId` query parameter.
 * Used by `buildDeepLink` to validate parameter usage.
 */
const SCREENS_WITH_SESSION_ID = new Set<string>(['chat']);

// ============================================================================
// Builder
// ============================================================================

/**
 * Builds a `styrby://` deep link URL for a given screen and optional parameters.
 *
 * Use this on the backend/CLI when constructing URLs for push notifications,
 * email templates, or QR codes that should open a specific screen in the app.
 *
 * @param screen - The screen identifier (e.g. 'chat', 'dashboard', 'settings')
 * @param params - Optional key-value pairs to append as query parameters
 * @returns A fully-formed `styrby://` deep link URL
 *
 * @example
 * // Simple screen link
 * buildDeepLink('dashboard');
 * // => 'styrby://dashboard'
 *
 * @example
 * // Chat with a specific session
 * buildDeepLink('chat', { sessionId: 'abc-123' });
 * // => 'styrby://chat?sessionId=abc-123'
 *
 * @example
 * // Auth callback with code
 * buildDeepLink('auth/callback', { code: 'xyz', type: 'magiclink' });
 * // => 'styrby://auth/callback?code=xyz&type=magiclink'
 */
export function buildDeepLink(
  screen: string,
  params?: Record<string, string>
): string {
  let url = `${APP_SCHEME}://${screen}`;

  if (params && Object.keys(params).length > 0) {
    const searchParams = new URLSearchParams();

    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        searchParams.set(key, value);
      }
    }

    const queryString = searchParams.toString();
    if (queryString) {
      url += `?${queryString}`;
    }
  }

  return url;
}

// ============================================================================
// Parser
// ============================================================================

/** Result of parsing a deep link URL */
interface ParsedDeepLink {
  /** The screen path segment (e.g. 'chat', 'auth/callback', 'dashboard') */
  screen: string;
  /** Query parameters extracted from the URL */
  params: Record<string, string>;
}

/**
 * Parses a `styrby://` deep link URL into its screen and parameters.
 *
 * Returns null if the URL does not use the `styrby://` scheme or is malformed.
 * This is useful for logging, analytics, and testing deep link handling.
 *
 * @param url - The full deep link URL to parse
 * @returns The parsed screen and params, or null if the URL is invalid
 *
 * @example
 * parseDeepLink('styrby://chat?sessionId=abc-123');
 * // => { screen: 'chat', params: { sessionId: 'abc-123' } }
 *
 * @example
 * parseDeepLink('styrby://auth/callback?code=xyz&type=magiclink');
 * // => { screen: 'auth/callback', params: { code: 'xyz', type: 'magiclink' } }
 *
 * @example
 * parseDeepLink('https://other-site.com/page');
 * // => null
 */
export function parseDeepLink(url: string): ParsedDeepLink | null {
  // WHY: We check for both the custom scheme and the universal link domain.
  // The app can receive links via either mechanism depending on platform
  // and context (e.g. `styrby://chat` from a push notification vs
  // `https://styrbyapp.com/chat` from a browser).
  const customSchemePrefix = `${APP_SCHEME}://`;
  const universalLinkPrefix = `https://${UNIVERSAL_LINK_DOMAIN}/`;

  let pathAndQuery: string;

  if (url.startsWith(customSchemePrefix)) {
    pathAndQuery = url.slice(customSchemePrefix.length);
  } else if (url.startsWith(universalLinkPrefix)) {
    pathAndQuery = url.slice(universalLinkPrefix.length);
  } else {
    return null;
  }

  // Split path from query string
  const questionMarkIndex = pathAndQuery.indexOf('?');
  const path = questionMarkIndex >= 0
    ? pathAndQuery.slice(0, questionMarkIndex)
    : pathAndQuery;
  const queryString = questionMarkIndex >= 0
    ? pathAndQuery.slice(questionMarkIndex + 1)
    : '';

  // Parse query parameters
  const params: Record<string, string> = {};
  if (queryString) {
    const searchParams = new URLSearchParams(queryString);
    searchParams.forEach((value, key) => {
      params[key] = value;
    });
  }

  // Remove trailing slash for consistency
  const screen = path.replace(/\/$/, '') || 'dashboard';

  return { screen, params };
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Checks whether a screen name is a known deep link target.
 *
 * Useful for validating notification payloads before attempting navigation.
 *
 * @param screen - The screen name to validate
 * @returns true if the screen is a known deep link target
 *
 * @example
 * isKnownScreen('chat');      // => true
 * isKnownScreen('unknown');   // => false
 */
export function isKnownScreen(screen: string): boolean {
  const knownScreens = new Set(
    Object.keys(DEEP_LINK_ROUTES).map((url) =>
      url.replace(`${APP_SCHEME}://`, '')
    )
  );
  return knownScreens.has(screen);
}

/**
 * Checks whether a given screen accepts a `sessionId` parameter.
 *
 * @param screen - The screen name to check
 * @returns true if the screen supports the sessionId parameter
 *
 * @example
 * screenAcceptsSessionId('chat');      // => true
 * screenAcceptsSessionId('settings');  // => false
 */
export function screenAcceptsSessionId(screen: string): boolean {
  return SCREENS_WITH_SESSION_ID.has(screen);
}
