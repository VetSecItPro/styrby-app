/**
 * Tests for the deep-links module.
 *
 * Covers all exports:
 * - Constants (APP_SCHEME, UNIVERSAL_LINK_DOMAIN, DEEP_LINK_ROUTES)
 * - buildDeepLink() - constructing deep link URLs with optional params
 * - parseDeepLink() - parsing custom scheme and universal links
 * - isKnownScreen() - validating known screens
 * - screenAcceptsSessionId() - checking which screens accept session ID params
 */

import {
  APP_SCHEME,
  UNIVERSAL_LINK_DOMAIN,
  DEEP_LINK_ROUTES,
  buildDeepLink,
  parseDeepLink,
  isKnownScreen,
  screenAcceptsSessionId,
  type DeepLinkUrl,
  type RouterPath,
} from '../deep-links';

describe('deep-links', () => {
  describe('constants', () => {
    it('should have correct APP_SCHEME', () => {
      expect(APP_SCHEME).toBe('styrby');
    });

    it('should have correct UNIVERSAL_LINK_DOMAIN', () => {
      expect(UNIVERSAL_LINK_DOMAIN).toBe('styrbyapp.com');
    });

    it('should have all 7 DEEP_LINK_ROUTES', () => {
      expect(Object.keys(DEEP_LINK_ROUTES).length).toBe(7);
    });

    it('should have correct DEEP_LINK_ROUTES mapping', () => {
      expect(DEEP_LINK_ROUTES).toEqual({
        'styrby://auth/callback': '/(auth)/callback',
        'styrby://dashboard': '/(tabs)/',
        'styrby://chat': '/(tabs)/chat',
        'styrby://sessions': '/(tabs)/sessions',
        'styrby://costs': '/(tabs)/costs',
        'styrby://settings': '/(tabs)/settings',
        'styrby://scan': '/(auth)/scan',
      });
    });
  });

  describe('buildDeepLink', () => {
    it('should build simple deep link without params', () => {
      const url = buildDeepLink('dashboard');
      expect(url).toBe('styrby://dashboard');
    });

    it('should build deep link with single param', () => {
      const url = buildDeepLink('chat', { sessionId: '123' });
      expect(url).toBe('styrby://chat?sessionId=123');
    });

    it('should build deep link with multiple params', () => {
      const url = buildDeepLink('sessions', { filter: 'active', sort: 'date' });
      // URLSearchParams may order differently, so check both possibilities
      expect(url).toMatch(/^styrby:\/\/sessions\?/);
      expect(url).toContain('filter=active');
      expect(url).toContain('sort=date');
    });

    it('should handle empty params object', () => {
      const url = buildDeepLink('costs', {});
      expect(url).toBe('styrby://costs');
    });

    it('should filter out undefined values', () => {
      // WHY cast: Testing runtime behavior when params object has undefined values
      // (can occur from optional chaining, e.g., { tab: config?.defaultTab })
      const url = buildDeepLink('settings', { section: 'profile', invalid: undefined as unknown as string });
      expect(url).toBe('styrby://settings?section=profile');
      expect(url).not.toContain('invalid');
    });

    it('should filter out null values', () => {
      const url = buildDeepLink('settings', { section: 'profile', invalid: null as any });
      expect(url).toBe('styrby://settings?section=profile');
      expect(url).not.toContain('invalid');
    });

    it('should filter out empty string values', () => {
      const url = buildDeepLink('settings', { section: 'profile', invalid: '' });
      expect(url).toBe('styrby://settings?section=profile');
      expect(url).not.toContain('invalid');
    });

    it('should encode special characters in params', () => {
      const url = buildDeepLink('search', { query: 'hello world' });
      expect(url).toBe('styrby://search?query=hello+world');
    });

    it('should handle nested paths', () => {
      const url = buildDeepLink('auth/callback');
      expect(url).toBe('styrby://auth/callback');
    });

    it('should handle nested paths with params', () => {
      const url = buildDeepLink('auth/callback', { code: 'abc123', state: 'xyz' });
      expect(url).toMatch(/^styrby:\/\/auth\/callback\?/);
      expect(url).toContain('code=abc123');
      expect(url).toContain('state=xyz');
    });
  });

  describe('parseDeepLink', () => {
    describe('custom scheme (styrby://)', () => {
      it('should parse simple custom scheme URL', () => {
        const result = parseDeepLink('styrby://dashboard');
        expect(result).toEqual({
          screen: 'dashboard',
          params: {},
        });
      });

      it('should parse custom scheme URL with query params', () => {
        const result = parseDeepLink('styrby://chat?sessionId=123');
        expect(result).toEqual({
          screen: 'chat',
          params: { sessionId: '123' },
        });
      });

      it('should parse custom scheme URL with multiple query params', () => {
        const result = parseDeepLink('styrby://sessions?filter=active&sort=date');
        expect(result).toEqual({
          screen: 'sessions',
          params: { filter: 'active', sort: 'date' },
        });
      });

      it('should parse custom scheme URL with nested path', () => {
        const result = parseDeepLink('styrby://auth/callback?code=abc123');
        expect(result).toEqual({
          screen: 'auth/callback',
          params: { code: 'abc123' },
        });
      });

      it('should handle trailing slash', () => {
        const result = parseDeepLink('styrby://dashboard/');
        expect(result).toEqual({
          screen: 'dashboard',
          params: {},
        });
      });

      it('should default empty path to dashboard', () => {
        const result = parseDeepLink('styrby://');
        expect(result).toEqual({
          screen: 'dashboard',
          params: {},
        });
      });

      it('should default empty path with trailing slash to dashboard', () => {
        const result = parseDeepLink('styrby:///');
        expect(result).toEqual({
          screen: 'dashboard',
          params: {},
        });
      });
    });

    describe('universal links (https://styrbyapp.com/)', () => {
      it('should parse simple universal link', () => {
        const result = parseDeepLink('https://styrbyapp.com/dashboard');
        expect(result).toEqual({
          screen: 'dashboard',
          params: {},
        });
      });

      it('should parse universal link with query params', () => {
        const result = parseDeepLink('https://styrbyapp.com/chat?sessionId=123');
        expect(result).toEqual({
          screen: 'chat',
          params: { sessionId: '123' },
        });
      });

      it('should parse universal link with multiple query params', () => {
        const result = parseDeepLink('https://styrbyapp.com/sessions?filter=active&sort=date');
        expect(result).toEqual({
          screen: 'sessions',
          params: { filter: 'active', sort: 'date' },
        });
      });

      it('should parse universal link with nested path', () => {
        const result = parseDeepLink('https://styrbyapp.com/auth/callback?code=abc123');
        expect(result).toEqual({
          screen: 'auth/callback',
          params: { code: 'abc123' },
        });
      });

      it('should handle trailing slash in universal link', () => {
        const result = parseDeepLink('https://styrbyapp.com/dashboard/');
        expect(result).toEqual({
          screen: 'dashboard',
          params: {},
        });
      });

      it('should default empty universal link path to dashboard', () => {
        const result = parseDeepLink('https://styrbyapp.com/');
        expect(result).toEqual({
          screen: 'dashboard',
          params: {},
        });
      });
    });

    describe('invalid URLs', () => {
      it('should return null for unknown custom scheme', () => {
        const result = parseDeepLink('otherapp://dashboard');
        expect(result).toBeNull();
      });

      it('should return null for unknown universal link domain', () => {
        const result = parseDeepLink('https://example.com/dashboard');
        expect(result).toBeNull();
      });

      it('should return null for http (not https) universal link', () => {
        const result = parseDeepLink('http://styrbyapp.com/dashboard');
        expect(result).toBeNull();
      });

      it('should return null for malformed URL', () => {
        const result = parseDeepLink('not-a-url');
        expect(result).toBeNull();
      });

      it('should return null for empty string', () => {
        const result = parseDeepLink('');
        expect(result).toBeNull();
      });
    });

    describe('edge cases', () => {
      it('should handle URL-encoded query params', () => {
        const result = parseDeepLink('styrby://search?query=hello%20world');
        expect(result).toEqual({
          screen: 'search',
          params: { query: 'hello world' },
        });
      });

      it('should handle plus-encoded spaces', () => {
        const result = parseDeepLink('styrby://search?query=hello+world');
        expect(result).toEqual({
          screen: 'search',
          params: { query: 'hello world' },
        });
      });

      it('should handle empty query param values', () => {
        const result = parseDeepLink('styrby://search?query=');
        expect(result).toEqual({
          screen: 'search',
          params: { query: '' },
        });
      });

      it('should handle query param without value', () => {
        const result = parseDeepLink('styrby://search?query');
        expect(result).toEqual({
          screen: 'search',
          params: { query: '' },
        });
      });

      it('should handle duplicate query params (last one wins)', () => {
        const result = parseDeepLink('styrby://chat?sessionId=123&sessionId=456');
        expect(result).toEqual({
          screen: 'chat',
          params: { sessionId: '456' },
        });
      });
    });
  });

  describe('isKnownScreen', () => {
    it('should return true for auth/callback', () => {
      expect(isKnownScreen('auth/callback')).toBe(true);
    });

    it('should return true for dashboard', () => {
      expect(isKnownScreen('dashboard')).toBe(true);
    });

    it('should return true for chat', () => {
      expect(isKnownScreen('chat')).toBe(true);
    });

    it('should return true for sessions', () => {
      expect(isKnownScreen('sessions')).toBe(true);
    });

    it('should return true for costs', () => {
      expect(isKnownScreen('costs')).toBe(true);
    });

    it('should return true for settings', () => {
      expect(isKnownScreen('settings')).toBe(true);
    });

    it('should return true for scan', () => {
      expect(isKnownScreen('scan')).toBe(true);
    });

    it('should return false for unknown screen', () => {
      expect(isKnownScreen('unknown')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isKnownScreen('')).toBe(false);
    });

    it('should return false for screen with trailing slash', () => {
      expect(isKnownScreen('dashboard/')).toBe(false);
    });

    it('should return false for screen with custom scheme prefix', () => {
      expect(isKnownScreen('styrby://dashboard')).toBe(false);
    });
  });

  describe('screenAcceptsSessionId', () => {
    it('should return true for chat', () => {
      expect(screenAcceptsSessionId('chat')).toBe(true);
    });

    it('should return false for dashboard', () => {
      expect(screenAcceptsSessionId('dashboard')).toBe(false);
    });

    it('should return false for sessions', () => {
      expect(screenAcceptsSessionId('sessions')).toBe(false);
    });

    it('should return false for costs', () => {
      expect(screenAcceptsSessionId('costs')).toBe(false);
    });

    it('should return false for settings', () => {
      expect(screenAcceptsSessionId('settings')).toBe(false);
    });

    it('should return false for auth/callback', () => {
      expect(screenAcceptsSessionId('auth/callback')).toBe(false);
    });

    it('should return false for scan', () => {
      expect(screenAcceptsSessionId('scan')).toBe(false);
    });

    it('should return false for unknown screen', () => {
      expect(screenAcceptsSessionId('unknown')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(screenAcceptsSessionId('')).toBe(false);
    });
  });

  describe('TypeScript types', () => {
    it('should correctly type DeepLinkUrl', () => {
      const url: DeepLinkUrl = 'styrby://dashboard';
      expect(url).toBe('styrby://dashboard');
    });

    it('should correctly type RouterPath', () => {
      const path: RouterPath = '/(tabs)/';
      expect(path).toBe('/(tabs)/');
    });
  });

  describe('integration: buildDeepLink + parseDeepLink', () => {
    it('should roundtrip simple screen', () => {
      const url = buildDeepLink('dashboard');
      const parsed = parseDeepLink(url);
      expect(parsed).toEqual({
        screen: 'dashboard',
        params: {},
      });
    });

    it('should roundtrip screen with params', () => {
      const url = buildDeepLink('chat', { sessionId: '123' });
      const parsed = parseDeepLink(url);
      expect(parsed).toEqual({
        screen: 'chat',
        params: { sessionId: '123' },
      });
    });

    it('should roundtrip screen with multiple params', () => {
      const url = buildDeepLink('sessions', { filter: 'active', sort: 'date' });
      const parsed = parseDeepLink(url);
      expect(parsed).toEqual({
        screen: 'sessions',
        params: { filter: 'active', sort: 'date' },
      });
    });

    it('should roundtrip nested path with params', () => {
      const url = buildDeepLink('auth/callback', { code: 'abc123', state: 'xyz' });
      const parsed = parseDeepLink(url);
      expect(parsed).toEqual({
        screen: 'auth/callback',
        params: { code: 'abc123', state: 'xyz' },
      });
    });
  });
});
