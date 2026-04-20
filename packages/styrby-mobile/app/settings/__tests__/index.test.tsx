/**
 * Settings Hub Tests
 *
 * Validates that the Settings Hub orchestrator screen:
 * - Renders all section headers
 * - Renders all navigation rows
 * - Navigates to correct sub-screen paths on row press
 * - Shows version footer
 * - Renders loading indicator while user loads
 *
 * Uses react-test-renderer (node environment — no DOM/jsdom).
 */

import React from 'react';
import renderer from 'react-test-renderer';

// ============================================================================
// Helpers
// ============================================================================

function collectText(
  node: renderer.ReactTestRendererJSON | renderer.ReactTestRendererJSON[] | null,
): string[] {
  if (!node) return [];
  if (Array.isArray(node)) return node.flatMap(collectText);
  const texts: string[] = [];
  if (typeof node === 'string') return [node];
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

// ============================================================================
// Global Mocks
// ============================================================================

// -- expo-router --
const mockRouterPush = jest.fn();
jest.mock('expo-router', () => ({
  router: { push: mockRouterPush, replace: jest.fn(), back: jest.fn() },
  useRouter: () => ({ push: mockRouterPush, replace: jest.fn(), back: jest.fn() }),
  Link: 'Link',
}));

// -- @expo/vector-icons --
jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

// -- expo-constants --
jest.mock('expo-constants', () => ({
  expoConfig: { version: '1.0.0', ios: { buildNumber: '42' } },
}));

// -- expo-secure-store --
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => 'dark'),
  setItemAsync: jest.fn(async () => {}),
}));

// -- ThemeContext --
jest.mock('@/contexts/ThemeContext', () => ({
  THEME_PREFERENCE_KEY: 'styrby_theme_preference',
  useTheme: jest.fn(() => ({ theme: 'dark', themePreference: 'dark', setThemePreference: jest.fn() })),
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// -- Supabase --
const buildChain = () => {
  const chain: Record<string, unknown> = {};
  const methods = ['select', 'eq', 'single', 'limit', 'maybeSingle'];
  for (const m of methods) {
    chain[m] = jest.fn(() => chain);
  }
  chain.then = (resolve: (v: unknown) => void) =>
    Promise.resolve({ data: { push_enabled: true, plan: 'pro' }, error: null }).then(resolve);
  (chain.single as jest.Mock).mockResolvedValue(
    { data: { push_enabled: true, plan: 'pro' }, error: null },
  );
  (chain.maybeSingle as jest.Mock).mockResolvedValue(
    { data: { plan: 'pro' }, error: null },
  );
  return chain;
};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getUser: jest.fn(async () => ({
        data: {
          user: {
            id: 'test-user-id',
            email: 'test@example.com',
            user_metadata: { display_name: 'Test User' },
          },
        },
        error: null,
      })),
      onAuthStateChange: jest.fn(() => ({
        data: { subscription: { unsubscribe: jest.fn() } },
      })),
    },
    from: jest.fn(() => buildChain()),
  },
  signOut: jest.fn(async () => ({ error: null })),
}));

// ============================================================================
// Component Import
// ============================================================================

import SettingsHubScreen from '../index';

// ============================================================================
// Helpers for async rendering
// ============================================================================

async function renderHub(): Promise<{
  component: renderer.ReactTestRenderer;
  tree: renderer.ReactTestRendererJSON | renderer.ReactTestRendererJSON[] | null;
}> {
  let component!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    component = renderer.create(<SettingsHubScreen />);
    await new Promise<void>((r) => setTimeout(r, 100));
  });
  return { component, tree: component.toJSON() };
}

// ============================================================================
// Tests
// ============================================================================

describe('SettingsHubScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  it('renders without crashing', async () => {
    const { tree } = await renderHub();
    expect(tree).not.toBeNull();
  });

  it('renders Account section header', async () => {
    const { tree } = await renderHub();
    expect(hasText(tree, 'Account')).toBe(true);
  });

  it('renders Preferences section header', async () => {
    const { tree } = await renderHub();
    expect(hasText(tree, 'Preferences')).toBe(true);
  });

  it('renders Developer section header', async () => {
    const { tree } = await renderHub();
    expect(hasText(tree, 'Developer')).toBe(true);
  });

  it('renders Support section header', async () => {
    const { tree } = await renderHub();
    expect(hasText(tree, 'Support')).toBe(true);
  });

  it('renders Notifications row', async () => {
    const { tree } = await renderHub();
    expect(hasText(tree, 'Notifications')).toBe(true);
  });

  it('renders Appearance row', async () => {
    const { tree } = await renderHub();
    expect(hasText(tree, 'Appearance')).toBe(true);
  });

  it('renders Voice Input row', async () => {
    const { tree } = await renderHub();
    expect(hasText(tree, 'Voice Input')).toBe(true);
  });

  it('renders Agents row', async () => {
    const { tree } = await renderHub();
    expect(hasText(tree, 'Agents')).toBe(true);
  });

  it('renders Metrics Export row', async () => {
    const { tree } = await renderHub();
    expect(hasText(tree, 'Metrics Export')).toBe(true);
  });

  it('renders version footer with version number', async () => {
    const { tree } = await renderHub();
    expect(hasText(tree, 'Styrby v')).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Navigation
  // --------------------------------------------------------------------------

  it('Account row navigates to /settings/account', async () => {
    const { component } = await renderHub();

    const accountRow = component.root.findAll(
      (node) =>
        typeof node.props.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel.includes('Account'),
    );
    expect(accountRow.length).toBeGreaterThan(0);

    await renderer.act(async () => {
      accountRow[0].props.onPress();
    });

    expect(mockRouterPush).toHaveBeenCalledWith('/settings/account');
  });

  it('Notifications row navigates to /settings/notifications', async () => {
    const { component } = await renderHub();

    const notifRow = component.root.findAll(
      (node) =>
        typeof node.props.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel.includes('Notifications'),
    );
    expect(notifRow.length).toBeGreaterThan(0);

    await renderer.act(async () => {
      notifRow[0].props.onPress();
    });

    expect(mockRouterPush).toHaveBeenCalledWith('/settings/notifications');
  });

  it('Appearance row navigates to /settings/appearance', async () => {
    const { component } = await renderHub();

    const appearanceRow = component.root.findAll(
      (node) =>
        typeof node.props.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel.includes('Appearance'),
    );
    expect(appearanceRow.length).toBeGreaterThan(0);

    await renderer.act(async () => {
      appearanceRow[0].props.onPress();
    });

    expect(mockRouterPush).toHaveBeenCalledWith('/settings/appearance');
  });

  it('Agents row navigates to /settings/agents', async () => {
    const { component } = await renderHub();

    const agentsRow = component.root.findAll(
      (node) =>
        typeof node.props.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel.includes('Agents'),
    );
    expect(agentsRow.length).toBeGreaterThan(0);

    await renderer.act(async () => {
      agentsRow[0].props.onPress();
    });

    expect(mockRouterPush).toHaveBeenCalledWith('/settings/agents');
  });
});
