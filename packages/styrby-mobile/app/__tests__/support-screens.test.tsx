/**
 * Support Screens Render Tests
 *
 * Validates that support-related screens render correctly.
 * Uses react-test-renderer (node environment, no DOM).
 *
 * Screens covered:
 * - Support Index (support/index.tsx)
 * - Support Ticket Detail (support/[id].tsx)
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

jest.mock('expo-router', () => ({
  router: { push: mockRouterPush, replace: jest.fn(), back: jest.fn() },
  useRouter: () => ({ push: mockRouterPush, replace: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: jest.fn(() => ({ id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })),
  useFocusEffect: jest.fn(),
  Link: 'Link',
  Stack: {
    Screen: 'StackScreen',
  },
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

jest.mock('styrby-shared', () => ({}));

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
      const methods = ['select', 'eq', 'order', 'limit', 'single', 'insert'];
      for (const m of methods) chain[m] = jest.fn(() => chain);
      chain.then = (r: (v: unknown) => void) => Promise.resolve({ data: null, error: null }).then(r);
      return chain;
    }),
    channel: jest.fn(() => ({
      on: jest.fn().mockReturnThis(),
      subscribe: jest.fn(),
    })),
    removeChannel: jest.fn(),
  },
}));

// ============================================================================
// Hook Mocks — useSupport
// ============================================================================

const mockTicketData = {
  ticket: null as {
    id: string;
    user_id: string;
    type: string;
    subject: string;
    description: string;
    status: string;
    priority: string;
    created_at: string;
    updated_at: string;
  } | null,
  replies: [] as Array<{
    id: string;
    ticket_id: string;
    user_id: string;
    body: string;
    is_admin: boolean;
    created_at: string;
  }>,
};

const mockSupport = {
  // Support index screen uses these
  tickets: [] as Array<{
    id: string;
    user_id: string;
    type: string;
    subject: string;
    description: string;
    status: string;
    created_at: string;
    updated_at: string;
  }>,
  isLoading: false,
  isSubmitting: false,
  error: null as string | null,
  refresh: jest.fn(async () => {}),
  createTicket: jest.fn(async () => ({ id: 'new-ticket-id' })),
  // Support detail screen uses these
  getTicket: jest.fn(async () => mockTicketData.ticket ? mockTicketData : null),
  replyToTicket: jest.fn(async () => true),
  subscribeToReplies: jest.fn(() => jest.fn()),
};

jest.mock('@/hooks/useSupport', () => ({
  useSupport: jest.fn(() => mockSupport),
}));

// -- Schemas --
jest.mock('@/lib/schemas', () => ({
  createTicketInputSchema: {
    parse: jest.fn((v: unknown) => v),
  },
}));

// ============================================================================
// Imports (after mocks)
// ============================================================================

import SupportIndexScreen from '../support/index';
import SupportDetailScreen from '../support/[id]';

// ============================================================================
// Support Index Screen Tests
// ============================================================================

describe('SupportIndexScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSupport.isLoading = false;
    mockSupport.tickets = [];
    mockSupport.error = null;
  });

  it('renders without crashing', () => {
    const tree = renderer.create(<SupportIndexScreen />).toJSON();
    expect(tree).toBeTruthy();
  });

  it('renders in loading state without error', () => {
    mockSupport.isLoading = true;
    const tree = renderer.create(<SupportIndexScreen />).toJSON();
    // Loading shows ActivityIndicator (no text), but should not crash
    expect(tree).toBeTruthy();
  });

  it('shows empty state when no tickets', () => {
    const tree = renderer.create(<SupportIndexScreen />).toJSON();
    expect(hasText(tree, 'No support tickets')).toBe(true);
  });

  it('displays existing tickets', () => {
    mockSupport.tickets = [
      {
        id: 'ticket-1',
        user_id: 'test-user-id',
        type: 'bug',
        subject: 'App crashes on launch',
        description: 'The app crashes when I open it',
        status: 'open',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];
    const tree = renderer.create(<SupportIndexScreen />).toJSON();
    expect(hasText(tree, 'App crashes on launch')).toBe(true);
  });

  it('shows status badge on tickets', () => {
    mockSupport.tickets = [
      {
        id: 'ticket-1',
        user_id: 'test-user-id',
        type: 'feature',
        subject: 'Add dark mode',
        description: 'Want dark mode',
        status: 'open',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];
    const tree = renderer.create(<SupportIndexScreen />).toJSON();
    expect(hasText(tree, 'Open')).toBe(true);
  });

  it('shows error banner when error exists', () => {
    mockSupport.error = 'Network error';
    const tree = renderer.create(<SupportIndexScreen />).toJSON();
    expect(hasText(tree, 'Network error')).toBe(true);
  });
});

// ============================================================================
// Support Detail Screen Tests
// ============================================================================

describe('SupportDetailScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTicketData.ticket = null;
    mockTicketData.replies = [];
  });

  it('renders without crashing', () => {
    const tree = renderer.create(<SupportDetailScreen />).toJSON();
    expect(tree).toBeTruthy();
  });

  it('renders loading state on mount', () => {
    // On mount, isLoading = true, shows ActivityIndicator
    const tree = renderer.create(<SupportDetailScreen />).toJSON();
    expect(tree).toBeTruthy();
  });

  it('displays ticket details after loading', async () => {
    mockTicketData.ticket = {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      user_id: 'test-user-id',
      type: 'bug',
      subject: 'Login broken',
      description: 'Cannot log in with GitHub OAuth',
      status: 'in_progress',
      priority: 'high',
      created_at: '2026-03-25T10:00:00Z',
      updated_at: '2026-03-25T12:00:00Z',
    };
    let component: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      component = renderer.create(<SupportDetailScreen />);
    });
    const tree = component!.toJSON();
    expect(hasText(tree, 'Login broken')).toBe(true);
    expect(hasText(tree, 'Cannot log in with GitHub OAuth')).toBe(true);
  });

  it('calls getTicket on mount with valid UUID', async () => {
    mockTicketData.ticket = null;
    await renderer.act(async () => {
      renderer.create(<SupportDetailScreen />);
    });
    expect(mockSupport.getTicket).toHaveBeenCalledWith('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
  });
});
