/**
 * Tests for useCurrentUser hook + extractUserInfo helper.
 *
 * WHY: useCurrentUser is the universal user-data source across all settings
 * sub-screens. extractUserInfo has branching logic for display_name vs
 * full_name vs email fallback — all branches need coverage.
 *
 * @module hooks/__tests__/useCurrentUser
 */

// ============================================================================
// Module mocks
// ============================================================================

const mockGetUser = jest.fn();
jest.mock('../../lib/supabase', () => ({
  supabase: {
    auth: { getUser: (...args: unknown[]) => mockGetUser(...args) },
  },
}));

// ============================================================================
// Imports
// ============================================================================

import { act } from 'react';
import { renderHook } from '@testing-library/react-native';
import { useCurrentUser, extractUserInfo } from '../useCurrentUser';

// ============================================================================
// extractUserInfo — pure function tests
// ============================================================================

describe('extractUserInfo', () => {
  it('uses display_name when set in user_metadata', () => {
    const info = extractUserInfo({
      id: 'u1',
      email: 'alice@test.com',
      user_metadata: { display_name: 'Alice' },
    });
    expect(info.displayName).toBe('Alice');
    expect(info.initial).toBe('A');
  });

  it('falls back to full_name when display_name is absent', () => {
    const info = extractUserInfo({
      id: 'u1',
      email: 'alice@test.com',
      user_metadata: { full_name: 'Bob Doe' },
    });
    expect(info.displayName).toBe('Bob Doe');
    expect(info.initial).toBe('B');
  });

  it('falls back to name when display_name and full_name are absent', () => {
    const info = extractUserInfo({
      id: 'u1',
      email: 'alice@test.com',
      user_metadata: { name: 'Carol' },
    });
    expect(info.displayName).toBe('Carol');
    expect(info.initial).toBe('C');
  });

  it('uses null displayName when no metadata name fields are present', () => {
    const info = extractUserInfo({
      id: 'u1',
      email: 'alice@test.com',
      user_metadata: {},
    });
    expect(info.displayName).toBeNull();
    expect(info.initial).toBe('A'); // from email
  });

  it('uses email initial when displayName is null', () => {
    const info = extractUserInfo({ id: 'u1', email: 'zoe@test.com' });
    expect(info.initial).toBe('Z');
  });

  it('uses unknown email fallback when email is undefined', () => {
    const info = extractUserInfo({ id: 'u1' });
    expect(info.email).toBe('unknown');
    expect(info.initial).toBe('U');
  });
});

// ============================================================================
// useCurrentUser hook tests
// ============================================================================

describe('useCurrentUser', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('starts with isLoading true and user null', () => {
    mockGetUser.mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderHook(() => useCurrentUser());
    expect(result.current.isLoading).toBe(true);
    expect(result.current.user).toBeNull();
  });

  it('returns CurrentUser on success', async () => {
    mockGetUser.mockResolvedValue({
      data: {
        user: {
          id: 'u-1',
          email: 'test@example.com',
          user_metadata: { display_name: 'Tester' },
        },
      },
      error: null,
    });

    const { result } = renderHook(() => useCurrentUser());
    await act(async () => {});

    expect(result.current.user).toMatchObject({
      id: 'u-1',
      email: 'test@example.com',
      displayName: 'Tester',
    });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('returns null user when auth returns no user', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: null,
    });

    const { result } = renderHook(() => useCurrentUser());
    await act(async () => {});

    expect(result.current.user).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('sets error on auth failure', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: new Error('Auth error'),
    });

    const { result } = renderHook(() => useCurrentUser());
    await act(async () => {});

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.user).toBeNull();
  });

  it('sets error when getUser throws', async () => {
    mockGetUser.mockRejectedValue(new Error('Network failure'));

    const { result } = renderHook(() => useCurrentUser());
    await act(async () => {});

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.user).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('refresh re-loads user data', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u-1', email: 'test@example.com', user_metadata: {} } },
      error: null,
    });

    const { result } = renderHook(() => useCurrentUser());
    await act(async () => {});

    expect(mockGetUser).toHaveBeenCalledTimes(1);

    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u-1', email: 'new@example.com', user_metadata: {} } },
      error: null,
    });

    await act(async () => {
      await result.current.refresh();
    });

    expect(mockGetUser).toHaveBeenCalledTimes(2);
    expect(result.current.user?.email).toBe('new@example.com');
  });
});
