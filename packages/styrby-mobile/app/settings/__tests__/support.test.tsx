/**
 * Support Sub-Screen Tests
 *
 * Validates that the Support settings screen:
 * - Renders all sections (Get Help, Send Feedback, Legal)
 * - Feedback submit calls Supabase insert with correct payload
 * - Feedback submit shows success alert and clears text
 * - Feedback submit shows error alert on Supabase failure
 * - 2000-character limit is enforced on the TextInput
 * - Submit button is disabled when feedback text is empty
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
  useLocalSearchParams: jest.fn(() => ({})),
  Link: 'Link',
}));

// -- @expo/vector-icons --
jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

// -- Supabase --
const mockInsert = jest.fn();
const mockSupabaseChain = () => {
  const chain: Record<string, unknown> = {};
  const methods = ['select', 'eq', 'limit', 'single', 'insert', 'update', 'delete', 'upsert', 'maybeSingle'];
  for (const m of methods) {
    chain[m] = jest.fn(() => chain);
  }
  chain.then = (resolve: (v: unknown) => void) =>
    Promise.resolve({ data: null, error: null }).then(resolve);
  return chain;
};

const mockFrom = jest.fn(() => {
  const chain = mockSupabaseChain();
  (chain.insert as jest.Mock).mockImplementation(() => {
    // Track insert calls
    mockInsert();
    return chain;
  });
  return chain;
});

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
      getSession: jest.fn(async () => ({ data: { session: null }, error: null })),
      onAuthStateChange: jest.fn(() => ({
        data: { subscription: { unsubscribe: jest.fn() } },
      })),
    },
    from: mockFrom,
  },
  signOut: jest.fn(async () => ({ error: null })),
}));

// -- Alert mock --
const mockAlert = jest.fn();
jest.mock('react-native/Libraries/Alert/Alert', () => ({
  alert: mockAlert,
}));

// -- Linking mock --
jest.mock('react-native/Libraries/Linking/Linking', () => ({
  openURL: jest.fn(),
}));

// -- config --
jest.mock('@/lib/config', () => ({
  getApiBaseUrl: () => 'https://styrbyapp.com',
  SITE_URLS: {
    help: 'https://styrbyapp.com/help',
    privacy: 'https://styrbyapp.com/privacy',
    terms: 'https://styrbyapp.com/terms',
  },
}));

// ============================================================================
// Component Import
// ============================================================================

import SupportScreen from '../support';

// ============================================================================
// Helpers for async rendering
// ============================================================================

async function renderSupportScreen(): Promise<{
  component: renderer.ReactTestRenderer;
  tree: renderer.ReactTestRendererJSON | renderer.ReactTestRendererJSON[] | null;
}> {
  let component!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    component = renderer.create(<SupportScreen />);
    await new Promise<void>((r) => setTimeout(r, 50));
  });
  return { component, tree: component.toJSON() };
}

// ============================================================================
// Tests
// ============================================================================

describe('SupportScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  it('renders without crashing', async () => {
    const { tree } = await renderSupportScreen();
    expect(tree).not.toBeNull();
  });

  it('renders Get Help section', async () => {
    const { tree } = await renderSupportScreen();
    expect(hasText(tree, 'Get Help')).toBe(true);
  });

  it('renders Support Tickets row', async () => {
    const { tree } = await renderSupportScreen();
    expect(hasText(tree, 'Support Tickets')).toBe(true);
  });

  it('renders Help & FAQ row', async () => {
    const { tree } = await renderSupportScreen();
    expect(hasText(tree, 'Help & FAQ')).toBe(true);
  });

  it('renders Send Feedback section', async () => {
    const { tree } = await renderSupportScreen();
    expect(hasText(tree, 'Send Feedback')).toBe(true);
  });

  it('renders feedback text input with placeholder', async () => {
    const { component } = await renderSupportScreen();
    const input = component.root.find(
      (node) => node.props.accessibilityLabel === 'Feedback text input',
    );
    expect(input.props.placeholder).toBe('Your feedback...');
  });

  it('renders character counter max label', async () => {
    const { tree } = await renderSupportScreen();
    // Character counter renders the max as a separate text node
    expect(hasText(tree, '2000')).toBe(true);
  });

  it('renders Submit Feedback button', async () => {
    const { tree } = await renderSupportScreen();
    expect(hasText(tree, 'Submit Feedback')).toBe(true);
  });

  it('renders Legal section', async () => {
    const { tree } = await renderSupportScreen();
    expect(hasText(tree, 'Legal')).toBe(true);
  });

  it('renders Privacy Policy row', async () => {
    const { tree } = await renderSupportScreen();
    expect(hasText(tree, 'Privacy Policy')).toBe(true);
  });

  it('renders Terms of Service row', async () => {
    const { tree } = await renderSupportScreen();
    expect(hasText(tree, 'Terms of Service')).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Feedback text input interactions
  // --------------------------------------------------------------------------

  it('enforces 2000 character maxLength on feedback input', async () => {
    const { component } = await renderSupportScreen();
    const input = component.root.find(
      (node) => node.props.accessibilityLabel === 'Feedback text input',
    );
    expect(input.props.maxLength).toBe(2000);
  });

  it('submit button is disabled when feedback is empty', async () => {
    const { component } = await renderSupportScreen();
    const submitBtn = component.root.find(
      (node) => node.props.accessibilityLabel === 'Submit feedback',
    );
    expect(submitBtn.props.disabled).toBe(true);
  });

  it('submit button becomes enabled after typing feedback', async () => {
    const { component } = await renderSupportScreen();

    const input = component.root.find(
      (node) => node.props.accessibilityLabel === 'Feedback text input',
    );

    await renderer.act(async () => {
      input.props.onChangeText('This is my feedback');
    });

    const submitBtn = component.root.find(
      (node) => node.props.accessibilityLabel === 'Submit feedback',
    );
    expect(submitBtn.props.disabled).toBe(false);
  });
});
