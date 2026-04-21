/**
 * Tests for account-io — Phase 1 #4 batch 2 follow-up.
 *
 * The 7 IO wrappers each return a discriminated `IoResult` rather than
 * throwing. We test the success / error / catch branches so the hook
 * (which maps result → Alert copy) has a stable contract.
 *
 * Pure happy-path + error-path coverage. The full hook flow is exercised
 * separately as future test debt (deferred — flagged in PR description).
 *
 * @module components/account/__tests__/account-io
 */

const mockUpdate = jest.fn();
const mockUpdateUser = jest.fn();
const mockResetPasswordForEmail = jest.fn();
const mockGetSession = jest.fn();
const mockSelectGte = jest.fn();
const mockSignOut = jest.fn();
const mockClearPairingInfo = jest.fn();
const mockSecureStoreDelete = jest.fn();
const mockClipboardSet = jest.fn();
const mockGetApiBaseUrl = jest.fn(() => 'http://test');

jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      updateUser: (...args: unknown[]) => mockUpdateUser(...args),
      resetPasswordForEmail: (...args: unknown[]) => mockResetPasswordForEmail(...args),
      getSession: () => mockGetSession(),
    },
    from: (table: string) => ({
      update: (data: unknown) => ({
        eq: (col: string, val: unknown) => mockUpdate(table, data, col, val),
      }),
      select: () => ({
        eq: () => ({
          gte: (col: string, val: unknown) => mockSelectGte(col, val),
        }),
      }),
    }),
  },
  signOut: () => mockSignOut(),
}));

jest.mock('@/services/pairing', () => ({
  clearPairingInfo: () => mockClearPairingInfo(),
}));

jest.mock('@/lib/config', () => ({
  getApiBaseUrl: () => mockGetApiBaseUrl(),
}));

jest.mock('expo-secure-store', () => ({
  deleteItemAsync: (key: string) => mockSecureStoreDelete(key),
}));

jest.mock('expo-clipboard', () => ({
  setStringAsync: (val: string) => mockClipboardSet(val),
}));

import {
  updateDisplayName,
  requestEmailChange,
  requestPasswordReset,
  fetchMonthlySpend,
  exportAccountData,
  deleteAccount,
  performSignOut,
} from '../account-io';

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn();
});

// ============================================================================
// updateDisplayName
// ============================================================================

describe('updateDisplayName', () => {
  it('returns ok=true on success', async () => {
    mockUpdate.mockResolvedValueOnce({ error: null });
    const result = await updateDisplayName('user-1', 'Alice');
    expect(result).toEqual({ ok: true, data: undefined });
    expect(mockUpdate).toHaveBeenCalledWith('profiles', { display_name: 'Alice' }, 'id', 'user-1');
  });

  it('returns ok=false with safe message on Supabase error', async () => {
    mockUpdate.mockResolvedValueOnce({ error: { message: 'db down' } });
    const result = await updateDisplayName('user-1', 'Alice');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('Failed to save');
    }
  });

  it('returns ok=false on thrown exception', async () => {
    mockUpdate.mockRejectedValueOnce(new Error('network'));
    const result = await updateDisplayName('user-1', 'Alice');
    expect(result.ok).toBe(false);
  });
});

// ============================================================================
// requestEmailChange
// ============================================================================

describe('requestEmailChange', () => {
  it('returns ok=true on success', async () => {
    mockUpdateUser.mockResolvedValueOnce({ error: null });
    expect(await requestEmailChange('new@example.com')).toEqual({ ok: true, data: undefined });
  });

  it('rewrites "already registered" Supabase errors to user-friendly copy', async () => {
    mockUpdateUser.mockResolvedValueOnce({
      error: { message: 'A user with this email is already registered' },
    });
    const result = await requestEmailChange('existing@example.com');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('already in use');
  });

  it('passes through non-recognized error messages', async () => {
    mockUpdateUser.mockResolvedValueOnce({ error: { message: 'rate limited' } });
    const result = await requestEmailChange('new@example.com');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toBe('rate limited');
  });
});

// ============================================================================
// requestPasswordReset
// ============================================================================

describe('requestPasswordReset', () => {
  it('returns ok=true on success', async () => {
    mockResetPasswordForEmail.mockResolvedValueOnce({ error: null });
    expect(await requestPasswordReset('user@example.com')).toEqual({ ok: true, data: undefined });
  });

  it('returns ok=false with the Supabase message on error', async () => {
    mockResetPasswordForEmail.mockResolvedValueOnce({ error: { message: 'rate limit hit' } });
    const result = await requestPasswordReset('user@example.com');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toBe('rate limit hit');
  });
});

// ============================================================================
// fetchMonthlySpend
// ============================================================================

describe('fetchMonthlySpend', () => {
  it('sums cost_usd over the returned rows', async () => {
    mockSelectGte.mockResolvedValueOnce({
      data: [{ cost_usd: 0.5 }, { cost_usd: 1.25 }, { cost_usd: 0.25 }],
      error: null,
    });
    expect(await fetchMonthlySpend('user-1')).toBe(2);
  });

  it('treats missing cost_usd as 0', async () => {
    mockSelectGte.mockResolvedValueOnce({
      data: [{ cost_usd: 1 }, { cost_usd: null }],
      error: null,
    });
    expect(await fetchMonthlySpend('user-1')).toBe(1);
  });

  it('returns 0 on Supabase error (non-fatal)', async () => {
    mockSelectGte.mockResolvedValueOnce({ data: null, error: { message: 'permission denied' } });
    expect(await fetchMonthlySpend('user-1')).toBe(0);
  });

  it('returns 0 on thrown exception', async () => {
    mockSelectGte.mockRejectedValueOnce(new Error('network'));
    expect(await fetchMonthlySpend('user-1')).toBe(0);
  });
});

// ============================================================================
// exportAccountData
// ============================================================================

describe('exportAccountData', () => {
  it('refuses without an authenticated session', async () => {
    mockGetSession.mockResolvedValueOnce({ data: { session: null } });
    const result = await exportAccountData();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('signed in');
  });

  it('writes the export JSON to the clipboard on 200', async () => {
    mockGetSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } });
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve('{"export":"data"}'),
    });
    expect(await exportAccountData()).toEqual({ ok: true, data: undefined });
    expect(mockClipboardSet).toHaveBeenCalledWith('{"export":"data"}');
  });

  it('maps 429 to a rate-limit message', async () => {
    mockGetSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } });
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 429 });
    const result = await exportAccountData();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(429);
      expect(result.message).toContain('once per hour');
    }
  });

  it('returns generic failure on 500', async () => {
    mockGetSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } });
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 500 });
    const result = await exportAccountData();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(500);
  });
});

// ============================================================================
// deleteAccount
// ============================================================================

describe('deleteAccount', () => {
  it('refuses without an authenticated session', async () => {
    mockGetSession.mockResolvedValueOnce({ data: { session: null } });
    expect((await deleteAccount()).ok).toBe(false);
  });

  it('clears local pairing + secure-store + signs out on 200', async () => {
    mockGetSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } });
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({}),
    });
    mockSignOut.mockResolvedValueOnce({ error: null });

    const result = await deleteAccount();
    expect(result).toEqual({ ok: true, data: undefined });
    expect(mockClearPairingInfo).toHaveBeenCalled();
    expect(mockSecureStoreDelete).toHaveBeenCalled();
    expect(mockSignOut).toHaveBeenCalled();
  });

  it('maps 429 to a daily rate-limit message', async () => {
    mockGetSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } });
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 429 });
    const result = await deleteAccount();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(429);
      expect(result.message).toContain('once per day');
    }
  });

  it('extracts server-side error message on non-2xx response', async () => {
    mockGetSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } });
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: 'Confirmation phrase mismatch' }),
    });
    const result = await deleteAccount();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toBe('Confirmation phrase mismatch');
  });
});

// ============================================================================
// performSignOut
// ============================================================================

describe('performSignOut', () => {
  it('clears local state and signs out cleanly', async () => {
    mockSignOut.mockResolvedValueOnce({ error: null });
    expect(await performSignOut()).toEqual({ ok: true, data: undefined });
    expect(mockClearPairingInfo).toHaveBeenCalled();
    expect(mockSecureStoreDelete).toHaveBeenCalledWith(expect.any(String));
  });

  it('returns the Supabase error message when signOut fails', async () => {
    mockSignOut.mockResolvedValueOnce({ error: { message: 'session revoked' } });
    const result = await performSignOut();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toBe('session revoked');
  });

  it('returns ok=false on thrown exception', async () => {
    mockClearPairingInfo.mockRejectedValueOnce(new Error('disk full'));
    const result = await performSignOut();
    expect(result.ok).toBe(false);
  });
});
