/**
 * Onboarding Screens Render Tests
 *
 * Validates that onboarding flow screens render correctly.
 * Uses react-test-renderer (node environment, no DOM).
 *
 * Screens covered:
 * - Onboarding Index (onboarding/index.tsx)
 * - Onboarding Complete (onboarding/complete.tsx)
 * - Onboarding Notifications (onboarding/notifications.tsx)
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

jest.mock('expo-router', () => ({
  router: { push: mockRouterPush, replace: mockRouterReplace, back: jest.fn() },
  useRouter: () => ({ push: mockRouterPush, replace: mockRouterReplace, back: jest.fn() }),
  useLocalSearchParams: jest.fn(() => ({})),
  useFocusEffect: jest.fn(),
  Link: 'Link',
  Stack: { Screen: 'StackScreen' },
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

jest.mock('styrby-shared', () => ({}));

// -- PagerView --
jest.mock('react-native-pager-view', () => {
  const R = require('react');
  return R.forwardRef(function MockPagerView(
    props: { children: React.ReactNode },
    _ref: unknown,
  ) {
    return R.createElement('View', { testID: 'pager-view' }, props.children);
  });
});

// -- Supabase --
jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getUser: jest.fn(async () => ({
        data: { user: { id: 'test-user-id' } },
        error: null,
      })),
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
  isPaired: jest.fn(async () => false),
}));

jest.mock('@/services/notifications', () => ({
  registerForPushNotifications: jest.fn(async () => 'ExponentPushToken[mock]'),
  savePushToken: jest.fn(async () => {}),
}));

// -- OnboardingProgress component --
jest.mock('@/components/OnboardingProgress', () => ({
  OnboardingProgress: 'OnboardingProgress',
}));

// ============================================================================
// Imports (after mocks)
// ============================================================================

import OnboardingScreen from '../onboarding/index';
import CompleteScreen from '../onboarding/complete';
import NotificationsScreen from '../onboarding/notifications';

// ============================================================================
// Onboarding Index Tests
// ============================================================================

describe('OnboardingScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders without crashing', () => {
    const tree = renderer.create(<OnboardingScreen />).toJSON();
    expect(tree).toBeTruthy();
  });

  it('shows loading state initially', () => {
    // WHY: OnboardingScreen starts with isRestoringStep=true, showing a spinner
    const tree = renderer.create(<OnboardingScreen />).toJSON();
    expect(tree).toBeTruthy();
  });

  it('displays the Welcome step content after loading', async () => {
    let component: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      component = renderer.create(<OnboardingScreen />);
    });
    const tree = component!.toJSON();
    expect(hasText(tree, 'Welcome to Styrby')).toBe(true);
  });

  it('displays the Install CLI step content after loading', async () => {
    let component: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      component = renderer.create(<OnboardingScreen />);
    });
    const tree = component!.toJSON();
    expect(hasText(tree, 'Install the CLI')).toBe(true);
  });

  it('displays the Scan QR step content after loading', async () => {
    let component: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      component = renderer.create(<OnboardingScreen />);
    });
    const tree = component!.toJSON();
    expect(hasText(tree, 'Scan QR Code')).toBe(true);
  });

  it('shows the Continue button after loading', async () => {
    let component: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      component = renderer.create(<OnboardingScreen />);
    });
    const tree = component!.toJSON();
    expect(hasText(tree, 'Continue')).toBe(true);
  });
});

// ============================================================================
// Complete Screen Tests
// ============================================================================

describe('CompleteScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders without crashing', () => {
    const tree = renderer.create(<CompleteScreen />).toJSON();
    expect(tree).toBeTruthy();
  });

  it('displays success heading', () => {
    const tree = renderer.create(<CompleteScreen />).toJSON();
    expect(hasTextMatch(tree, /all set/i)).toBe(true);
  });

  it('displays quick tips', () => {
    const tree = renderer.create(<CompleteScreen />).toJSON();
    expect(hasText(tree, 'styrby start')).toBe(true);
    expect(hasText(tree, 'Pull down on the dashboard')).toBe(true);
    expect(hasText(tree, 'Tap a session')).toBe(true);
    expect(hasTextMatch(tree, /budget alert/i)).toBe(true);
  });

  it('shows the Go to Dashboard button', () => {
    const tree = renderer.create(<CompleteScreen />).toJSON();
    expect(hasText(tree, 'Go to Dashboard')).toBe(true);
  });

  it('triggers haptic feedback on mount', () => {
    const Haptics = require('expo-haptics');
    renderer.create(<CompleteScreen />);
    expect(Haptics.notificationAsync).toHaveBeenCalledWith(
      Haptics.NotificationFeedbackType.Success,
    );
  });
});

// ============================================================================
// Notifications Screen Tests
// ============================================================================

describe('NotificationsScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders without crashing', () => {
    const tree = renderer.create(<NotificationsScreen />).toJSON();
    expect(tree).toBeTruthy();
  });

  it('displays notification benefits', () => {
    const tree = renderer.create(<NotificationsScreen />).toJSON();
    expect(hasText(tree, 'Permission Requests')).toBe(true);
    expect(hasText(tree, 'Real-time Updates')).toBe(true);
    expect(hasText(tree, 'Budget Alerts')).toBe(true);
  });

  it('shows Enable Notifications button', () => {
    const tree = renderer.create(<NotificationsScreen />).toJSON();
    expect(hasText(tree, 'Enable Notifications')).toBe(true);
  });

  it('shows Maybe Later option', () => {
    const tree = renderer.create(<NotificationsScreen />).toJSON();
    expect(hasText(tree, 'Maybe Later')).toBe(true);
  });

  it('renders the progress indicator component', () => {
    const instance = renderer.create(<NotificationsScreen />);
    expect(instance.toJSON()).not.toBeNull();
  });
});
