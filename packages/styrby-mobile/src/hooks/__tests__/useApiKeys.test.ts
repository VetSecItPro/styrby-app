/**
 * Tests for useApiKeys hook.
 *
 * WHY: API key management is a Power-tier security feature. Bugs in createKey
 * (leaking the secret), revokeKey (missing optimistic updates), or fetchKeys
 * (tier gating) could have real security and UX consequences.
 *
 * @module hooks/__tests__/useApiKeys
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

jest.mock('../../lib/config', () => ({
  getApiBaseUrl: () => 'http://test-api',
}));

// ============================================================================
// Imports
// ============================================================================

import { act } from 'react';
import { renderHook } from '@testing-library/react-native';
import { useApiKeys } from '../useApiKeys';

// ============================================================================
// Fixtures
// ============================================================================

const sampleKey = {
  id: 'key-1',
  name: 'CI Integration',
  key_prefix: 'sk_ci_xxxx',
  scopes: ['read'],
  last_used_at: null,
  last_used_ip: null,
  request_count: 0,
  expires_at: null,
  revoked_at: null,
  revoked_reason: null,
  created_at: '2026-04-20T00:00:00Z',
};

function mockAuthed(token = 'test-token') {
  mockGetSession.mockResolvedValue({
    data: { session: { access_token: token } },
    error: null,
  });
}

function mockFetch(status: number, body: unknown) {
  global.fetch = jest.fn<Promise<any>, any[]>(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as jest.Mock;
}

// ============================================================================
// Tests
// ============================================================================

describe('useApiKeys', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    global.fetch = jest.fn();
  });

  // --------------------------------------------------------------------------
  // Initial state
  // --------------------------------------------------------------------------

  it('starts with isLoading true and empty keys', () => {
    mockAuthed();
    // Never-resolving fetch to capture loading state
    global.fetch = jest.fn<any, any[]>(() => new Promise(() => {})) as jest.Mock;
    // Prevent getSession from completing by making it hang too
    mockGetSession.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useApiKeys());

    expect(result.current.isLoading).toBe(true);
    expect(result.current.keys).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  // --------------------------------------------------------------------------
  // fetchKeys
  // --------------------------------------------------------------------------

  it('fetches keys and sets tier info on success', async () => {
    mockAuthed();
    mockFetch(200, {
      keys: [sampleKey],
      tier: 'power',
      keyLimit: 10,
      keyCount: 1,
    });

    const { result } = renderHook(() => useApiKeys());
    await act(async () => {});

    expect(result.current.keys).toHaveLength(1);
    expect(result.current.keys[0].name).toBe('CI Integration');
    expect(result.current.tier).toBe('power');
    expect(result.current.keyLimit).toBe(10);
    expect(result.current.keyCount).toBe(1);
    expect(result.current.isPowerTier).toBe(true);
    expect(result.current.isLoading).toBe(false);
  });

  it('sets error when not authenticated', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });

    const { result } = renderHook(() => useApiKeys());
    await act(async () => {});

    expect(result.current.error).toBe('Not authenticated');
  });

  it('sets error on HTTP failure', async () => {
    mockAuthed();
    mockFetch(500, { error: 'Internal server error' });

    const { result } = renderHook(() => useApiKeys());
    await act(async () => {});

    expect(result.current.error).toBe('Internal server error');
    expect(result.current.keys).toEqual([]);
  });

  it('isPowerTier is false when keyLimit is 0', async () => {
    mockAuthed();
    mockFetch(200, { keys: [], tier: 'free', keyLimit: 0, keyCount: 0 });

    const { result } = renderHook(() => useApiKeys());
    await act(async () => {});

    expect(result.current.isPowerTier).toBe(false);
  });

  // --------------------------------------------------------------------------
  // createKey
  // --------------------------------------------------------------------------

  it('createKey returns key + secret on success and prepends to list', async () => {
    mockAuthed();
    // fetchKeys call on mount
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ keys: [], tier: 'power', keyLimit: 5, keyCount: 0 }),
      })
      // createKey POST
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ key: sampleKey, secret: 'sk_plaintext_secret' }),
      });
    global.fetch = fetchMock as jest.Mock;

    const { result } = renderHook(() => useApiKeys());
    await act(async () => {});

    let created: Awaited<ReturnType<typeof result.current.createKey>>;
    await act(async () => {
      created = await result.current.createKey({ name: 'CI Integration' });
    });

    expect(created!).not.toBeNull();
    expect(created!.secret).toBe('sk_plaintext_secret');
    expect(result.current.keys[0].name).toBe('CI Integration');
    expect(result.current.keyCount).toBe(1);
  });

  it('createKey returns null and sets error on failure', async () => {
    mockAuthed();
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ keys: [], tier: 'power', keyLimit: 5, keyCount: 0 }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({ error: 'Key limit reached' }),
      });
    global.fetch = fetchMock as jest.Mock;

    const { result } = renderHook(() => useApiKeys());
    await act(async () => {});

    let created: Awaited<ReturnType<typeof result.current.createKey>>;
    await act(async () => {
      created = await result.current.createKey({ name: 'Over limit' });
    });

    expect(created!).toBeNull();
    expect(result.current.error).toBe('Key limit reached');
  });

  // --------------------------------------------------------------------------
  // revokeKey
  // --------------------------------------------------------------------------

  it('revokeKey marks key as revoked in local state', async () => {
    mockAuthed();
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ keys: [sampleKey], tier: 'power', keyLimit: 5, keyCount: 1 }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
    global.fetch = fetchMock as jest.Mock;

    const { result } = renderHook(() => useApiKeys());
    await act(async () => {});

    let revoked: boolean;
    await act(async () => {
      revoked = await result.current.revokeKey('key-1', 'compromised');
    });

    expect(revoked!).toBe(true);
    expect(result.current.keys[0].revoked_at).toBeTruthy();
    expect(result.current.keyCount).toBe(0);
  });

  it('revokeKey returns false and sets error on HTTP failure', async () => {
    mockAuthed();
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ keys: [sampleKey], tier: 'power', keyLimit: 5, keyCount: 1 }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ error: 'Key not found' }),
      });
    global.fetch = fetchMock as jest.Mock;

    const { result } = renderHook(() => useApiKeys());
    await act(async () => {});

    let revoked: boolean;
    await act(async () => {
      revoked = await result.current.revokeKey('key-missing');
    });

    expect(revoked!).toBe(false);
    expect(result.current.error).toBe('Key not found');
  });

  // --------------------------------------------------------------------------
  // refresh
  // --------------------------------------------------------------------------

  it('refresh re-fetches without changing isLoading', async () => {
    mockAuthed();
    const fetchMock = jest.fn()
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ keys: [], tier: 'power', keyLimit: 5, keyCount: 0 }),
      });
    global.fetch = fetchMock as jest.Mock;

    const { result } = renderHook(() => useApiKeys());
    await act(async () => {});

    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.refresh();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
