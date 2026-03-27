/**
 * Auth Screens Render Tests
 *
 * Validates that authentication screens render correctly.
 * Uses react-test-renderer (node environment, no DOM).
 *
 * Screens covered:
 * - Login (login.tsx)
 * - QR Scan (scan.tsx)
 * - Auth Callback (callback.tsx)
 */

import React from 'react';
import renderer from 'react-test-renderer';

// ============================================================================
// Helpers
// ============================================================================

function collectText(node: renderer.ReactTestRendererJSON | renderer.ReactTestRendererJSON[] | null): string[] {
  if (!node) return [];
  if (Array.isArray(node)) return node.flatMap(collectText);
  const texts: string[] = [];
  if (typeof node === 'string') return [node];
  if (node.children) {
    for (const child of node.children) {
      if (typeof child === 'string') texts.push(child);
      else texts.push(...collectText(child));
    }
  }
  return texts;
}

function hasText(tree: renderer.ReactTestRendererJSON | renderer.ReactTestRendererJSON[] | null, text: string): boolean {
  return collectText(tree).some((t) => t.includes(text));
}

function hasTextMatch(tree: renderer.ReactTestRendererJSON | renderer.ReactTestRendererJSON[] | null, pattern: RegExp): boolean {
  return collectText(tree).some((t) => pattern.test(t));
}

// ============================================================================
// Global Mocks
// ============================================================================

const mockRouterPush = jest.fn();
const mockRouterReplace = jest.fn();
const mockLocalSearchParams: Record<string, string | undefined> = {};

jest.mock('expo-router', () => ({
  router: { push: mockRouterPush, replace: mockRouterReplace, back: jest.fn() },
  useRouter: () => ({ push: mockRouterPush, replace: mockRouterReplace, back: jest.fn() }),
  useLocalSearchParams: jest.fn(() => mockLocalSearchParams),
  useFocusEffect: jest.fn(),
  Link: 'Link',
  Stack: { Screen: 'StackScreen' },
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

jest.mock('styrby-shared', () => ({
  decodePairingUrl: jest.fn(() => ({
    channelId: 'test-channel',
    userId: 'test-user-id',
    timestamp: Date.now(),
    publicKey: 'test-key',
  })),
  isPairingExpired: jest.fn(() => false),
}));

// -- Supabase --
const mockSignInWithOtp = jest.fn(async () => ({ error: null }));
const mockSignInWithPassword = jest.fn(async () => ({ error: null }));
const mockSignUp = jest.fn(async () => ({ error: null }));
const mockSignInWithOAuth = jest.fn(async () => ({
  data: { url: 'https://github.com/login/oauth' },
  error: null,
}));
const mockExchangeCode = jest.fn(async () => ({ error: null }));

jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      signInWithOtp: mockSignInWithOtp,
      signInWithPassword: mockSignInWithPassword,
      signUp: mockSignUp,
      signInWithOAuth: mockSignInWithOAuth,
      exchangeCodeForSession: mockExchangeCode,
      getUser: jest.fn(async () => ({ data: { user: { id: 'test-user-id' } }, error: null })),
    },
    from: jest.fn(() => {
      const chain: Record<string, unknown> = {};
      const methods = ['select', 'eq', 'order', 'limit', 'single'];
      for (const m of methods) chain[m] = jest.fn(() => chain);
      chain.then = (r: (v: unknown) => void) => Promise.resolve({ data: null, error: null }).then(r);
      return chain;
    }),
  },
}));

// -- Services --
jest.mock('@/services/pairing', () => ({
  executePairing: jest.fn(async () => ({ success: true })),
  isPaired: jest.fn(async () => false),
  clearPairingInfo: jest.fn(async () => {}),
}));

jest.mock('@/hooks/useRelay', () => ({
  useRelay: jest.fn(() => ({
    savePairing: jest.fn(async () => {}),
    connect: jest.fn(async () => {}),
    isConnected: false,
  })),
}));

// ============================================================================
// Imports (after mocks)
// ============================================================================

import LoginScreen from '../(auth)/login';
import ScanScreen from '../(auth)/scan';
import AuthCallbackScreen from '../(auth)/callback';

// ============================================================================
// Login Screen Tests
// ============================================================================

describe('LoginScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders without crashing', () => {
    const tree = renderer.create(<LoginScreen />).toJSON();
    expect(tree).toBeTruthy();
  });

  it('displays the Styrby branding', () => {
    const tree = renderer.create(<LoginScreen />).toJSON();
    expect(hasText(tree, 'Styrby')).toBe(true);
  });

  it('shows Send Magic Link button', () => {
    const tree = renderer.create(<LoginScreen />).toJSON();
    expect(hasText(tree, 'Send Magic Link')).toBe(true);
  });

  it('shows password toggle option', () => {
    const tree = renderer.create(<LoginScreen />).toJSON();
    expect(hasTextMatch(tree, /password instead/i)).toBe(true);
  });

  it('shows GitHub OAuth button', () => {
    const tree = renderer.create(<LoginScreen />).toJSON();
    expect(hasText(tree, 'Continue with GitHub')).toBe(true);
  });

  it('shows sign in link text', () => {
    const tree = renderer.create(<LoginScreen />).toJSON();
    expect(hasText(tree, 'Sign in')).toBe(true);
  });
});

// ============================================================================
// Scan Screen Tests
// ============================================================================

describe('ScanScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders without crashing', () => {
    const tree = renderer.create(<ScanScreen />).toJSON();
    expect(tree).toBeTruthy();
  });

  it('contains scan-related text', () => {
    const tree = renderer.create(<ScanScreen />).toJSON();
    expect(hasTextMatch(tree, /scan|qr|pair/i)).toBe(true);
  });

  it('renders as a non-null tree', () => {
    const instance = renderer.create(<ScanScreen />);
    expect(instance.toJSON()).not.toBeNull();
  });
});

// ============================================================================
// Auth Callback Screen Tests
// ============================================================================

describe('AuthCallbackScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(mockLocalSearchParams).forEach((k) => delete mockLocalSearchParams[k]);
  });

  it('renders without crashing with code param', async () => {
    mockLocalSearchParams.code = 'test-auth-code';
    let component: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      component = renderer.create(<AuthCallbackScreen />);
    });
    expect(component!.toJSON()).toBeTruthy();
  });

  it('shows error when no code is provided', async () => {
    delete mockLocalSearchParams.code;
    let component: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      component = renderer.create(<AuthCallbackScreen />);
    });
    const tree = component!.toJSON();
    expect(hasTextMatch(tree, /authorization code|expired|used/i)).toBe(true);
  });

  it('renders a non-null tree after auth flow', async () => {
    mockLocalSearchParams.code = 'test-auth-code';
    let component: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      component = renderer.create(<AuthCallbackScreen />);
    });
    // After the auth effect runs, the screen should render some state (success, error, or processing)
    const tree = component!.toJSON();
    expect(tree).not.toBeNull();
  });
});
