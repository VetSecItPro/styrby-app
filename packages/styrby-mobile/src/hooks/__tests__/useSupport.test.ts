/**
 * useSupport Hook Test Suite
 *
 * Tests the support ticket management hook, including:
 * - Fetching ticket list
 * - Creating new tickets with Zod validation
 * - Replying to tickets
 * - getTicket with auth check
 * - Error handling
 */

import { renderHook, act, waitFor } from '@testing-library/react-native';

// ============================================================================
// Mock Setup
// ============================================================================

let mockAuthUser: { id: string } | null = { id: 'test-user-id' };
let mockQueryResults: Record<string, { data: unknown; error: unknown }> = {};

jest.mock('@/lib/supabase', () => {
  const createChain = (table: string) => {
    const getResult = () =>
      mockQueryResults[table] || { data: null, error: null };

    const chain: Record<string, unknown> = {};
    const chainMethods = ['select', 'eq', 'order', 'insert', 'limit'];
    for (const method of chainMethods) {
      chain[method] = jest.fn(() => chain);
    }
    chain.single = jest.fn(() => Promise.resolve(getResult()));
    chain.maybeSingle = jest.fn(() => Promise.resolve(getResult()));
    chain.then = (resolve: (v: unknown) => void) =>
      Promise.resolve(getResult()).then(resolve);
    return chain;
  };

  return {
    supabase: {
      auth: {
        getUser: jest.fn(async () => ({
          data: { user: mockAuthUser },
          error: null,
        })),
      },
      from: jest.fn((table: string) => createChain(table)),
      channel: jest.fn(() => ({
        on: jest.fn().mockReturnThis(),
        subscribe: jest.fn(),
      })),
      removeChannel: jest.fn(),
    },
  };
});

jest.mock('styrby-shared', () => ({}));

import { useSupport } from '../useSupport';
import { supabase } from '@/lib/supabase';

// ============================================================================
// Test Data
// ============================================================================

const validTicket = {
  id: 'ticket-1',
  user_id: 'test-user-id',
  type: 'bug',
  subject: 'App crashes',
  description: 'The app crashes on launch',
  priority: 'high',
  status: 'open',
  screenshot_urls: [],
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

const validReply = {
  id: 'reply-1',
  ticket_id: 'ticket-1',
  author_type: 'user',
  author_id: 'test-user-id',
  message: 'Thanks for looking into this.',
  created_at: '2024-01-02T00:00:00Z',
};

// ============================================================================
// Tests
// ============================================================================

describe('useSupport', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthUser = { id: 'test-user-id' };
    mockQueryResults = {
      support_tickets: { data: [validTicket], error: null },
      support_ticket_replies: { data: [validReply], error: null },
    };
  });

  // --------------------------------------------------------------------------
  // Fetch Tickets
  // --------------------------------------------------------------------------

  it('fetches tickets on mount', async () => {
    const { result } = renderHook(() => useSupport());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.tickets).toHaveLength(1);
    expect(result.current.tickets[0].id).toBe('ticket-1');
    expect(result.current.error).toBeNull();
  });

  it('sets error when user is not authenticated', async () => {
    mockAuthUser = null;

    const { result } = renderHook(() => useSupport());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBe('You must be signed in to view support tickets.');
    expect(result.current.tickets).toHaveLength(0);
  });

  it('handles query errors gracefully', async () => {
    mockQueryResults = {
      support_tickets: {
        data: null,
        error: { message: 'Database connection failed' },
      },
    };

    const { result } = renderHook(() => useSupport());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBe('Database connection failed');
  });

  // --------------------------------------------------------------------------
  // Create Ticket
  // --------------------------------------------------------------------------

  it('creates a ticket successfully', async () => {
    // The hook loads tickets on mount (uses .then/thenable), then createTicket
    // calls .insert().select().single() which resolves via single().
    // Our mock returns the same result for both paths on the same table,
    // so we set it to a single object that works for .single() calls.
    // The initial load via .then will parse it with safeParseArray,
    // which handles non-array input by returning [].
    mockQueryResults = {
      support_tickets: { data: validTicket, error: null },
    };

    const { result } = renderHook(() => useSupport());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let createdTicket: unknown = null;
    await act(async () => {
      createdTicket = await result.current.createTicket({
        type: 'bug',
        subject: 'New bug report',
        description: 'This is a detailed bug description for testing.',
      });
    });

    expect(createdTicket).not.toBeNull();
    expect(result.current.isSubmitting).toBe(false);
  });

  it('rejects ticket with short subject', async () => {
    const { result } = renderHook(() => useSupport());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let createdTicket: unknown = null;
    await act(async () => {
      createdTicket = await result.current.createTicket({
        type: 'bug',
        subject: 'Hi',
        description: 'This is a valid description for the ticket.',
      });
    });

    expect(createdTicket).toBeNull();
    expect(result.current.error).toContain('Subject must be at least 3 characters');
  });

  it('rejects ticket with short description', async () => {
    const { result } = renderHook(() => useSupport());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let createdTicket: unknown = null;
    await act(async () => {
      createdTicket = await result.current.createTicket({
        type: 'bug',
        subject: 'Valid subject',
        description: 'Short.',
      });
    });

    expect(createdTicket).toBeNull();
    expect(result.current.error).toContain('Description must be at least 10 characters');
  });

  // --------------------------------------------------------------------------
  // Reply to Ticket
  // --------------------------------------------------------------------------

  it('creates a reply successfully', async () => {
    mockQueryResults = {
      support_tickets: { data: [validTicket], error: null },
      support_ticket_replies: { data: validReply, error: null },
    };

    const { result } = renderHook(() => useSupport());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let reply: unknown = null;
    await act(async () => {
      reply = await result.current.replyToTicket('ticket-1', 'Thanks for the update!');
    });

    expect(reply).not.toBeNull();
  });

  it('rejects empty reply message', async () => {
    const { result } = renderHook(() => useSupport());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let reply: unknown = null;
    await act(async () => {
      reply = await result.current.replyToTicket('ticket-1', '   ');
    });

    expect(reply).toBeNull();
    expect(result.current.error).toBe('Reply message cannot be empty.');
  });

  it('rejects reply message exceeding 5000 characters', async () => {
    const { result } = renderHook(() => useSupport());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let reply: unknown = null;
    await act(async () => {
      reply = await result.current.replyToTicket('ticket-1', 'x'.repeat(5001));
    });

    expect(reply).toBeNull();
    expect(result.current.error).toBe('Reply message must be at most 5000 characters.');
  });

  // --------------------------------------------------------------------------
  // Get Single Ticket
  // --------------------------------------------------------------------------

  it('returns null when user is not authenticated for getTicket', async () => {
    const { result } = renderHook(() => useSupport());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Switch to unauthenticated after initial load
    mockAuthUser = null;

    let ticket: unknown = null;
    await act(async () => {
      ticket = await result.current.getTicket('ticket-1');
    });

    expect(ticket).toBeNull();
  });

  it('fetches ticket with replies successfully', async () => {
    mockQueryResults = {
      support_tickets: { data: validTicket, error: null },
      support_ticket_replies: { data: [validReply], error: null },
    };

    const { result } = renderHook(() => useSupport());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let ticketResult: unknown = null;
    await act(async () => {
      ticketResult = await result.current.getTicket('ticket-1');
    });

    expect(ticketResult).not.toBeNull();
  });

  // --------------------------------------------------------------------------
  // Refresh
  // --------------------------------------------------------------------------

  it('refresh reloads ticket list', async () => {
    const { result } = renderHook(() => useSupport());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const fromCalls = (supabase.from as jest.Mock).mock.calls.length;

    await act(async () => {
      await result.current.refresh();
    });

    // Should have made additional calls to supabase.from
    expect((supabase.from as jest.Mock).mock.calls.length).toBeGreaterThan(fromCalls);
  });
});
