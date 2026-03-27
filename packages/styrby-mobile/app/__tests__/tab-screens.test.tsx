/**
 * Tab Screens Render Tests
 *
 * Validates that all tab screens render without crashing in key states:
 * loading, data, empty, and error. Uses react-test-renderer since the
 * jest environment is node (no DOM, no jsdom).
 *
 * Screens covered:
 * - Dashboard (index.tsx)
 * - Sessions (sessions.tsx)
 * - Costs (costs.tsx)
 * - Team (team.tsx)
 */

import React from 'react';
import renderer from 'react-test-renderer';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Recursively collects all text content from a react-test-renderer JSON tree.
 *
 * @param node - The JSON tree node
 * @returns Array of string text values found
 */
function collectText(node: renderer.ReactTestRendererJSON | renderer.ReactTestRendererJSON[] | null): string[] {
  if (!node) return [];
  if (Array.isArray(node)) return node.flatMap(collectText);
  const texts: string[] = [];
  if (typeof node === 'string') return [node];
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

/**
 * Check if any text in the rendered tree contains the given substring.
 *
 * @param tree - react-test-renderer JSON output
 * @param text - The text to search for
 * @returns true if found
 */
function hasText(tree: renderer.ReactTestRendererJSON | renderer.ReactTestRendererJSON[] | null, text: string): boolean {
  return collectText(tree).some((t) => t.includes(text));
}

/**
 * Check if any text in the rendered tree matches the given regex.
 *
 * @param tree - react-test-renderer JSON output
 * @param pattern - The regex to match
 * @returns true if found
 */
function hasTextMatch(tree: renderer.ReactTestRendererJSON | renderer.ReactTestRendererJSON[] | null, pattern: RegExp): boolean {
  return collectText(tree).some((t) => pattern.test(t));
}

// ============================================================================
// Global Mocks — must be declared before component imports
// ============================================================================

// -- expo-router --
const mockRouterPush = jest.fn();
const mockRouterReplace = jest.fn();

jest.mock('expo-router', () => ({
  router: { push: mockRouterPush, replace: mockRouterReplace, back: jest.fn() },
  useRouter: () => ({ push: mockRouterPush, replace: mockRouterReplace, back: jest.fn() }),
  useLocalSearchParams: jest.fn(() => ({})),
  useFocusEffect: jest.fn((cb: () => void) => cb()),
  Link: 'Link',
  Tabs: 'Tabs',
  Stack: 'Stack',
}));

// -- @expo/vector-icons --
jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

// -- expo-constants --
jest.mock('expo-constants', () => ({
  expoConfig: { version: '1.0.0', ios: { buildNumber: '42' } },
}));

// -- styrby-shared --
jest.mock('styrby-shared', () => ({
  decodePairingUrl: jest.fn(),
  isPairingExpired: jest.fn(() => false),
}));

// -- Supabase client --
const mockGetUser = jest.fn(async () => ({
  data: { user: { id: 'test-user-id', email: 'test@example.com', user_metadata: { display_name: 'Test User' } } },
  error: null,
}));

const mockSupabaseChain = () => {
  const chain: Record<string, unknown> = {};
  const methods = ['select', 'eq', 'order', 'gte', 'limit', 'not', 'single', 'insert', 'update', 'delete', 'upsert'];
  for (const m of methods) {
    chain[m] = jest.fn(() => chain);
  }
  chain.then = (resolve: (v: unknown) => void) =>
    Promise.resolve({ data: null, error: null }).then(resolve);
  return chain;
};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getUser: mockGetUser,
      signOut: jest.fn(async () => ({ error: null })),
      onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
    },
    from: jest.fn(() => mockSupabaseChain()),
    channel: jest.fn(() => ({
      on: jest.fn().mockReturnThis(),
      subscribe: jest.fn(),
    })),
    removeChannel: jest.fn(),
  },
  signOut: jest.fn(async () => {}),
}));

// -- Pairing service --
jest.mock('@/services/pairing', () => ({
  isPaired: jest.fn(async () => false),
  clearPairingInfo: jest.fn(async () => {}),
  executePairing: jest.fn(async () => ({ success: true })),
}));

// ============================================================================
// Hook Mocks
// ============================================================================

const mockRelay = {
  isConnected: false,
  isOnline: true,
  isCliOnline: false,
  pairingInfo: null as Record<string, unknown> | null,
  pendingQueueCount: 0,
  connectedDevices: [],
  lastMessage: null,
  connect: jest.fn(async () => {}),
  sendMessage: jest.fn(async () => {}),
  savePairing: jest.fn(async () => {}),
};

jest.mock('@/hooks/useRelay', () => ({
  useRelay: jest.fn(() => mockRelay),
}));

const mockDashboardData = {
  activeSessions: [] as unknown[],
  notifications: [],
  agentStatus: {} as Record<string, unknown>,
  quickStats: { totalCostToday: 12.34, activeAgentCount: 2 },
  isLoading: false,
  refresh: jest.fn(async () => {}),
};

jest.mock('@/hooks/useDashboardData', () => ({
  useDashboardData: jest.fn(() => mockDashboardData),
}));

const mockOnboarding = {
  isComplete: true,
  isLoading: false,
  steps: [],
  completedCount: 5,
  totalCount: 5,
  tier: 'pro' as const,
  markComplete: jest.fn(async () => {}),
  refresh: jest.fn(async () => {}),
};

jest.mock('@/hooks/useOnboarding', () => ({
  useOnboarding: jest.fn(() => mockOnboarding),
}));

const mockSessions = {
  sessions: [] as unknown[],
  isLoading: false,
  isRefreshing: false,
  isLoadingMore: false,
  hasMore: false,
  error: null as string | null,
  searchQuery: '',
  filters: { status: null, agent: null, scope: null, teamId: null },
  isRealtimeConnected: true,
  setSearchQuery: jest.fn(),
  setFilters: jest.fn(),
  refresh: jest.fn(async () => {}),
  loadMore: jest.fn(),
};

jest.mock('@/hooks/useSessions', () => ({
  useSessions: jest.fn(() => mockSessions),
  formatRelativeTime: jest.fn(() => '5m ago'),
  getFirstLine: jest.fn((s: string | null) => s || ''),
}));

const mockCostData = {
  today: { totalCost: 5.67, requestCount: 42, inputTokens: 10000, outputTokens: 5000 },
  week: { totalCost: 25.00, requestCount: 200, inputTokens: 50000, outputTokens: 25000 },
  month: { totalCost: 100.00, requestCount: 800, inputTokens: 200000, outputTokens: 100000 },
  quarter: { totalCost: 250.00, requestCount: 2000, inputTokens: 500000, outputTokens: 250000 },
  byAgent: [{ agent: 'claude', cost: 5.67, percentage: 100, requestCount: 42 }],
  byModel: [],
  byTag: [],
  dailyCosts: [],
};

const mockCosts = {
  data: mockCostData as typeof mockCostData | null,
  isLoading: false,
  isRefreshing: false,
  error: null as string | null,
  refresh: jest.fn(async () => {}),
  timeRange: 30 as const,
  setTimeRange: jest.fn(),
  isRealtimeConnected: true,
};

jest.mock('@/hooks/useCosts', () => ({
  useCosts: jest.fn(() => mockCosts),
  formatCost: jest.fn((v: number) => `$${v.toFixed(2)}`),
  formatTokens: jest.fn((v: number) => `${(v / 1000).toFixed(1)}K`),
}));

const mockBudgetAlerts = {
  alerts: [] as unknown[],
  tier: 'pro' as const,
  isLoading: false,
  isMutating: false,
  error: null,
  refresh: jest.fn(),
  createAlert: jest.fn(),
  toggleAlert: jest.fn(),
  deleteAlert: jest.fn(),
};

jest.mock('@/hooks/useBudgetAlerts', () => ({
  useBudgetAlerts: jest.fn(() => mockBudgetAlerts),
  getAlertProgressColor: jest.fn(() => '#22c55e'),
  getPeriodLabel: jest.fn(() => 'monthly'),
  getActionLabel: jest.fn(() => 'Notify'),
  getActionDescription: jest.fn(() => 'Send a notification'),
  getActionBadgeColor: jest.fn(() => ({ bg: '#eab308', text: '#fff' })),
  getAgentScopeLabel: jest.fn(() => 'All agents'),
}));

const mockTeamManagement = {
  team: null as { id: string; name: string; description: string | null } | null,
  currentUserRole: null as string | null,
  members: [] as Array<{
    member_id: string;
    user_id: string;
    email: string;
    display_name: string | null;
    role: string;
  }>,
  invitations: [] as unknown[],
  isLoading: false,
  isMutating: false,
  error: null as string | null,
  currentUserId: 'test-user-id',
  createTeam: jest.fn(async () => {}),
  updateMemberRole: jest.fn(async () => true),
  removeMember: jest.fn(async () => true),
  refresh: jest.fn(async () => {}),
};

jest.mock('@/hooks/useTeamManagement', () => ({
  useTeamManagement: jest.fn(() => mockTeamManagement),
}));

// -- Components used by screens --
jest.mock('@/components/SessionCarousel', () => ({
  SessionCarousel: 'SessionCarousel',
}));

jest.mock('@/components/NotificationStream', () => ({
  NotificationStream: 'NotificationStream',
}));

jest.mock('@/components/OnboardingModal', () => ({
  OnboardingModal: 'OnboardingModal',
}));

jest.mock('@/components/CostCard', () => ({
  CostCard: 'CostCard',
}));

jest.mock('@/components/AgentCostBar', () => ({
  AgentCostBar: 'AgentCostBar',
  AgentCostBarEmpty: 'AgentCostBarEmpty',
}));

jest.mock('@/components/DailyMiniChart', () => ({
  DailyMiniChart: 'DailyMiniChart',
  DailyMiniChartEmpty: 'DailyMiniChartEmpty',
}));

// ============================================================================
// Imports (after mocks)
// ============================================================================

import DashboardScreen from '../(tabs)/index';
import SessionsScreen from '../(tabs)/sessions';
import CostsScreen from '../(tabs)/costs';
import TeamScreen from '../(tabs)/team';

// ============================================================================
// Dashboard Tests
// ============================================================================

describe('DashboardScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDashboardData.isLoading = false;
    mockDashboardData.activeSessions = [];
    mockDashboardData.quickStats = { totalCostToday: 12.34, activeAgentCount: 2 };
    mockOnboarding.isComplete = true;
    mockRelay.isConnected = false;
    mockRelay.pairingInfo = null;
  });

  it('renders without crashing', () => {
    const tree = renderer.create(<DashboardScreen />).toJSON();
    expect(tree).toBeTruthy();
  });

  it('displays quick stats with cost and agent count', () => {
    const tree = renderer.create(<DashboardScreen />).toJSON();
    // WHY: JSX template literals split into separate text children (e.g., "$" + "12.34")
    expect(hasText(tree, '12.34')).toBe(true);
    expect(hasText(tree, '2')).toBe(true);
    expect(hasText(tree, 'Total spend')).toBe(true);
    expect(hasText(tree, 'Active agents')).toBe(true);
  });

  it('shows "Not paired" when no pairing info exists', () => {
    const tree = renderer.create(<DashboardScreen />).toJSON();
    expect(hasText(tree, 'Not paired')).toBe(true);
  });

  it('shows "Connected to CLI" when relay is connected and CLI is online', () => {
    mockRelay.isConnected = true;
    mockRelay.isCliOnline = true;
    mockRelay.pairingInfo = { channelId: 'test' };
    const tree = renderer.create(<DashboardScreen />).toJSON();
    expect(hasText(tree, 'Connected to CLI')).toBe(true);
  });

  it('shows agent cards for Claude, Codex, and Gemini', () => {
    const tree = renderer.create(<DashboardScreen />).toJSON();
    expect(hasText(tree, 'Claude Code')).toBe(true);
    expect(hasText(tree, 'Codex CLI')).toBe(true);
    expect(hasText(tree, 'Gemini CLI')).toBe(true);
  });

  it('shows NOTIFICATIONS section header', () => {
    const tree = renderer.create(<DashboardScreen />).toJSON();
    expect(hasText(tree, 'NOTIFICATIONS')).toBe(true);
  });

  it('shows onboarding banner when onboarding is incomplete', () => {
    mockOnboarding.isComplete = false;
    mockOnboarding.isLoading = false;
    mockOnboarding.completedCount = 2;
    mockOnboarding.totalCount = 5;
    const tree = renderer.create(<DashboardScreen />).toJSON();
    expect(hasText(tree, 'Complete setup')).toBe(true);
    // WHY: JSX "{count}/{total} steps done" splits into separate text children
    expect(hasText(tree, 'steps done')).toBe(true);
  });

  it('hides onboarding banner when onboarding is complete', () => {
    mockOnboarding.isComplete = true;
    const tree = renderer.create(<DashboardScreen />).toJSON();
    expect(hasText(tree, 'Complete setup')).toBe(false);
  });

  it('shows "Disconnected" when relay is connected but not CLI', () => {
    mockRelay.isConnected = false;
    mockRelay.pairingInfo = { channelId: 'test' };
    const tree = renderer.create(<DashboardScreen />).toJSON();
    expect(hasText(tree, 'Disconnected')).toBe(true);
  });

  it('shows TODAY section', () => {
    const tree = renderer.create(<DashboardScreen />).toJSON();
    expect(hasText(tree, 'TODAY')).toBe(true);
  });

  it('shows AGENTS section', () => {
    const tree = renderer.create(<DashboardScreen />).toJSON();
    expect(hasText(tree, 'AGENTS')).toBe(true);
  });
});

// ============================================================================
// Sessions Tests
// ============================================================================

describe('SessionsScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSessions.isLoading = false;
    mockSessions.sessions = [];
    mockSessions.error = null;
    mockSessions.searchQuery = '';
    mockSessions.filters = { status: null, agent: null, scope: null, teamId: null };
  });

  it('renders without crashing', () => {
    const tree = renderer.create(<SessionsScreen />).toJSON();
    expect(tree).toBeTruthy();
  });

  it('shows loading spinner when isLoading is true', () => {
    mockSessions.isLoading = true;
    const tree = renderer.create(<SessionsScreen />).toJSON();
    expect(hasText(tree, 'Loading sessions...')).toBe(true);
  });

  it('shows error state with retry button', () => {
    mockSessions.error = 'Network timeout';
    const tree = renderer.create(<SessionsScreen />).toJSON();
    expect(hasText(tree, 'Failed to Load Sessions')).toBe(true);
    expect(hasText(tree, 'Network timeout')).toBe(true);
    expect(hasText(tree, 'Try Again')).toBe(true);
  });

  it('shows empty state when no sessions and no filters', () => {
    const tree = renderer.create(<SessionsScreen />).toJSON();
    expect(hasText(tree, 'No sessions yet')).toBe(true);
  });

  it('displays status filter chips', () => {
    const tree = renderer.create(<SessionsScreen />).toJSON();
    expect(hasText(tree, 'Active')).toBe(true);
    expect(hasText(tree, 'Completed')).toBe(true);
  });

  it('displays agent filter chips', () => {
    const tree = renderer.create(<SessionsScreen />).toJSON();
    expect(hasText(tree, 'Claude')).toBe(true);
    expect(hasText(tree, 'Codex')).toBe(true);
    expect(hasText(tree, 'Gemini')).toBe(true);
  });

  it('displays scope filter chips', () => {
    const tree = renderer.create(<SessionsScreen />).toJSON();
    expect(hasText(tree, 'My Sessions')).toBe(true);
    expect(hasText(tree, 'Team Sessions')).toBe(true);
  });

  it('renders sessions when data exists', () => {
    mockSessions.sessions = [
      {
        id: 'sess-1',
        user_id: 'test-user-id',
        machine_id: 'machine-1',
        agent_type: 'claude',
        status: 'stopped',
        title: 'Fix login bug',
        summary: 'Fixed the auth flow',
        total_cost_usd: '2.50',
        message_count: 10,
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        tags: [],
      },
    ];
    const tree = renderer.create(<SessionsScreen />).toJSON();
    expect(hasText(tree, 'Fix login bug')).toBe(true);
  });
});

// ============================================================================
// Costs Tests
// ============================================================================

describe('CostsScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCosts.isLoading = false;
    mockCosts.error = null;
    mockCosts.data = mockCostData;
  });

  it('renders without crashing', () => {
    const tree = renderer.create(<CostsScreen />).toJSON();
    expect(tree).toBeTruthy();
  });

  it('shows loading spinner when isLoading is true', () => {
    mockCosts.isLoading = true;
    const tree = renderer.create(<CostsScreen />).toJSON();
    expect(hasText(tree, 'Loading costs...')).toBe(true);
  });

  it('shows error state with retry button', () => {
    mockCosts.error = 'Failed to fetch';
    const tree = renderer.create(<CostsScreen />).toJSON();
    expect(hasText(tree, 'Failed to Load Costs')).toBe(true);
    expect(hasText(tree, 'Failed to fetch')).toBe(true);
    expect(hasText(tree, 'Try Again')).toBe(true);
  });

  it('displays SPENDING header', () => {
    const tree = renderer.create(<CostsScreen />).toJSON();
    expect(hasText(tree, 'SPENDING')).toBe(true);
  });

  it('displays time range selector', () => {
    const tree = renderer.create(<CostsScreen />).toJSON();
    expect(hasText(tree, '7D')).toBe(true);
    expect(hasText(tree, '30D')).toBe(true);
    expect(hasText(tree, '90D')).toBe(true);
  });

  it('displays BY AGENT section', () => {
    const tree = renderer.create(<CostsScreen />).toJSON();
    expect(hasText(tree, 'BY AGENT')).toBe(true);
  });

  it('displays TOKEN USAGE section', () => {
    const tree = renderer.create(<CostsScreen />).toJSON();
    expect(hasText(tree, 'TOKEN USAGE (MONTH)')).toBe(true);
  });

  it('displays BUDGET ALERTS section', () => {
    const tree = renderer.create(<CostsScreen />).toJSON();
    expect(hasText(tree, 'BUDGET ALERTS')).toBe(true);
  });

  it('shows "No cost data available" when data is null', () => {
    mockCosts.data = null;
    const tree = renderer.create(<CostsScreen />).toJSON();
    expect(hasText(tree, 'No cost data available')).toBe(true);
  });
});

// ============================================================================
// Team Tests
// ============================================================================

describe('TeamScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTeamManagement.isLoading = false;
    mockTeamManagement.team = null;
    mockTeamManagement.error = null;
    mockTeamManagement.members = [];
    mockTeamManagement.invitations = [];
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'test-user-id' } },
      error: null,
    });
  });

  it('renders without crashing', () => {
    const tree = renderer.create(<TeamScreen />).toJSON();
    expect(tree).toBeTruthy();
  });

  it('shows loading spinner when isLoading is true', () => {
    mockTeamManagement.isLoading = true;
    const tree = renderer.create(<TeamScreen />).toJSON();
    expect(hasText(tree, 'Loading team...')).toBe(true);
  });

  it('shows error state with retry button', async () => {
    mockTeamManagement.error = 'Database connection failed';
    let component: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      component = renderer.create(<TeamScreen />);
    });
    const tree = component!.toJSON();
    expect(hasText(tree, 'Failed to Load Team')).toBe(true);
    expect(hasText(tree, 'Database connection failed')).toBe(true);
    expect(hasText(tree, 'Try Again')).toBe(true);
  });

  it('shows upgrade prompt for free tier (async tier load)', async () => {
    mockTeamManagement.team = null;
    let component: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      component = renderer.create(<TeamScreen />);
    });
    const tree = component!.toJSON();
    expect(hasText(tree, 'Upgrade to Power')).toBe(true);
  });

  it('shows team header when team exists', async () => {
    mockTeamManagement.team = { id: 'team-1', name: 'Engineering', description: 'The eng team' };
    mockTeamManagement.currentUserRole = 'owner';
    mockTeamManagement.members = [
      {
        member_id: 'm-1',
        user_id: 'test-user-id',
        email: 'test@example.com',
        display_name: 'Test User',
        role: 'owner',
      },
    ];
    let component: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      component = renderer.create(<TeamScreen />);
    });
    const tree = component!.toJSON();
    expect(hasText(tree, 'Engineering')).toBe(true);
    expect(hasText(tree, 'The eng team')).toBe(true);
  });

  it('shows member count when team has members', async () => {
    mockTeamManagement.team = { id: 'team-1', name: 'Team', description: null };
    mockTeamManagement.currentUserRole = 'owner';
    mockTeamManagement.members = [
      {
        member_id: 'm-1',
        user_id: 'test-user-id',
        email: 'test@example.com',
        display_name: 'Test User',
        role: 'owner',
      },
    ];
    let component: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      component = renderer.create(<TeamScreen />);
    });
    const tree = component!.toJSON();
    // WHY: JSX "{count} member{suffix}" splits into separate text children
    expect(hasText(tree, 'member')).toBe(true);
  });
});
