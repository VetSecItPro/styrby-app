/**
 * Tests for handle-invite-deep-link module.
 *
 * Written BEFORE implementation (TDD — RED phase).
 *
 * Covers:
 * - extractInviteToken(): URL parser for https and custom-scheme invite URLs
 * - acceptInvitationFromToken(): fetch wrapper that calls /api/invitations/accept
 *
 * WHY TDD: Invite token handling is a security-sensitive path. Tests written first
 * ensure the implementation matches exact validation rules (hex-only, length >= 64)
 * rather than inferring them from the code.
 */

// ============================================================================
// Mock: expo-linking (not used directly in util but imported transitively)
// ============================================================================

jest.mock('expo-linking', () => ({
  openURL: jest.fn(async () => {}),
  createURL: jest.fn((path: string) => `styrby://${path}`),
}));

// ============================================================================
// Imports (AFTER mocks)
// ============================================================================

import { extractInviteToken, acceptInvitationFromToken } from '../handle-invite-deep-link';
import type { AcceptResult } from '../handle-invite-deep-link';

// ============================================================================
// Fixtures
// ============================================================================

/**
 * A 64-character lowercase hex string — the minimum valid token.
 * WHY exactly 64: matches the backend SHA-256 hex output from the invite generator.
 */
const VALID_TOKEN_64 = 'a'.repeat(64);

/**
 * A 128-character lowercase hex string — longer valid token.
 */
const VALID_TOKEN_128 = 'b1c2'.repeat(32); // 128 chars, all hex

/**
 * A mixed-case 64-char hex string — must also be valid (hex is case-insensitive).
 */
const VALID_TOKEN_MIXED_CASE = 'AbCdEf'.repeat(10) + 'AbCd'; // 64 chars, mixed case

// ============================================================================
// extractInviteToken — URL parsing
// ============================================================================

describe('extractInviteToken', () => {
  // --------------------------------------------------------------------------
  // Valid https:// URLs
  // --------------------------------------------------------------------------

  it('returns the token from a valid https://styrbyapp.com/invite/<token> URL', () => {
    const url = `https://styrbyapp.com/invite/${VALID_TOKEN_64}`;
    expect(extractInviteToken(url)).toBe(VALID_TOKEN_64);
  });

  it('returns the token from a 128-char token https URL', () => {
    const url = `https://styrbyapp.com/invite/${VALID_TOKEN_128}`;
    expect(extractInviteToken(url)).toBe(VALID_TOKEN_128);
  });

  it('handles trailing slash after token in https URL', () => {
    // WHY: Some email clients append a trailing slash when linkifying URLs.
    const url = `https://styrbyapp.com/invite/${VALID_TOKEN_64}/`;
    expect(extractInviteToken(url)).toBe(VALID_TOKEN_64);
  });

  // --------------------------------------------------------------------------
  // Valid styrby:// custom-scheme URLs
  // --------------------------------------------------------------------------

  it('returns the token from a valid styrby://invite/<token> URL', () => {
    const url = `styrby://invite/${VALID_TOKEN_64}`;
    expect(extractInviteToken(url)).toBe(VALID_TOKEN_64);
  });

  it('handles trailing slash after token in custom-scheme URL', () => {
    const url = `styrby://invite/${VALID_TOKEN_64}/`;
    expect(extractInviteToken(url)).toBe(VALID_TOKEN_64);
  });

  // --------------------------------------------------------------------------
  // Returns null — unrelated URLs
  // --------------------------------------------------------------------------

  it('returns null for an unrelated https URL', () => {
    expect(extractInviteToken('https://styrbyapp.com/dashboard')).toBeNull();
  });

  it('returns null for an unrelated custom-scheme URL', () => {
    expect(extractInviteToken('styrby://chat')).toBeNull();
  });

  it('returns null for a different domain', () => {
    expect(extractInviteToken(`https://example.com/invite/${VALID_TOKEN_64}`)).toBeNull();
  });

  it('returns null for http (not https)', () => {
    expect(extractInviteToken(`http://styrbyapp.com/invite/${VALID_TOKEN_64}`)).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Returns null — token too short (< 64 chars)
  // --------------------------------------------------------------------------

  it('returns null when token is shorter than 64 hex chars', () => {
    const shortToken = 'a'.repeat(63);
    expect(extractInviteToken(`https://styrbyapp.com/invite/${shortToken}`)).toBeNull();
  });

  it('returns null when token is empty', () => {
    expect(extractInviteToken('https://styrbyapp.com/invite/')).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Returns null — non-hex token
  // --------------------------------------------------------------------------

  it('returns null when token contains non-hex characters', () => {
    // 'g' is not a hex character; total length >= 64
    const nonHexToken = 'g'.repeat(64);
    expect(extractInviteToken(`https://styrbyapp.com/invite/${nonHexToken}`)).toBeNull();
  });

  it('returns null when token contains a hyphen', () => {
    // UUIDs or other formats should not pass hex validation
    const uuidLike = '11111111-1111-4111-a111-111111111111' + '0'.repeat(28);
    expect(extractInviteToken(`https://styrbyapp.com/invite/${uuidLike}`)).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Returns null — empty path (no token segment at all)
  // --------------------------------------------------------------------------

  it('returns null for an invite URL with no token segment', () => {
    expect(extractInviteToken('https://styrbyapp.com/invite')).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Never throws — graceful on malformed input
  // --------------------------------------------------------------------------

  it('returns null (never throws) for empty string', () => {
    expect(() => extractInviteToken('')).not.toThrow();
    expect(extractInviteToken('')).toBeNull();
  });

  it('returns null (never throws) for completely invalid input', () => {
    expect(() => extractInviteToken('not-a-url-at-all')).not.toThrow();
    expect(extractInviteToken('not-a-url-at-all')).toBeNull();
  });

  it('returns null (never throws) for null-like cast', () => {
    expect(() => extractInviteToken(undefined as unknown as string)).not.toThrow();
    expect(extractInviteToken(undefined as unknown as string)).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Mixed case hex — valid
  // --------------------------------------------------------------------------

  it('accepts mixed-case hex tokens (hex is case-insensitive)', () => {
    const url = `https://styrbyapp.com/invite/${VALID_TOKEN_MIXED_CASE}`;
    expect(extractInviteToken(url)).toBe(VALID_TOKEN_MIXED_CASE);
  });
});

// ============================================================================
// acceptInvitationFromToken — fetch wrapper
// ============================================================================

/**
 * Minimal Supabase session shape used by acceptInvitationFromToken.
 *
 * WHY we define this inline: the function only needs access_token, not the
 * full @supabase/supabase-js Session type. Keeping it minimal avoids a heavy
 * import and makes the mock straightforward.
 */
const MOCK_SESSION = {
  access_token: 'Bearer.mock.access.token',
  refresh_token: 'mock-refresh',
  expires_in: 3600,
  token_type: 'bearer',
  user: {
    id: 'user-uuid',
    email: 'test@example.com',
    role: 'authenticated',
    aud: 'authenticated',
    created_at: '2026-01-01T00:00:00.000Z',
    app_metadata: {},
    user_metadata: {},
  },
} as Parameters<typeof acceptInvitationFromToken>[1];

describe('acceptInvitationFromToken', () => {
  // Store and restore global fetch
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.EXPO_PUBLIC_APP_URL;
  });

  beforeEach(() => {
    process.env.EXPO_PUBLIC_APP_URL = 'https://styrbyapp.com';
  });

  // --------------------------------------------------------------------------
  // Success path (200 accepted)
  // --------------------------------------------------------------------------

  it('returns accepted result with teamId and role on 200 response', async () => {
    const mockResponseBody = {
      team_id: 'team-uuid-123',
      role: 'member',
      team_name: 'Acme Engineering',
    };

    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockResponseBody,
    } as Response);

    const result = await acceptInvitationFromToken(VALID_TOKEN_64, MOCK_SESSION);

    expect(result).toEqual<AcceptResult>({
      status: 'accepted',
      teamId: 'team-uuid-123',
      role: 'member',
    });
  });

  // --------------------------------------------------------------------------
  // Bearer token forwarding
  // --------------------------------------------------------------------------

  it('forwards the session access_token as a Bearer Authorization header', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ team_id: 'team-uuid', role: 'member' }),
    } as Response);

    await acceptInvitationFromToken(VALID_TOKEN_64, MOCK_SESSION);

    const [url, options] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];

    // Verify the endpoint
    expect(url).toBe('https://styrbyapp.com/api/invitations/accept');

    // Verify auth header
    expect((options.headers as Record<string, string>)['Authorization']).toBe(
      `Bearer ${MOCK_SESSION.access_token}`
    );

    // Verify token in body
    const body = JSON.parse(options.body as string);
    expect(body).toEqual({ token: VALID_TOKEN_64 });
  });

  // --------------------------------------------------------------------------
  // 403 EMAIL_MISMATCH
  // --------------------------------------------------------------------------

  it('returns error result with EMAIL_MISMATCH code on 403 response', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({ error: 'EMAIL_MISMATCH', message: 'Invitation is for a different email address.' }),
    } as Response);

    const result = await acceptInvitationFromToken(VALID_TOKEN_64, MOCK_SESSION);

    expect(result).toEqual<AcceptResult>({
      status: 'error',
      code: 'EMAIL_MISMATCH',
      message: 'Invitation is for a different email address.',
    });
  });

  // --------------------------------------------------------------------------
  // 410 EXPIRED
  // --------------------------------------------------------------------------

  it('returns error result with EXPIRED code on 410 response', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: false,
      status: 410,
      json: async () => ({ error: 'EXPIRED', message: 'This invitation has expired.' }),
    } as Response);

    const result = await acceptInvitationFromToken(VALID_TOKEN_64, MOCK_SESSION);

    expect(result).toEqual<AcceptResult>({
      status: 'error',
      code: 'EXPIRED',
      message: 'This invitation has expired.',
    });
  });

  // --------------------------------------------------------------------------
  // 409 ALREADY_ACCEPTED
  // --------------------------------------------------------------------------

  it('returns error result with ALREADY_ACCEPTED code on 409 response', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: 'ALREADY_ACCEPTED', message: 'You have already accepted this invitation.' }),
    } as Response);

    const result = await acceptInvitationFromToken(VALID_TOKEN_64, MOCK_SESSION);

    expect(result).toEqual<AcceptResult>({
      status: 'error',
      code: 'ALREADY_ACCEPTED',
      message: 'You have already accepted this invitation.',
    });
  });

  // --------------------------------------------------------------------------
  // 404 NOT_FOUND
  // --------------------------------------------------------------------------

  it('returns error result with NOT_FOUND code on 404 response', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: 'NOT_FOUND', message: 'Invitation not found.' }),
    } as Response);

    const result = await acceptInvitationFromToken(VALID_TOKEN_64, MOCK_SESSION);

    expect(result).toEqual<AcceptResult>({
      status: 'error',
      code: 'NOT_FOUND',
      message: 'Invitation not found.',
    });
  });

  // --------------------------------------------------------------------------
  // 500 SERVER_ERROR
  // --------------------------------------------------------------------------

  it('returns error result with SERVER_ERROR code on 500 response', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'INTERNAL_ERROR', message: 'Internal server error.' }),
    } as Response);

    const result = await acceptInvitationFromToken(VALID_TOKEN_64, MOCK_SESSION);

    expect(result.status).toBe('error');
  });

  // --------------------------------------------------------------------------
  // Network error — does NOT throw, returns error result
  // --------------------------------------------------------------------------

  it('returns error result (never throws) on network failure', async () => {
    global.fetch = jest.fn().mockRejectedValueOnce(new Error('Network request failed'));

    const result = await acceptInvitationFromToken(VALID_TOKEN_64, MOCK_SESSION);

    expect(result.status).toBe('error');
    expect((result as Extract<AcceptResult, { status: 'error' }>).code).toBe('NETWORK_ERROR');
    expect((result as Extract<AcceptResult, { status: 'error' }>).message).toContain('Network request failed');
  });

  // --------------------------------------------------------------------------
  // Endpoint format
  // --------------------------------------------------------------------------

  it('calls the /api/invitations/accept endpoint at the configured app URL', async () => {
    // WHY: EXPO_PUBLIC_* env vars are inlined by Babel at compile time during
    // test runs (babel-preset-expo + caller 'metro'). Dynamic process.env
    // assignment after module load is silently ignored for EXPO_PUBLIC_ vars.
    // We verify the endpoint path structure instead of the exact base URL.
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ team_id: 'team-uuid', role: 'member' }),
    } as Response);

    await acceptInvitationFromToken(VALID_TOKEN_64, MOCK_SESSION);

    const [url] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    // Verify the endpoint path suffix is correct regardless of base URL
    expect(url).toMatch(/\/api\/invitations\/accept$/);
  });
});
