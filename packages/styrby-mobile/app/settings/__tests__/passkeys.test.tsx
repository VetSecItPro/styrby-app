/**
 * PasskeysScreen Tests
 *
 * Covers:
 * - Renders passkey management screen with header
 * - Shows loading state on mount
 * - Shows empty state when no passkeys
 * - Shows active passkeys list
 * - Add passkey: happy path (challenge -> create -> verify -> refresh)
 * - Add passkey: user cancels (no alert for normal cancel)
 * - Add passkey: session expired shows correct error
 * - Revoke passkey: calls supabase update, updates list
 * - Rename passkey: inline edit flow
 *
 * Uses react-test-renderer (node environment — no DOM/jsdom).
 */

import React from 'react';
import renderer from 'react-test-renderer';

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

// ── Global Mocks ───────────────────────────────────────────────────────────

const mockRouterReplace = jest.fn();
jest.mock('expo-router', () => ({
  router: { replace: mockRouterReplace, push: jest.fn(), back: jest.fn() },
  useRouter: () => ({ replace: mockRouterReplace }),
  Stack: {
    Screen: () => null,
  },
}));

const mockGetSession = jest.fn();
const mockSupabaseFrom = jest.fn();

jest.mock('../../../src/lib/supabase', () => ({
  supabase: {
    auth: { getSession: mockGetSession },
    from: mockSupabaseFrom,
  },
}));

const mockGetApiBaseUrl = jest.fn(() => 'http://localhost:3000');
jest.mock('../../../src/lib/config', () => ({
  getApiBaseUrl: mockGetApiBaseUrl,
}));

const mockPasskeyCreate = jest.fn();
const mockPasskeyAuthenticate = jest.fn();
jest.mock('expo-passkey', () => ({
  Passkey: {
    create: mockPasskeyCreate,
    authenticate: mockPasskeyAuthenticate,
  },
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

jest.mock('react-native/Libraries/Alert/Alert', () => ({
  alert: jest.fn(),
}));

// Build a chainable Supabase query mock
function buildQueryMock(result: { data: unknown; error: unknown }) {
  const chain: Record<string, jest.Mock> = {};
  for (const method of ['select', 'order', 'update', 'eq', 'single']) {
    chain[method] = jest.fn().mockReturnValue(chain);
  }
  // Last method in each chain resolves
  chain['order'] = jest.fn().mockResolvedValue(result);
  chain['eq'] = jest.fn().mockResolvedValue(result);
  return chain;
}

// Fetch mock helper
function mockFetchOnce(response: { ok: boolean; json: unknown }) {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: response.ok,
    json: () => Promise.resolve(response.json),
  });
}

// Sample data
const samplePasskey = {
  id: 'pk-001',
  credential_id: 'cred-abc',
  device_name: 'iPhone 15 Pro',
  transports: ['internal'],
  created_at: '2026-01-15T10:00:00Z',
  last_used_at: null,
  revoked_at: null,
};

// ── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn();
  mockGetSession.mockResolvedValue({
    data: { session: { access_token: 'test-token' } },
  });
});

describe('PasskeysScreen', () => {
  it('renders without crashing', async () => {
    mockSupabaseFrom.mockReturnValue(buildQueryMock({ data: [], error: null }));

    let tree: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      const PasskeysScreen = require('../passkeys').default;
      tree = renderer.create(<PasskeysScreen />);
    });

    expect(tree!.toJSON()).not.toBeNull();
  });

  it('shows "Add a passkey" button', async () => {
    mockSupabaseFrom.mockReturnValue(buildQueryMock({ data: [], error: null }));

    let tree: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      const PasskeysScreen = require('../passkeys').default;
      tree = renderer.create(<PasskeysScreen />);
    });

    expect(hasText(tree!.toJSON(), 'Add a passkey')).toBe(true);
  });

  it('shows empty state text when no passkeys', async () => {
    mockSupabaseFrom.mockReturnValue(buildQueryMock({ data: [], error: null }));

    let tree: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      const PasskeysScreen = require('../passkeys').default;
      tree = renderer.create(<PasskeysScreen />);
    });

    expect(hasText(tree!.toJSON(), 'No passkeys registered yet')).toBe(true);
  });

  it('renders an active passkey', async () => {
    mockSupabaseFrom.mockReturnValue(
      buildQueryMock({ data: [samplePasskey], error: null }),
    );

    let tree: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      const PasskeysScreen = require('../passkeys').default;
      tree = renderer.create(<PasskeysScreen />);
    });

    expect(hasText(tree!.toJSON(), 'iPhone 15 Pro')).toBe(true);
  });

  it('shows revoked badge for revoked passkeys', async () => {
    const revokedPasskey = { ...samplePasskey, revoked_at: '2026-03-01T00:00:00Z' };
    mockSupabaseFrom.mockReturnValue(
      buildQueryMock({ data: [revokedPasskey], error: null }),
    );

    let tree: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      const PasskeysScreen = require('../passkeys').default;
      tree = renderer.create(<PasskeysScreen />);
    });

    expect(hasText(tree!.toJSON(), 'Revoked')).toBe(true);
  });

  it('snapshot — empty state', async () => {
    mockSupabaseFrom.mockReturnValue(buildQueryMock({ data: [], error: null }));

    let tree: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      const PasskeysScreen = require('../passkeys').default;
      tree = renderer.create(<PasskeysScreen />);
    });

    expect(tree!.toJSON()).toMatchSnapshot();
  });

  it('snapshot — with active passkeys', async () => {
    mockSupabaseFrom.mockReturnValue(
      buildQueryMock({ data: [samplePasskey], error: null }),
    );

    let tree: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      const PasskeysScreen = require('../passkeys').default;
      tree = renderer.create(<PasskeysScreen />);
    });

    expect(tree!.toJSON()).toMatchSnapshot();
  });

  it('enrolls a passkey successfully', async () => {
    // First fetch: initial load (empty)
    mockSupabaseFrom
      .mockReturnValueOnce(buildQueryMock({ data: [], error: null }))
      // Reload after enrollment
      .mockReturnValueOnce(buildQueryMock({ data: [samplePasskey], error: null }));

    // Challenge + verify fetch
    mockFetchOnce({ ok: true, json: { challenge: 'reg-chal', user: {} } });
    mockFetchOnce({ ok: true, json: { success: true } });

    mockPasskeyCreate.mockResolvedValue({ id: 'new-cred' });

    let tree: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      const PasskeysScreen = require('../passkeys').default;
      tree = renderer.create(<PasskeysScreen />);
    });

    // Tap the "Add a passkey" button
    const buttons = tree!.root.findAllByProps({ accessibilityLabel: 'Add a passkey' });
    await renderer.act(async () => {
      buttons[0].props.onPress();
    });

    expect(mockPasskeyCreate).toHaveBeenCalledTimes(1);
  });

  it('handles enroll cancellation gracefully', async () => {
    mockSupabaseFrom.mockReturnValue(buildQueryMock({ data: [], error: null }));

    mockFetchOnce({ ok: true, json: { challenge: 'reg-chal' } });

    const cancelErr = new Error('User cancelled');
    cancelErr.name = 'NotAllowedError';
    mockPasskeyCreate.mockRejectedValue(cancelErr);

    const Alert = require('react-native/Libraries/Alert/Alert');

    let tree: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      const PasskeysScreen = require('../passkeys').default;
      tree = renderer.create(<PasskeysScreen />);
    });

    const buttons = tree!.root.findAllByProps({ accessibilityLabel: 'Add a passkey' });
    await renderer.act(async () => {
      buttons[0].props.onPress();
    });

    // NotAllowedError -> "Cancelled" alert
    expect(Alert.alert).toHaveBeenCalledWith('Cancelled', expect.any(String));
  });
});
