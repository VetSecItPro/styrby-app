/**
 * Tests for inline OTP authentication (onboarding/otpAuth.ts).
 *
 * Covers:
 * - promptEmail: returns trimmed lowercase answer
 * - promptOtpCode: strips whitespace from pasted codes
 * - sendOtp: fires the correct Supabase call, propagates errors
 * - verifyOtp: success path, missing session, API error
 * - runOtpAuth: end-to-end with injected I/O + mocked Supabase
 *
 * WHY: OTP path is the primary authentication gate for onboarding.
 * A regression here blocks every new user.
 *
 * @module onboarding/__tests__/otpAuth.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mocks
// ============================================================================

// Mock @supabase/supabase-js before importing the module under test
const mockSignInWithOtp = vi.fn<any[], any>();
const mockVerifyOtpFn = vi.fn<any[], any>();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: {
      signInWithOtp: mockSignInWithOtp,
      verifyOtp: mockVerifyOtpFn,
    },
  })),
}));

// ============================================================================
// Imports after mocks
// ============================================================================

import { promptEmail, promptOtpCode, sendOtp, verifyOtp, runOtpAuth } from '../otpAuth.js';
import { createClient } from '@supabase/supabase-js';

const mockCreateClient = createClient as ReturnType<typeof vi.fn>;

// ============================================================================
// promptEmail
// ============================================================================

describe('promptEmail', () => {
  it('returns the trimmed, lowercased email', async () => {
    const rl = {
      question: vi.fn((_q: string, cb: (a: string) => void) => cb('  USER@Example.COM  ')),
    };
    const result = await promptEmail(rl);
    expect(result).toBe('user@example.com');
  });
});

// ============================================================================
// promptOtpCode
// ============================================================================

describe('promptOtpCode', () => {
  it('strips spaces from pasted codes (e.g. "123 456")', async () => {
    const rl = {
      question: vi.fn((_q: string, cb: (a: string) => void) => cb('123 456')),
    };
    const result = await promptOtpCode(rl);
    expect(result).toBe('123456');
  });

  it('returns plain code unchanged', async () => {
    const rl = {
      question: vi.fn((_q: string, cb: (a: string) => void) => cb('987654')),
    };
    expect(await promptOtpCode(rl)).toBe('987654');
  });
});

// ============================================================================
// sendOtp
// ============================================================================

describe('sendOtp', () => {
  beforeEach(() => {
    mockSignInWithOtp.mockReset();
  });

  it('calls supabase.auth.signInWithOtp with correct payload', async () => {
    mockSignInWithOtp.mockResolvedValue({ data: {}, error: null });
    const mockClient = mockCreateClient('', '') as any;
    await sendOtp(mockClient, 'test@example.com');

    expect(mockSignInWithOtp).toHaveBeenCalledWith({
      email: 'test@example.com',
      options: { shouldCreateUser: true },
    });
  });

  it('throws when Supabase returns an error', async () => {
    mockSignInWithOtp.mockResolvedValue({
      data: {},
      error: { message: 'rate limited' },
    });
    const mockClient = mockCreateClient('', '') as any;
    await expect(sendOtp(mockClient, 'bad@example.com')).rejects.toThrow('rate limited');
  });
});

// ============================================================================
// verifyOtp
// ============================================================================

describe('verifyOtp', () => {
  beforeEach(() => {
    mockVerifyOtpFn.mockReset();
  });

  it('returns auth tokens and user info on success', async () => {
    mockVerifyOtpFn.mockResolvedValue({
      data: {
        session: {
          access_token: 'access_tok',
          refresh_token: 'refresh_tok',
        },
        user: { id: 'uid-123', email: 'user@example.com' },
      },
      error: null,
    });

    const mockClient = mockCreateClient('', '') as any;
    const result = await verifyOtp(mockClient, 'user@example.com', '123456');

    expect(result.accessToken).toBe('access_tok');
    expect(result.refreshToken).toBe('refresh_tok');
    expect(result.userId).toBe('uid-123');
    expect(result.userEmail).toBe('user@example.com');
  });

  it('throws when the OTP is wrong or expired', async () => {
    mockVerifyOtpFn.mockResolvedValue({
      data: { session: null, user: null },
      error: { message: 'Invalid OTP' },
    });
    const mockClient = mockCreateClient('', '') as any;
    await expect(verifyOtp(mockClient, 'user@example.com', '000000')).rejects.toThrow(
      'Invalid OTP'
    );
  });

  it('throws when session is null even without error message', async () => {
    mockVerifyOtpFn.mockResolvedValue({
      data: { session: null, user: null },
      error: null,
    });
    const mockClient = mockCreateClient('', '') as any;
    await expect(verifyOtp(mockClient, 'user@example.com', '000000')).rejects.toThrow(
      'OTP verification failed'
    );
  });

  it('falls back to the supplied email when user.email is undefined', async () => {
    mockVerifyOtpFn.mockResolvedValue({
      data: {
        session: { access_token: 'tok', refresh_token: 'ref' },
        user: { id: 'uid-456', email: undefined },
      },
      error: null,
    });
    const mockClient = mockCreateClient('', '') as any;
    const result = await verifyOtp(mockClient, 'fallback@example.com', '123456');
    expect(result.userEmail).toBe('fallback@example.com');
  });
});

// ============================================================================
// runOtpAuth — end-to-end
// ============================================================================

describe('runOtpAuth', () => {
  beforeEach(() => {
    mockSignInWithOtp.mockReset();
    mockVerifyOtpFn.mockReset();
    // Reset the mock factory to return a fresh auth sub-object each time
    mockCreateClient.mockReturnValue({
      auth: {
        signInWithOtp: mockSignInWithOtp,
        verifyOtp: mockVerifyOtpFn,
      },
    });
  });

  it('completes auth end-to-end with injected I/O (no real stdin)', async () => {
    // OTP send succeeds
    mockSignInWithOtp.mockResolvedValue({ data: {}, error: null });
    // OTP verify succeeds
    mockVerifyOtpFn.mockResolvedValue({
      data: {
        session: { access_token: 'at', refresh_token: 'rt' },
        user: { id: 'u1', email: 'e2e@test.com' },
      },
      error: null,
    });

    const result = await runOtpAuth({
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon_key',
      // Inject email + token to skip readline prompts
      email: 'e2e@test.com',
      otpToken: '123456',
    });

    expect(result.userId).toBe('u1');
    expect(result.userEmail).toBe('e2e@test.com');
    expect(result.accessToken).toBe('at');

    // OTP send should have been called with shouldCreateUser: true
    expect(mockSignInWithOtp).toHaveBeenCalledWith({
      email: 'e2e@test.com',
      options: { shouldCreateUser: true },
    });
  });

  it('throws when email is invalid (no @)', async () => {
    await expect(
      runOtpAuth({
        supabaseUrl: 'https://test.supabase.co',
        supabaseAnonKey: 'k',
        email: 'notanemail',
        otpToken: '123456',
      })
    ).rejects.toThrow('Invalid email');
  });

  it('throws when OTP token is too short', async () => {
    mockSignInWithOtp.mockResolvedValue({ data: {}, error: null });

    await expect(
      runOtpAuth({
        supabaseUrl: 'https://test.supabase.co',
        supabaseAnonKey: 'k',
        email: 'user@test.com',
        otpToken: '12', // too short
      })
    ).rejects.toThrow('at least 6 digits');
  });

  it('propagates OTP send failure', async () => {
    mockSignInWithOtp.mockResolvedValue({
      data: {},
      error: { message: 'quota exceeded' },
    });

    await expect(
      runOtpAuth({
        supabaseUrl: 'https://test.supabase.co',
        supabaseAnonKey: 'k',
        email: 'user@test.com',
        otpToken: '123456',
      })
    ).rejects.toThrow('quota exceeded');
  });
});
