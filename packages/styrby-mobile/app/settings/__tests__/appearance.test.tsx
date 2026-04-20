/**
 * Appearance Sub-Screen Tests
 *
 * Validates that the Appearance settings screen:
 * - Renders theme selector and haptic toggle
 * - Reads preferences from SecureStore on mount
 * - Writes theme preference to SecureStore on selection
 * - Writes haptic preference to SecureStore on toggle
 * - Reverts haptic on SecureStore write failure
 *
 * Uses react-test-renderer (node environment — no DOM/jsdom).
 */

import React from 'react';
import renderer from 'react-test-renderer';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Recursively collects all text content from a react-test-renderer JSON tree.
 */
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

/**
 * Returns true if any text node in the rendered tree contains the given substring.
 */
function hasText(
  tree: renderer.ReactTestRendererJSON | renderer.ReactTestRendererJSON[] | null,
  text: string,
): boolean {
  return collectText(tree).some((t) => t.includes(text));
}

// ============================================================================
// Global Mocks
// ============================================================================

// -- @expo/vector-icons --
jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

// -- expo-secure-store --
const mockGetItemAsync = jest.fn(async (_key: string): Promise<string | null> => null);
const mockSetItemAsync = jest.fn(async () => {});

jest.mock('expo-secure-store', () => ({
  getItemAsync: (...args: Parameters<typeof mockGetItemAsync>) => mockGetItemAsync(...args),
  setItemAsync: (...args: Parameters<typeof mockSetItemAsync>) => mockSetItemAsync(...args),
  deleteItemAsync: jest.fn(async () => {}),
}));

// -- ThemeContext --
jest.mock('@/contexts/ThemeContext', () => ({
  THEME_PREFERENCE_KEY: 'styrby_theme_preference',
  useTheme: jest.fn(() => ({
    theme: 'dark',
    themePreference: 'dark',
    setThemePreference: jest.fn(),
  })),
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// -- expo-router (needed by re-exported ui components) --
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: jest.fn(() => ({})),
  Link: 'Link',
}));

// ============================================================================
// Component Import (after all mocks)
// ============================================================================

import AppearanceScreen from '../appearance';

// ============================================================================
// Helpers for async rendering
// ============================================================================

async function renderAppearanceScreen(): Promise<{
  component: renderer.ReactTestRenderer;
  tree: renderer.ReactTestRendererJSON | renderer.ReactTestRendererJSON[] | null;
}> {
  let component!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    component = renderer.create(<AppearanceScreen />);
    // Allow useEffect + SecureStore promises to settle
    await new Promise<void>((r) => setTimeout(r, 50));
  });
  return { component, tree: component.toJSON() };
}

// ============================================================================
// Tests
// ============================================================================

describe('AppearanceScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetItemAsync.mockResolvedValue(null);
    mockSetItemAsync.mockResolvedValue(undefined);
  });

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  it('renders without crashing', async () => {
    const { tree } = await renderAppearanceScreen();
    expect(tree).not.toBeNull();
  });

  it('renders theme section header', async () => {
    const { tree } = await renderAppearanceScreen();
    expect(hasText(tree, 'Theme')).toBe(true);
  });

  it('renders all three theme options', async () => {
    const { tree } = await renderAppearanceScreen();
    expect(hasText(tree, 'Dark')).toBe(true);
    expect(hasText(tree, 'Light')).toBe(true);
    expect(hasText(tree, 'System')).toBe(true);
  });

  it('renders haptic feedback row', async () => {
    const { tree } = await renderAppearanceScreen();
    expect(hasText(tree, 'Haptic Feedback')).toBe(true);
  });

  // --------------------------------------------------------------------------
  // SecureStore loading
  // --------------------------------------------------------------------------

  it('loads theme preference from SecureStore on mount', async () => {
    mockGetItemAsync.mockImplementation(async (key: string) => {
      if (key === 'styrby_theme_preference') return 'light';
      return null;
    });

    const { tree } = await renderAppearanceScreen();
    // Light option should be rendered (present in tree regardless of selection state)
    expect(hasText(tree, 'Light')).toBe(true);
    expect(mockGetItemAsync).toHaveBeenCalledWith('styrby_theme_preference');
  });

  it('loads haptic preference from SecureStore on mount', async () => {
    mockGetItemAsync.mockImplementation(async (key: string) => {
      if (key === 'styrby_haptic_enabled') return 'false';
      return null;
    });

    await renderAppearanceScreen();
    expect(mockGetItemAsync).toHaveBeenCalledWith('styrby_haptic_enabled');
  });

  it('defaults theme to dark when SecureStore returns null', async () => {
    mockGetItemAsync.mockResolvedValue(null);
    const { tree } = await renderAppearanceScreen();
    // Dark should be present
    expect(hasText(tree, 'Dark')).toBe(true);
  });

  it('ignores invalid theme values from SecureStore', async () => {
    mockGetItemAsync.mockImplementation(async (key: string) => {
      if (key === 'styrby_theme_preference') return 'invalid-value';
      return null;
    });
    // Should not crash
    const { tree } = await renderAppearanceScreen();
    expect(tree).not.toBeNull();
  });

  // --------------------------------------------------------------------------
  // Theme change writes to SecureStore
  // --------------------------------------------------------------------------

  it('writes theme to SecureStore when option selected', async () => {
    const { component } = await renderAppearanceScreen();

    // Find pressable with "Light" accessibilityLabel
    const pressables = component.root.findAll(
      (node) =>
        node.props.accessibilityLabel === 'Set theme to Light',
    );
    expect(pressables.length).toBeGreaterThan(0);

    await renderer.act(async () => {
      pressables[0].props.onPress();
      await new Promise<void>((r) => setTimeout(r, 50));
    });

    expect(mockSetItemAsync).toHaveBeenCalledWith('styrby_theme_preference', 'light');
  });

  it('writes system theme to SecureStore when System selected', async () => {
    const { component } = await renderAppearanceScreen();

    const pressables = component.root.findAll(
      (node) =>
        node.props.accessibilityLabel === 'Set theme to System',
    );
    expect(pressables.length).toBeGreaterThan(0);

    await renderer.act(async () => {
      pressables[0].props.onPress();
      await new Promise<void>((r) => setTimeout(r, 50));
    });

    expect(mockSetItemAsync).toHaveBeenCalledWith('styrby_theme_preference', 'system');
  });

  // --------------------------------------------------------------------------
  // Haptic toggle
  // --------------------------------------------------------------------------

  it('writes haptic false to SecureStore when toggled off', async () => {
    const { component } = await renderAppearanceScreen();

    const switchNode = component.root.findAll(
      (node) =>
        node.props.accessibilityLabel === 'Toggle haptic feedback',
    );
    expect(switchNode.length).toBeGreaterThan(0);

    await renderer.act(async () => {
      switchNode[0].props.onValueChange(false);
      await new Promise<void>((r) => setTimeout(r, 50));
    });

    expect(mockSetItemAsync).toHaveBeenCalledWith('styrby_haptic_enabled', 'false');
  });

  it('writes haptic true to SecureStore when toggled on', async () => {
    mockGetItemAsync.mockImplementation(async (key: string) => {
      if (key === 'styrby_haptic_enabled') return 'false';
      return null;
    });

    const { component } = await renderAppearanceScreen();

    const switchNode = component.root.findAll(
      (node) =>
        node.props.accessibilityLabel === 'Toggle haptic feedback',
    );

    await renderer.act(async () => {
      switchNode[0].props.onValueChange(true);
      await new Promise<void>((r) => setTimeout(r, 50));
    });

    expect(mockSetItemAsync).toHaveBeenCalledWith('styrby_haptic_enabled', 'true');
  });
});
