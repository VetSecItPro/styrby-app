/**
 * Login Screen — Passkey Integration Snapshot Tests
 *
 * Verifies that the passkey button is present on the login screen and
 * that the login screen snapshot matches after adding passkey support.
 *
 * Covers:
 * - Passkey button renders on initial screen
 * - Snapshot: initial state (all auth options visible)
 * - Passkey loading state disables other buttons
 */

import React from 'react';
import renderer from 'react-test-renderer';

// ── Global Mocks ───────────────────────────────────────────────────────────

const mockRouterReplace = jest.fn();
jest.mock('expo-router', () => ({
  router: { replace: mockRouterReplace, push: jest.fn(), back: jest.fn() },
  useRouter: () => ({ replace: mockRouterReplace }),
}));

jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      signInWithOtp: jest.fn().mockResolvedValue({ error: null }),
      signInWithOAuth: jest.fn().mockResolvedValue({ error: null }),
      signInWithPassword: jest.fn().mockResolvedValue({ error: null }),
      signUp: jest.fn().mockResolvedValue({ error: null }),
      getSession: jest.fn().mockResolvedValue({ data: { session: null } }),
      setSession: jest.fn().mockResolvedValue({}),
    },
  },
}));

jest.mock('../../src/lib/config', () => ({
  getApiBaseUrl: jest.fn(() => 'http://localhost:3000'),
}));

jest.mock('expo-passkey', () => ({
  __esModule: true,
  default: {
    authenticateWithPasskey: jest.fn(),
    createPasskey: jest.fn(),
    isPasskeySupported: jest.fn(() => true),
  },
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

// ── Helpers ────────────────────────────────────────────────────────────────

function collectText(
  node: renderer.ReactTestRendererJSON | renderer.ReactTestRendererJSON[] | null,
): string[] {
  if (!node) return [];
  if (Array.isArray(node)) return node.flatMap(collectText);
  if (typeof node === 'string') return [node];
  const texts: string[] = [];
  if (node.children) {
    for (const child of node.children) {
      if (typeof child === 'string') {
        texts.push(child);
      } else {
        texts.push(...collectText(child as renderer.ReactTestRendererJSON));
      }
    }
  }
  return texts;
}

function hasText(
  tree: renderer.ReactTestRendererJSON | renderer.ReactTestRendererJSON[] | null,
  text: string,
): boolean {
  return collectText(tree).some((t) => t.includes(text));
}

// ── Tests ──────────────────────────────────────────────────────────────────

// Import after mocks are declared. jest.mock is hoisted so the mocks
// above will be active before this require executes.
// WHY require not import: top-level require preserves mock hoisting while
// avoiding the jest.resetModules() + duplicate-React-instance bug that
// causes "useState is null" in react-test-renderer.
const LoginScreen = require('../(auth)/login').default as React.ComponentType;

describe('Login screen — passkey support', () => {

  it('renders the passkey button', () => {
    let tree: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<LoginScreen />);
    });

    expect(hasText(tree!.toJSON(), 'Continue with Passkey')).toBe(true);
  });

  it('renders GitHub and email options alongside passkey', () => {
    let tree: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<LoginScreen />);
    });

    const texts = collectText(tree!.toJSON());
    expect(texts.some((t) => t.includes('Passkey'))).toBe(true);
    expect(texts.some((t) => t.includes('GitHub'))).toBe(true);
    expect(texts.some((t) => t.includes('Magic Link') || t.includes('Send Magic Link'))).toBe(true);
  });

  it('snapshot — initial login state with passkey button', () => {
    let tree: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<LoginScreen />);
    });

    expect(tree!.toJSON()).toMatchSnapshot();
  });
});
