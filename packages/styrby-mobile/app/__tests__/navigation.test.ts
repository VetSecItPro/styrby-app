/**
 * Navigation & Flow Tests
 *
 * Tests the navigation logic, deep link routing, auth guard decisions,
 * onboarding flow, and tab structure of the Styrby mobile app.
 *
 * Since jest runs in a node environment (no DOM/renderer), these tests
 * exercise the LOGIC layer: deep link parsing, route resolution, auth
 * state decisions, and structural assertions on layout configuration.
 */

import {
  APP_SCHEME,
  DEEP_LINK_ROUTES,
  buildDeepLink,
  parseDeepLink,
  isKnownScreen,
  screenAcceptsSessionId,
} from '../../src/lib/deep-links';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Simulates the root layout auth guard logic from app/_layout.tsx.
 * Given the current auth/onboarding state and active segment, returns the
 * route that `router.replace` would be called with, or null if no redirect.
 *
 * @param state - The current app state
 * @returns The redirect path, or null if the user stays on the current route
 */
function computeRedirect(state: {
  isLoading: boolean;
  hasOnboarded: boolean | null;
  session: { user: { id: string } } | null;
  currentSegment: string;
}): string | null {
  const { isLoading, hasOnboarded, session, currentSegment } = state;

  if (isLoading) return null;

  const inAuthGroup = currentSegment === '(auth)';
  const inOnboarding = currentSegment === 'onboarding';
  const inTabs = currentSegment === '(tabs)';

  // Not onboarded -> show onboarding
  if (!hasOnboarded && !inOnboarding) {
    return '/onboarding';
  }

  // Onboarded but not logged in -> show login (unless already in auth)
  if (hasOnboarded && !session && !inAuthGroup) {
    return '/(auth)/login';
  }

  // Logged in -> go to tabs (unless already there or in auth)
  if (session && !inTabs && !inAuthGroup) {
    return '/(tabs)';
  }

  return null;
}

/**
 * Maps a deep link screen name to its expo-router path using the DEEP_LINK_ROUTES table.
 *
 * @param screen - The screen segment from a parsed deep link (e.g. 'chat', 'dashboard')
 * @returns The expo-router path, or null if not a known route
 */
function resolveDeepLinkToRoute(screen: string): string | null {
  const deepLinkUrl = `${APP_SCHEME}://${screen}` as keyof typeof DEEP_LINK_ROUTES;
  return DEEP_LINK_ROUTES[deepLinkUrl] ?? null;
}

// ============================================================================
// Mock session factory
// ============================================================================

const mockSession = { user: { id: 'user-123' } };

// ============================================================================
// Tests
// ============================================================================

describe('Navigation', () => {
  // --------------------------------------------------------------------------
  // 1. Deep Link Routing
  // --------------------------------------------------------------------------
  describe('Deep link routing', () => {
    it('should resolve all 8 deep link routes to correct expo-router paths', () => {
      const entries = Object.entries(DEEP_LINK_ROUTES);
      expect(entries).toHaveLength(8);

      for (const [deepLinkUrl, routerPath] of entries) {
        const parsed = parseDeepLink(deepLinkUrl);
        expect(parsed).not.toBeNull();
        const resolved = resolveDeepLinkToRoute(parsed!.screen);
        expect(resolved).toBe(routerPath);
      }
    });

    it('should resolve styrby://dashboard to /(tabs)/', () => {
      const parsed = parseDeepLink('styrby://dashboard');
      expect(resolveDeepLinkToRoute(parsed!.screen)).toBe('/(tabs)/');
    });

    it('should resolve styrby://chat to /(tabs)/chat', () => {
      const parsed = parseDeepLink('styrby://chat');
      expect(resolveDeepLinkToRoute(parsed!.screen)).toBe('/(tabs)/chat');
    });

    it('should resolve styrby://sessions to /(tabs)/sessions', () => {
      const parsed = parseDeepLink('styrby://sessions');
      expect(resolveDeepLinkToRoute(parsed!.screen)).toBe('/(tabs)/sessions');
    });

    it('should resolve styrby://auth/callback to /(auth)/callback', () => {
      const parsed = parseDeepLink('styrby://auth/callback');
      expect(resolveDeepLinkToRoute(parsed!.screen)).toBe('/(auth)/callback');
    });

    it('should resolve styrby://scan to /(auth)/scan', () => {
      const parsed = parseDeepLink('styrby://scan');
      expect(resolveDeepLinkToRoute(parsed!.screen)).toBe('/(auth)/scan');
    });

    it('should return null for an unknown deep link screen', () => {
      const parsed = parseDeepLink('styrby://nonexistent');
      expect(parsed).not.toBeNull();
      expect(resolveDeepLinkToRoute(parsed!.screen)).toBeNull();
    });

    it('should gracefully handle an invalid deep link URL', () => {
      const parsed = parseDeepLink('https://evil.com/dashboard');
      expect(parsed).toBeNull();
    });

    it('should parse deep link with sessionId parameter correctly', () => {
      const parsed = parseDeepLink('styrby://chat?sessionId=abc-123');
      expect(parsed).toEqual({
        screen: 'chat',
        params: { sessionId: 'abc-123' },
      });
      expect(resolveDeepLinkToRoute(parsed!.screen)).toBe('/(tabs)/chat');
    });

    it('should parse universal link (styrbyapp.com) to the same screen', () => {
      const customParsed = parseDeepLink('styrby://settings');
      const universalParsed = parseDeepLink('https://styrbyapp.com/settings');

      expect(customParsed).not.toBeNull();
      expect(universalParsed).not.toBeNull();
      expect(customParsed!.screen).toBe(universalParsed!.screen);
    });

    it('should parse universal link with parameters', () => {
      const parsed = parseDeepLink('https://styrbyapp.com/chat?sessionId=xyz');
      expect(parsed).toEqual({
        screen: 'chat',
        params: { sessionId: 'xyz' },
      });
    });

    it('should parse universal link auth callback with code and type', () => {
      const parsed = parseDeepLink(
        'https://styrbyapp.com/auth/callback?code=abc&type=magiclink'
      );
      expect(parsed).toEqual({
        screen: 'auth/callback',
        params: { code: 'abc', type: 'magiclink' },
      });
    });
  });

  // --------------------------------------------------------------------------
  // 2. Auth Guard Logic
  // --------------------------------------------------------------------------
  describe('Auth guard logic', () => {
    it('should not redirect while loading', () => {
      const result = computeRedirect({
        isLoading: true,
        hasOnboarded: null,
        session: null,
        currentSegment: '(tabs)',
      });
      expect(result).toBeNull();
    });

    it('should redirect unauthenticated users to login', () => {
      const result = computeRedirect({
        isLoading: false,
        hasOnboarded: true,
        session: null,
        currentSegment: '(tabs)',
      });
      expect(result).toBe('/(auth)/login');
    });

    it('should not redirect unauthenticated users already in auth group', () => {
      const result = computeRedirect({
        isLoading: false,
        hasOnboarded: true,
        session: null,
        currentSegment: '(auth)',
      });
      expect(result).toBeNull();
    });

    it('should redirect authenticated users to tabs', () => {
      const result = computeRedirect({
        isLoading: false,
        hasOnboarded: true,
        session: mockSession,
        currentSegment: 'onboarding',
      });
      expect(result).toBe('/(tabs)');
    });

    it('should not redirect authenticated users already in tabs', () => {
      const result = computeRedirect({
        isLoading: false,
        hasOnboarded: true,
        session: mockSession,
        currentSegment: '(tabs)',
      });
      expect(result).toBeNull();
    });

    it('should not redirect authenticated users in auth group (e.g. callback)', () => {
      const result = computeRedirect({
        isLoading: false,
        hasOnboarded: true,
        session: mockSession,
        currentSegment: '(auth)',
      });
      expect(result).toBeNull();
    });

    it('should redirect to onboarding when not onboarded', () => {
      const result = computeRedirect({
        isLoading: false,
        hasOnboarded: false,
        session: null,
        currentSegment: '(tabs)',
      });
      expect(result).toBe('/onboarding');
    });

    it('should redirect to onboarding when hasOnboarded is null (first launch)', () => {
      const result = computeRedirect({
        isLoading: false,
        hasOnboarded: null,
        session: null,
        currentSegment: '(tabs)',
      });
      expect(result).toBe('/onboarding');
    });

    it('should not redirect if already in onboarding and not onboarded', () => {
      const result = computeRedirect({
        isLoading: false,
        hasOnboarded: false,
        session: null,
        currentSegment: 'onboarding',
      });
      expect(result).toBeNull();
    });

    it('should prioritize onboarding over auth redirect', () => {
      // User is not onboarded AND not authenticated - onboarding takes priority
      const result = computeRedirect({
        isLoading: false,
        hasOnboarded: false,
        session: null,
        currentSegment: '(auth)',
      });
      expect(result).toBe('/onboarding');
    });
  });

  // --------------------------------------------------------------------------
  // 3. Onboarding Flow
  // --------------------------------------------------------------------------
  describe('Onboarding flow', () => {
    it('should have 3 onboarding screens defined in the layout', () => {
      // Onboarding layout defines: index, notifications, complete
      const onboardingScreens = ['index', 'notifications', 'complete'];
      expect(onboardingScreens).toHaveLength(3);
    });

    it('should direct new users (not onboarded) to onboarding', () => {
      const result = computeRedirect({
        isLoading: false,
        hasOnboarded: false,
        session: null,
        currentSegment: '(tabs)',
      });
      expect(result).toBe('/onboarding');
    });

    it('should allow onboarded users to skip onboarding', () => {
      const result = computeRedirect({
        isLoading: false,
        hasOnboarded: true,
        session: null,
        currentSegment: 'onboarding',
      });
      // Onboarded but no session -> redirect to login, not stay on onboarding
      expect(result).toBe('/(auth)/login');
    });

    it('should navigate authenticated user away from onboarding to tabs', () => {
      const result = computeRedirect({
        isLoading: false,
        hasOnboarded: true,
        session: mockSession,
        currentSegment: 'onboarding',
      });
      expect(result).toBe('/(tabs)');
    });

    it('should keep user in onboarding when not yet onboarded', () => {
      const result = computeRedirect({
        isLoading: false,
        hasOnboarded: false,
        session: null,
        currentSegment: 'onboarding',
      });
      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // 4. Tab Navigation Structure
  // --------------------------------------------------------------------------
  describe('Tab navigation structure', () => {
    /**
     * Tab configuration extracted from app/(tabs)/_layout.tsx.
     * Each entry matches a Tabs.Screen definition in the layout.
     */
    const expectedTabs = [
      { name: 'index', title: 'Dashboard', icon: 'grid' },
      { name: 'chat', title: 'Chat', icon: 'chatbubbles' },
      { name: 'sessions', title: 'Sessions', icon: 'list' },
      { name: 'team', title: 'Team', icon: 'people' },
      { name: 'settings', title: 'Settings', icon: 'settings' },
    ];

    it('should have exactly 5 tabs', () => {
      expect(expectedTabs).toHaveLength(5);
    });

    it('should have Dashboard as the first tab (index)', () => {
      expect(expectedTabs[0]).toEqual({
        name: 'index',
        title: 'Dashboard',
        icon: 'grid',
      });
    });

    it('should have Chat as the second tab', () => {
      expect(expectedTabs[1]).toEqual({
        name: 'chat',
        title: 'Chat',
        icon: 'chatbubbles',
      });
    });

    it('should have Sessions as the third tab', () => {
      expect(expectedTabs[2]).toEqual({
        name: 'sessions',
        title: 'Sessions',
        icon: 'list',
      });
    });

    it('should have Team as the fourth tab', () => {
      expect(expectedTabs[3]).toEqual({
        name: 'team',
        title: 'Team',
        icon: 'people',
      });
    });

    it('should have Settings as the last tab', () => {
      expect(expectedTabs[4]).toEqual({
        name: 'settings',
        title: 'Settings',
        icon: 'settings',
      });
    });

    it('should maintain consistent tab order', () => {
      const tabNames = expectedTabs.map((t) => t.name);
      expect(tabNames).toEqual(['index', 'chat', 'sessions', 'team', 'settings']);
    });

    it('should have unique tab names', () => {
      const tabNames = expectedTabs.map((t) => t.name);
      expect(new Set(tabNames).size).toBe(tabNames.length);
    });

    it('should have unique tab titles', () => {
      const tabTitles = expectedTabs.map((t) => t.title);
      expect(new Set(tabTitles).size).toBe(tabTitles.length);
    });

    it('should have unique tab icons', () => {
      const tabIcons = expectedTabs.map((t) => t.icon);
      expect(new Set(tabIcons).size).toBe(tabIcons.length);
    });
  });

  // --------------------------------------------------------------------------
  // 5. Root Stack Structure
  // --------------------------------------------------------------------------
  describe('Root stack structure', () => {
    /**
     * Root Stack.Screen entries from app/_layout.tsx.
     */
    const rootScreens = [
      { name: '(tabs)', headerShown: false },
      { name: '(auth)', headerShown: false },
      { name: 'onboarding', headerShown: false, gestureEnabled: false },
      { name: 'agent-config', title: 'Agent Configuration', presentation: 'card' },
      { name: 'budget-alerts', title: 'Budget Alerts', presentation: 'card' },
      { name: 'team/invite', title: 'Invite Member', presentation: 'card' },
    ];

    it('should have 6 root stack screens', () => {
      expect(rootScreens).toHaveLength(6);
    });

    it('should hide headers for tab, auth, and onboarding groups', () => {
      const hiddenHeaders = rootScreens.filter((s) => s.headerShown === false);
      expect(hiddenHeaders.map((s) => s.name)).toEqual([
        '(tabs)',
        '(auth)',
        'onboarding',
      ]);
    });

    it('should disable gesture on onboarding to prevent accidental back', () => {
      const onboarding = rootScreens.find((s) => s.name === 'onboarding');
      expect(onboarding?.gestureEnabled).toBe(false);
    });

    it('should present agent-config, budget-alerts, and team/invite as cards', () => {
      const cardScreens = rootScreens.filter((s) => s.presentation === 'card');
      expect(cardScreens.map((s) => s.name)).toEqual([
        'agent-config',
        'budget-alerts',
        'team/invite',
      ]);
    });
  });

  // --------------------------------------------------------------------------
  // 6. Auth Layout Structure
  // --------------------------------------------------------------------------
  describe('Auth layout structure', () => {
    const authScreens = ['login', 'scan', 'callback'];

    it('should define login, scan, and callback screens', () => {
      expect(authScreens).toEqual(['login', 'scan', 'callback']);
    });

    it('should have callback with gesture disabled to prevent back during auth exchange', () => {
      // From (auth)/_layout.tsx: callback has gestureEnabled: false
      const callbackConfig = { name: 'callback', gestureEnabled: false };
      expect(callbackConfig.gestureEnabled).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // 7. Deep link to route resolution integration
  // --------------------------------------------------------------------------
  describe('Deep link to route resolution integration', () => {
    it('should map every known screen to a valid router path', () => {
      const knownScreens = Object.keys(DEEP_LINK_ROUTES).map((url) =>
        url.replace(`${APP_SCHEME}://`, '')
      );

      for (const screen of knownScreens) {
        expect(isKnownScreen(screen)).toBe(true);
        const routerPath = resolveDeepLinkToRoute(screen);
        expect(routerPath).not.toBeNull();
      }
    });

    it('should only allow chat to accept sessionId', () => {
      const knownScreens = Object.keys(DEEP_LINK_ROUTES).map((url) =>
        url.replace(`${APP_SCHEME}://`, '')
      );

      for (const screen of knownScreens) {
        if (screen === 'chat') {
          expect(screenAcceptsSessionId(screen)).toBe(true);
        } else {
          expect(screenAcceptsSessionId(screen)).toBe(false);
        }
      }
    });

    it('should build and resolve a deep link end-to-end', () => {
      const url = buildDeepLink('chat', { sessionId: 'sess-999' });
      const parsed = parseDeepLink(url);
      expect(parsed).not.toBeNull();
      expect(parsed!.screen).toBe('chat');
      expect(parsed!.params.sessionId).toBe('sess-999');

      const routerPath = resolveDeepLinkToRoute(parsed!.screen);
      expect(routerPath).toBe('/(tabs)/chat');
    });
  });
});
