/**
 * Tests for useBookmarks hook.
 *
 * WHY: Bookmarks use optimistic updates with rollback — bugs here mean UI
 * state gets out of sync with the server (e.g., shows bookmarked when it
 * isn't). The tier-limit enforcement also routes through this hook via the
 * web API, so error-path tests are critical.
 *
 * @module hooks/__tests__/useBookmarks
 */

// ============================================================================
// Module mocks
// ============================================================================

const mockGetSession = jest.fn();
jest.mock('../../lib/supabase', () => ({
  supabase: {
    auth: { getSession: (...args: unknown[]) => mockGetSession(...args) },
  },
}));

// ============================================================================
// Imports
// ============================================================================

import { act } from 'react';
import { renderHook } from '@testing-library/react-native';
import { useBookmarks } from '../useBookmarks';

// ============================================================================
// Helpers
// ============================================================================

function mockAuthed(token = 'test-token') {
  mockGetSession.mockResolvedValue({
    data: { session: { access_token: token } },
    error: null,
  });
}

function mockFetch(status: number, body: unknown) {
  global.fetch = jest.fn<unknown, unknown[]>(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as jest.Mock;
}

// ============================================================================
// Tests
// ============================================================================

describe('useBookmarks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(() => {
    global.fetch = jest.fn();
  });

  // --------------------------------------------------------------------------
  // Initial fetch
  // --------------------------------------------------------------------------

  it('starts with isLoading true and empty bookmarkedIds', () => {
    mockAuthed();
    global.fetch = jest.fn<unknown, unknown[]>(() => new Promise(() => {})) as jest.Mock;
    mockGetSession.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useBookmarks());

    expect(result.current.isLoading).toBe(true);
    expect(result.current.bookmarkedIds.size).toBe(0);
  });

  it('populates bookmarkedIds from fetch response', async () => {
    mockAuthed();
    mockFetch(200, { bookmarks: [{ session_id: 's-1' }, { session_id: 's-2' }] });

    const { result } = renderHook(() => useBookmarks());
    await act(async () => {});

    expect(result.current.isLoading).toBe(false);
    expect(result.current.bookmarkedIds.has('s-1')).toBe(true);
    expect(result.current.bookmarkedIds.has('s-2')).toBe(true);
    expect(result.current.fetchError).toBeNull();
  });

  it('sets fetchError when not authenticated', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });

    const { result } = renderHook(() => useBookmarks());
    await act(async () => {});

    expect(result.current.fetchError).toBe('Not authenticated');
    expect(result.current.isLoading).toBe(false);
  });

  it('sets fetchError on HTTP error', async () => {
    mockAuthed();
    mockFetch(500, { error: 'Server error' });

    const { result } = renderHook(() => useBookmarks());
    await act(async () => {});

    expect(result.current.fetchError).toContain('Server error');
  });

  // --------------------------------------------------------------------------
  // toggleBookmark — optimistic add
  // --------------------------------------------------------------------------

  it('toggleBookmark adds a bookmark optimistically before network', async () => {
    mockAuthed();
    // Mount fetch: no bookmarks
    let resolveToggle!: (v: unknown) => void;
    const togglePromise = new Promise((r) => { resolveToggle = r; });

    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ bookmarks: [] }),
      })
      .mockReturnValueOnce(togglePromise) as jest.Mock;

    const { result } = renderHook(() => useBookmarks());
    await act(async () => {});

    act(() => void result.current.toggleBookmark('s-new'));

    // Optimistic: already added before network resolves
    expect(result.current.bookmarkedIds.has('s-new')).toBe(true);
    expect(result.current.togglingIds.has('s-new')).toBe(true);

    // Resolve the network call
    await act(async () => {
      resolveToggle({ ok: true, status: 200, json: async () => ({}) });
    });

    expect(result.current.togglingIds.has('s-new')).toBe(false);
  });

  it('toggleBookmark removes a bookmark optimistically', async () => {
    mockAuthed();
    mockFetch(200, { bookmarks: [{ session_id: 's-1' }] });

    const { result } = renderHook(() => useBookmarks());
    await act(async () => {});

    expect(result.current.bookmarkedIds.has('s-1')).toBe(true);

    // Next fetch: DELETE success
    global.fetch = jest.fn<unknown, unknown[]>(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    })) as jest.Mock;

    await act(async () => {
      await result.current.toggleBookmark('s-1');
    });

    expect(result.current.bookmarkedIds.has('s-1')).toBe(false);
  });

  // --------------------------------------------------------------------------
  // toggleBookmark — rollback on failure
  // --------------------------------------------------------------------------

  it('reverts optimistic update on network failure', async () => {
    mockAuthed();
    mockFetch(200, { bookmarks: [] });

    const { result } = renderHook(() => useBookmarks());
    await act(async () => {});

    // Toggle fails
    global.fetch = jest.fn<unknown, unknown[]>(async () => ({
      ok: false,
      status: 429,
      json: async () => ({ error: 'Limit reached' }),
    })) as jest.Mock;

    await act(async () => {
      await result.current.toggleBookmark('s-bad');
    });

    // Should be rolled back
    expect(result.current.bookmarkedIds.has('s-bad')).toBe(false);
    expect(result.current.toggleErrors.has('s-bad')).toBe(true);
    expect(result.current.toggleErrors.get('s-bad')).toContain('Limit reached');
  });

  it('auto-clears toggle error after 4000ms', async () => {
    mockAuthed();
    mockFetch(200, { bookmarks: [] });

    const { result } = renderHook(() => useBookmarks());
    await act(async () => {});

    global.fetch = jest.fn<unknown, unknown[]>(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Oops' }),
    })) as jest.Mock;

    await act(async () => {
      await result.current.toggleBookmark('s-err');
    });

    expect(result.current.toggleErrors.has('s-err')).toBe(true);

    act(() => jest.advanceTimersByTime(4000));

    expect(result.current.toggleErrors.has('s-err')).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Double-tap guard: togglingIds prevents concurrent toggles
  // --------------------------------------------------------------------------

  it('togglingIds is populated while toggle is in-flight', async () => {
    mockAuthed();
    mockFetch(200, { bookmarks: [] });

    const { result } = renderHook(() => useBookmarks());
    await act(async () => {});

    let resolveToggle!: (v: unknown) => void;
    const hangingPromise = new Promise((r) => { resolveToggle = r; });
    global.fetch = jest.fn().mockReturnValue(hangingPromise) as jest.Mock;

    // Start toggle but do not await — in-flight
    act(() => void result.current.toggleBookmark('s-inflight'));

    expect(result.current.togglingIds.has('s-inflight')).toBe(true);

    // Resolve the network call
    await act(async () => {
      resolveToggle({ ok: true, status: 200, json: async () => ({}) });
    });

    expect(result.current.togglingIds.has('s-inflight')).toBe(false);
  });
});
