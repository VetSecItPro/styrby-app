/**
 * Feature Screens Render Tests
 *
 * Validates that feature screens render correctly in key states.
 * Uses react-test-renderer (node environment, no DOM).
 *
 * Screens covered:
 * - Agent Config (agent-config.tsx)
 * - Budget Alerts (budget-alerts.tsx)
 * - Templates (templates.tsx)
 * - Session Detail (session/[id].tsx)
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

// ============================================================================
// Global Mocks
// ============================================================================

const mockRouterPush = jest.fn();
const mockRouterBack = jest.fn();
const mockLocalSearchParams: Record<string, string> = {};

jest.mock('expo-router', () => ({
  router: { push: mockRouterPush, replace: jest.fn(), back: mockRouterBack },
  useRouter: () => ({ push: mockRouterPush, replace: jest.fn(), back: mockRouterBack }),
  useLocalSearchParams: jest.fn(() => mockLocalSearchParams),
  useNavigation: jest.fn(() => ({
    addListener: jest.fn(() => jest.fn()),
    setOptions: jest.fn(),
  })),
  useFocusEffect: jest.fn((cb: () => void) => cb()),
  Link: 'Link',
  Stack: { Screen: 'StackScreen' },
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

jest.mock('expo-constants', () => ({
  expoConfig: { version: '1.0.0' },
}));

jest.mock('styrby-shared', () => ({}));

// -- Supabase --
const mockSupabaseChain = () => {
  const chain: Record<string, unknown> = {};
  const methods = ['select', 'eq', 'order', 'gte', 'limit', 'not', 'single', 'insert', 'update', 'delete', 'upsert', 'maybeSingle'];
  for (const m of methods) chain[m] = jest.fn(() => chain);
  chain.then = (resolve: (v: unknown) => void) =>
    Promise.resolve({ data: null, error: null }).then(resolve);
  return chain;
};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getUser: jest.fn(async () => ({
        data: { user: { id: 'test-user-id' } },
        error: null,
      })),
      onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
    },
    from: jest.fn(() => mockSupabaseChain()),
    channel: jest.fn(() => ({
      on: jest.fn().mockReturnThis(),
      subscribe: jest.fn(),
    })),
    removeChannel: jest.fn(),
  },
}));

// -- react-native-gesture-handler --
jest.mock('react-native-gesture-handler', () => {
  const R = require('react');
  return {
    GestureHandlerRootView: ({ children }: { children: unknown }) =>
      R.createElement('View', null, children),
    Gesture: { Pan: jest.fn() },
    GestureDetector: 'GestureDetector',
    Swipeable: 'Swipeable',
  };
});

// ============================================================================
// Hook Mocks
// ============================================================================

const mockBudgetAlerts = {
  alerts: [] as Array<{
    id: string;
    name: string;
    threshold: number;
    currentSpend: number;
    percentUsed: number;
    period: string;
    action: string;
    enabled: boolean;
    agentType: string | null;
  }>,
  tier: 'pro' as string,
  isLoading: false,
  isMutating: false,
  error: null as string | null,
  refresh: jest.fn(),
  createAlert: jest.fn(async () => true),
  toggleAlert: jest.fn(async () => true),
  deleteAlert: jest.fn(async () => true),
};

jest.mock('@/hooks/useBudgetAlerts', () => ({
  useBudgetAlerts: jest.fn(() => mockBudgetAlerts),
  getAlertProgressColor: jest.fn(() => '#22c55e'),
  getPeriodLabel: jest.fn(() => 'monthly'),
  getActionLabel: jest.fn(() => 'Notify'),
  getActionDescription: jest.fn(() => 'Send a notification'),
  getActionBadgeColor: jest.fn(() => ({ bg: '#eab30820', text: '#eab308' })),
  getAgentScopeLabel: jest.fn(() => 'All agents'),
}));

const mockTemplates = {
  templates: [] as Array<{
    id: string;
    user_id: string;
    name: string;
    content: string;
    is_default: boolean;
    is_system: boolean;
    category: string;
    created_at: string;
    updated_at: string;
  }>,
  isLoading: false,
  isMutating: false,
  error: null as string | null,
  refresh: jest.fn(async () => {}),
  createTemplate: jest.fn(async () => {}),
  updateTemplate: jest.fn(async () => {}),
  deleteTemplate: jest.fn(async () => {}),
  setDefaultTemplate: jest.fn(async () => {}),
};

jest.mock('@/hooks/useContextTemplates', () => ({
  useContextTemplates: jest.fn(() => mockTemplates),
}));

jest.mock('@/hooks/useCosts', () => ({
  useCosts: jest.fn(() => ({ data: null, isLoading: false, error: null })),
  formatCost: jest.fn((v: number) => `$${v.toFixed(2)}`),
  formatTokens: jest.fn((v: number) => `${(v / 1000).toFixed(1)}K`),
}));

// -- Component mocks --
jest.mock('@/components/template-list-item', () => ({
  TemplateListItem: 'TemplateListItem',
}));

jest.mock('@/components/template-form-sheet', () => ({
  TemplateFormSheet: 'TemplateFormSheet',
}));

jest.mock('@/components/SessionSummary', () => ({
  SessionSummary: 'SessionSummary',
}));

jest.mock('@/components/SessionReplay', () => ({
  SessionReplay: 'SessionReplay',
}));

jest.mock('@/components/SessionTagEditor', () => ({
  SessionTagEditor: 'SessionTagEditor',
}));

// ============================================================================
// Imports (after mocks)
// ============================================================================

import AgentConfigScreen from '../agent-config';
import BudgetAlertsScreen from '../budget-alerts';
import TemplatesScreen from '../templates';
import SessionDetailScreen from '../session/[id]';

// ============================================================================
// Agent Config Tests
// ============================================================================

describe('AgentConfigScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(mockLocalSearchParams, { agent: 'claude' });
  });

  it('renders without crashing', () => {
    const tree = renderer.create(<AgentConfigScreen />).toJSON();
    expect(tree).toBeTruthy();
  });

  it('shows loading indicator on mount', () => {
    const tree = renderer.create(<AgentConfigScreen />).toJSON();
    expect(hasText(tree, 'Loading configuration...')).toBe(true);
  });
});

// ============================================================================
// Budget Alerts Tests
// ============================================================================

describe('BudgetAlertsScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBudgetAlerts.isLoading = false;
    mockBudgetAlerts.alerts = [];
    mockBudgetAlerts.tier = 'pro';
    mockBudgetAlerts.error = null;
  });

  it('renders without crashing', () => {
    const tree = renderer.create(<BudgetAlertsScreen />).toJSON();
    expect(tree).toBeTruthy();
  });

  it('shows loading spinner when loading', () => {
    mockBudgetAlerts.isLoading = true;
    const tree = renderer.create(<BudgetAlertsScreen />).toJSON();
    expect(hasText(tree, 'Loading alerts...')).toBe(true);
  });

  it('shows empty state when no alerts for paid tier', () => {
    const tree = renderer.create(<BudgetAlertsScreen />).toJSON();
    expect(hasText(tree, 'No budget alerts yet')).toBe(true);
  });

  it('shows create alert button for paid tier', () => {
    const tree = renderer.create(<BudgetAlertsScreen />).toJSON();
    expect(hasText(tree, 'Create Alert')).toBe(true);
  });

  it('displays existing alerts', () => {
    mockBudgetAlerts.alerts = [
      {
        id: 'alert-1',
        name: 'Daily limit',
        threshold: 10.00,
        currentSpend: 5.00,
        percentUsed: 50,
        period: 'daily',
        action: 'notify',
        enabled: true,
        agentType: null,
      },
    ];
    const tree = renderer.create(<BudgetAlertsScreen />).toJSON();
    expect(hasText(tree, 'Daily limit')).toBe(true);
  });

  it('shows upgrade prompt for free tier', () => {
    // WHY: Jest runs with Babel caller platform:'ios', so Platform.OS === 'ios'.
    // canShowUpgradePrompt() returns false on iOS (Apple Reader App §3.1.3(a)),
    // so the upgrade button with 'Upgrade to Pro' label is never rendered.
    // The UpgradePrompt component always renders the 'INCLUDED WITH PRO' feature
    // list header on all platforms — assert that instead.
    mockBudgetAlerts.tier = 'free';
    const tree = renderer.create(<BudgetAlertsScreen />).toJSON();
    expect(hasText(tree, 'INCLUDED WITH PRO')).toBe(true);
  });
});

// ============================================================================
// Templates Tests
// ============================================================================

describe('TemplatesScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTemplates.isLoading = false;
    mockTemplates.templates = [];
    mockTemplates.error = null;
  });

  it('renders without crashing', () => {
    const tree = renderer.create(<TemplatesScreen />).toJSON();
    expect(tree).toBeTruthy();
  });

  it('shows loading spinner when loading', () => {
    mockTemplates.isLoading = true;
    const tree = renderer.create(<TemplatesScreen />).toJSON();
    expect(hasText(tree, 'Loading templates...')).toBe(true);
  });

  it('shows empty state when no templates', () => {
    const tree = renderer.create(<TemplatesScreen />).toJSON();
    expect(hasText(tree, 'No templates yet')).toBe(true);
  });

  it('renders without error when templates exist', () => {
    mockTemplates.templates = [
      {
        id: 'tmpl-1',
        user_id: 'test-user-id',
        name: 'Code Review',
        content: 'Review this code for bugs...',
        is_default: true,
        is_system: false,
        category: 'review',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];
    const tree = renderer.create(<TemplatesScreen />).toJSON();
    expect(tree).toBeTruthy();
  });
});

// ============================================================================
// Session Detail Tests
// ============================================================================

describe('SessionDetailScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(mockLocalSearchParams, { id: 'sess-123' });
  });

  it('renders without crashing', () => {
    const tree = renderer.create(<SessionDetailScreen />).toJSON();
    expect(tree).toBeTruthy();
  });

  it('shows loading indicator on mount', () => {
    const tree = renderer.create(<SessionDetailScreen />).toJSON();
    expect(hasText(tree, 'Loading session...')).toBe(true);
  });
});
