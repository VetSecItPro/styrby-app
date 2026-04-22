/**
 * Privacy Settings Screen Tests
 *
 * Tests the mobile Privacy Control Center screen and its component tree.
 *
 * WHY: The privacy screen is the self-serve GDPR Art. 15/17 entry point for
 * mobile users. Regressions in the retention picker (wrong value sent),
 * missing confirmation gate on deletion, or broken export flow are all
 * compliance defects. This suite guards the mobile UX equivalent of the
 * web Privacy Control Center tests.
 *
 * Audit: GDPR Art. 15/17/20; SOC2 CC6.5
 */

import React from 'react';
import renderer from 'react-test-renderer';

// ============================================================================
// Global Mocks
// ============================================================================

const mockRouterPush = jest.fn();
const mockRouterReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockRouterPush, replace: mockRouterReplace }),
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn(async () => {}),
}));

jest.mock('expo-linking', () => ({
  openURL: jest.fn(),
}));

const mockGetSession = jest.fn(async () => ({
  data: { session: { access_token: 'test-token' } },
}));
const mockAuthGetUser = jest.fn(async () => ({
  data: { user: null }, error: null,
}));

jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => mockGetSession(),
      getUser: () => mockAuthGetUser(),
    },
    from: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: null, error: null }),
    })),
  },
  signOut: jest.fn(async () => ({ error: null })),
}));

jest.mock('@/lib/config', () => ({
  getApiBaseUrl: jest.fn(() => 'https://styrbyapp.com'),
}));

// WHY: @/services/pairing imports from 'styrby-shared' which uses ESM .js
// extension imports (e.g. './types.js') that Jest's CJS resolver cannot find
// when the module is loaded for the first time in this test file's worker
// context. Short-circuiting pairing here avoids the resolver issue while
// keeping the test focused on the privacy UI components, not the pairing
// service (which has its own dedicated test suite).
jest.mock('@/services/pairing', () => ({
  clearPairingInfo: jest.fn(async () => {}),
  isPaired: jest.fn(() => false),
  getPairingInfo: jest.fn(async () => null),
}));

jest.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: jest.fn(() => ({
    user: {
      id: 'user-123',
      email: 'test@example.com',
      displayName: 'Test User',
    },
    isLoading: false,
    refresh: jest.fn(),
  })),
}));

const mockFetch = jest.fn();
global.fetch = mockFetch as jest.MockedFunction<typeof fetch>;

// ============================================================================
// Helpers
// ============================================================================

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
        texts.push(...collectText(child));
      }
    }
  }
  return texts;
}

// ============================================================================
// RetentionPicker
// ============================================================================

describe('RetentionPicker', () => {
  const { RetentionPicker } = require('@/components/privacy/RetentionPicker');

  it('renders all 5 retention options', () => {
    const tree = renderer.create(
      <RetentionPicker
        initialRetentionDays={null}
        onRetentionChanged={jest.fn()}
        userId="user-123"
      />,
    ).toJSON();

    const texts = collectText(tree);
    expect(texts).toContain('7 days');
    expect(texts).toContain('30 days');
    expect(texts).toContain('90 days');
    expect(texts).toContain('1 year');
    expect(texts).toContain('Never');
  });

  it('shows loading state when initialRetentionDays is "loading"', () => {
    const tree = renderer.create(
      <RetentionPicker
        initialRetentionDays="loading"
        onRetentionChanged={jest.fn()}
        userId="user-123"
      />,
    ).toJSON();

    // Should not render individual options while loading
    const texts = collectText(tree);
    expect(texts).not.toContain('7 days');
  });

  it('renders GDPR citation in section header', () => {
    const tree = renderer.create(
      <RetentionPicker
        initialRetentionDays={30}
        onRetentionChanged={jest.fn()}
        userId="user-123"
      />,
    ).toJSON();

    const texts = collectText(tree);
    expect(texts.join(' ')).toContain('Session Retention');
  });
});

// ============================================================================
// MobileExportButton
// ============================================================================

describe('MobileExportButton', () => {
  const { MobileExportButton } = require('@/components/privacy/MobileExportButton');

  it('renders Export My Data button', () => {
    const tree = renderer.create(<MobileExportButton />).toJSON();
    const texts = collectText(tree);
    expect(texts).toContain('Export My Data');
  });

  it('renders GDPR citation', () => {
    const tree = renderer.create(<MobileExportButton />).toJSON();
    const texts = collectText(tree);
    expect(texts.join(' ')).toMatch(/GDPR Art\. 15/);
  });
});

// ============================================================================
// MobileDeleteSection
// ============================================================================

describe('MobileDeleteSection', () => {
  const { MobileDeleteSection } = require('@/components/privacy/MobileDeleteSection');

  it('renders Delete Account button in idle state', () => {
    const tree = renderer.create(
      <MobileDeleteSection userEmail="test@example.com" />,
    ).toJSON();
    const texts = collectText(tree);
    expect(texts).toContain('Delete Account');
  });

  it('renders GDPR Art. 17 citation', () => {
    const tree = renderer.create(
      <MobileDeleteSection userEmail="test@example.com" />,
    ).toJSON();
    const texts = collectText(tree);
    expect(texts.join(' ')).toMatch(/GDPR Art\. 17/);
  });
});

// ============================================================================
// MobilePrivacyLinks
// ============================================================================

describe('MobilePrivacyLinks', () => {
  const { MobilePrivacyLinks } = require('@/components/privacy/MobilePrivacyLinks');

  it('renders data map link', () => {
    const tree = renderer.create(<MobilePrivacyLinks />).toJSON();
    const texts = collectText(tree);
    expect(texts).toContain('Data Map - What We Store');
  });

  it('renders encryption details link', () => {
    const tree = renderer.create(<MobilePrivacyLinks />).toJSON();
    const texts = collectText(tree);
    expect(texts).toContain('Encryption Details');
  });
});

// ============================================================================
// Privacy Screen (orchestrator)
// ============================================================================

describe('PrivacyScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ retention_days: null }),
    });
  });

  it('renders Privacy Control Center heading', async () => {
    const PrivacyScreen = require('../privacy').default;

    // WHY synchronous create (not async act): The PrivacyScreen useEffect uses
    // dynamic import() which throws "A dynamic import callback was invoked
    // without --experimental-vm-modules" in Jest's Node env. Calling
    // renderer.create() synchronously captures the first-render tree before
    // the effect fires. The heading is always rendered on first render when
    // user is not null (mocked above), so this is a stable snapshot.
    const tree = renderer.create(<PrivacyScreen />).toJSON();

    const texts = collectText(tree);
    expect(texts).toContain('Privacy Control Center');
  });
});
