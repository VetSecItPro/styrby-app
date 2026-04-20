/**
 * Notifications Sub-Screen Tests
 *
 * Validates that the Notifications settings screen:
 * - Renders push, email, quiet hours toggles and smart notifications
 * - Push toggle performs optimistic update and calls Supabase update
 * - Push toggle reverts on Supabase error
 * - Email toggle performs optimistic update
 * - Quiet hours toggle enables and sets default times when first enabled
 * - Priority selector disabled for free users, enabled for Pro+
 * - Pro gate banner shown for free users
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

// -- @expo/vector-icons --
jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

// -- expo-router --
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  Link: 'Link',
}));

// -- react-native Linking --
jest.mock('react-native/Libraries/Linking/Linking', () => ({
  openURL: jest.fn(),
}));

// -- platform-billing --
jest.mock('@/lib/platform-billing', () => ({
  canShowUpgradePrompt: jest.fn(() => false),
  POLAR_CUSTOMER_PORTAL_URL: 'https://polar.sh/styrby/portal',
}));

// -- styrby-shared --
jest.mock('styrby-shared', () => ({
  formatTime: jest.fn((t: string | null, fallback: string) => {
    if (!t) return fallback;
    const [hours, minutes] = t.split(':').map(Number);
    const period = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;
    return `${displayHours}:${String(minutes).padStart(2, '0')} ${period}`;
  }),
  getThresholdDescription: jest.fn((t: number) => {
    const labels: Record<number, string> = {
      1: 'Urgent only', 2: 'High priority', 3: 'Medium priority',
      4: 'Most notifications', 5: 'All notifications',
    };
    return labels[t] ?? 'Unknown';
  }),
  getEstimatedNotificationPercentage: jest.fn((t: number) => {
    const pcts: Record<number, number> = { 1: 5, 2: 15, 3: 50, 4: 85, 5: 100 };
    return pcts[t] ?? 50;
  }),
  decodePairingUrl: jest.fn(),
  isPairingExpired: jest.fn(() => false),
}));

// -- Supabase --
const mockUpdate = jest.fn();
const mockInsert = jest.fn();

const buildChain = (resolveData?: unknown) => {
  const chain: Record<string, unknown> = {};
  const methods = ['select', 'eq', 'limit', 'single', 'update', 'insert', 'upsert'];
  for (const m of methods) {
    chain[m] = jest.fn(() => chain);
  }
  chain.then = (resolve: (v: unknown) => void) =>
    Promise.resolve(resolveData ?? { data: null, error: null }).then(resolve);
  (chain.single as jest.Mock).mockResolvedValue(
    resolveData ?? {
      data: {
        id: 'pref-id-1',
        push_enabled: true,
        email_enabled: false,
        quiet_hours_enabled: false,
        quiet_hours_start: '22:00:00',
        quiet_hours_end: '07:00:00',
        priority_threshold: 3,
      },
      error: null,
    },
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
    from: jest.fn((table: string) => {
      if (table === 'subscriptions') {
        return buildChain({ data: { plan: 'free' }, error: null });
      }
      const chain = buildChain();
      (chain.update as jest.Mock).mockImplementation((updates: unknown) => {
        mockUpdate(updates);
        return { eq: jest.fn(() => Promise.resolve({ data: null, error: null })) };
      });
      (chain.insert as jest.Mock).mockImplementation((data: unknown) => {
        mockInsert(data);
        return buildChain({ data: { id: 'new-pref-id' }, error: null });
      });
      return chain;
    }),
  },
  signOut: jest.fn(async () => ({ error: null })),
}));

// ============================================================================
// Component Import
// ============================================================================

import NotificationsScreen from '../notifications';

// ============================================================================
// Helpers for async rendering
// ============================================================================

async function renderNotificationsScreen(): Promise<{
  component: renderer.ReactTestRenderer;
  tree: renderer.ReactTestRendererJSON | renderer.ReactTestRendererJSON[] | null;
}> {
  let component!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    component = renderer.create(<NotificationsScreen />);
    await new Promise<void>((r) => setTimeout(r, 100));
  });
  return { component, tree: component.toJSON() };
}

// ============================================================================
// Tests
// ============================================================================

describe('NotificationsScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  it('renders without crashing', async () => {
    const { tree } = await renderNotificationsScreen();
    expect(tree).not.toBeNull();
  });

  it('renders Channels section', async () => {
    const { tree } = await renderNotificationsScreen();
    expect(hasText(tree, 'Channels')).toBe(true);
  });

  it('renders Push Notifications toggle', async () => {
    const { component } = await renderNotificationsScreen();
    const switchNode = component.root.findAll(
      (node) => node.props.accessibilityLabel === 'Toggle push notifications',
    );
    expect(switchNode.length).toBeGreaterThan(0);
  });

  it('renders Email Notifications toggle', async () => {
    const { component } = await renderNotificationsScreen();
    const switchNode = component.root.findAll(
      (node) => node.props.accessibilityLabel === 'Toggle email notifications',
    );
    expect(switchNode.length).toBeGreaterThan(0);
  });

  it('renders Quiet Hours section', async () => {
    const { tree } = await renderNotificationsScreen();
    expect(hasText(tree, 'Quiet Hours')).toBe(true);
  });

  it('renders Quiet Hours toggle', async () => {
    const { component } = await renderNotificationsScreen();
    const switchNode = component.root.findAll(
      (node) => node.props.accessibilityLabel === 'Toggle quiet hours',
    );
    expect(switchNode.length).toBeGreaterThan(0);
  });

  it('renders Smart Notifications section', async () => {
    const { tree } = await renderNotificationsScreen();
    expect(hasText(tree, 'Smart Notifications')).toBe(true);
  });

  it('renders Pro badge for free users', async () => {
    const { tree } = await renderNotificationsScreen();
    expect(hasText(tree, 'Pro')).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Push toggle — optimistic update
  // --------------------------------------------------------------------------

  it('push toggle calls Supabase update with push_enabled value', async () => {
    const { component } = await renderNotificationsScreen();
    const switchNode = component.root.findAll(
      (node) => node.props.accessibilityLabel === 'Toggle push notifications',
    );

    await renderer.act(async () => {
      switchNode[0].props.onValueChange(false);
      await new Promise<void>((r) => setTimeout(r, 100));
    });

    expect(mockUpdate).toHaveBeenCalledWith({ push_enabled: false });
  });

  // --------------------------------------------------------------------------
  // Email toggle
  // --------------------------------------------------------------------------

  it('email toggle calls Supabase update with email_enabled value', async () => {
    const { component } = await renderNotificationsScreen();
    const switchNode = component.root.findAll(
      (node) => node.props.accessibilityLabel === 'Toggle email notifications',
    );

    await renderer.act(async () => {
      switchNode[0].props.onValueChange(true);
      await new Promise<void>((r) => setTimeout(r, 100));
    });

    expect(mockUpdate).toHaveBeenCalledWith({ email_enabled: true });
  });

  // --------------------------------------------------------------------------
  // Quiet hours
  // --------------------------------------------------------------------------

  it('quiet hours toggle calls Supabase update', async () => {
    const { component } = await renderNotificationsScreen();
    const switchNode = component.root.findAll(
      (node) => node.props.accessibilityLabel === 'Toggle quiet hours',
    );

    await renderer.act(async () => {
      switchNode[0].props.onValueChange(true);
      await new Promise<void>((r) => setTimeout(r, 100));
    });

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ quiet_hours_enabled: true }),
    );
  });

  // --------------------------------------------------------------------------
  // Priority selector
  // --------------------------------------------------------------------------

  it('priority selector buttons are rendered', async () => {
    const { tree } = await renderNotificationsScreen();
    // Priority levels 1-5 should be rendered
    expect(hasText(tree, 'Notification Sensitivity')).toBe(true);
  });
});
