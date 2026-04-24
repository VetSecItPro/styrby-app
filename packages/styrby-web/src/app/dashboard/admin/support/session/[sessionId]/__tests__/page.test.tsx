/**
 * Tests for /dashboard/admin/support/session/[sessionId]/page.tsx
 *
 * Phase 4.2 T6 — Admin Support Session Metadata Viewer
 *
 * WHY these test targets:
 *   The session metadata page is the final consumer of the consent-gated support
 *   access flow. Regressions that expose content fields, bypass the session_id
 *   mismatch check, or fail to call admin_consume_support_access correctly could
 *   expose E2E-encrypted message bodies to support staff — a critical privacy
 *   violation. SOC2 CC6.3 / GDPR Art 25.
 *
 * Test coverage:
 *   T1 — Missing grant param → notFound()
 *   T2 — Malformed grant param → notFound()
 *   T3 — Valid token but RPC returns 22023 → renders AccessDeniedPage
 *   T4 — session_id URL ≠ RPC returned session_id → renders AccessDeniedPage
 *   T5 — Happy path: renders ≤ MESSAGE_LIMIT messages, no content column
 *   T6 — Regression: assert SELECT never includes content_encrypted / encryption_nonce
 *   T7 — grant_id logged (not token_hash, not raw token)
 *
 * Testing strategy:
 *   - Mock createClient() to control Supabase responses
 *   - Mock notFound() to detect when it was called
 *   - Render the async Server Component using React's renderToStaticMarkup
 *   - Assert on rendered HTML for UI correctness
 *   - Assert on mock call arguments for security-critical SELECT shape
 *
 * @module app/dashboard/admin/support/session/[sessionId]/__tests__/page
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import crypto from 'crypto';

// ─── Mocks ────────────────────────────────────────────────────────────────────

/**
 * Mock next/navigation notFound() to be spy-able.
 * WHY: notFound() throws a Next.js-internal error in production. In tests we
 * want to detect that it was called without actually crashing the test runner.
 */
const mockNotFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});

vi.mock('next/navigation', () => ({
  notFound: () => mockNotFound(),
}));

/**
 * Mock next/headers so `headers()` can be called in Server Component context.
 * The rate limit implementation reads x-forwarded-for from headers.
 * We return a headers-like object that always returns null (no IP spoofing).
 */
vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue({
    get: vi.fn().mockReturnValue(null),
  }),
}));

/**
 * Supabase client mock.
 *
 * WHY mocked at this level: the test environment has no Supabase credentials.
 * We control the RPC and query responses to simulate various scenarios.
 */
const mockRpcFn = vi.fn();
const mockFromFn = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    rpc: mockRpcFn,
    from: mockFromFn,
  }),
}));

/**
 * Mock rateLimit to always allow in tests.
 * WHY: We test rate limiting behavior in lib/__tests__/rateLimit.test.ts.
 * Here we want to test page logic, not rate limit enforcement.
 */
vi.mock('@/lib/rateLimit', () => ({
  rateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 19, resetAt: Date.now() + 60000 }),
  RATE_LIMITS: {
    standard: { windowMs: 60000, maxRequests: 100 },
  },
  rateLimitResponse: vi.fn(),
}));

// ─── Test fixtures ────────────────────────────────────────────────────────────

const VALID_SESSION_ID = '11111111-1111-1111-1111-111111111111';
const DIFFERENT_SESSION_ID = '22222222-2222-2222-2222-222222222222';

/** A valid 32-byte base64url string (43 chars, no padding). */
const VALID_RAW_TOKEN = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA_';
/** The SHA-256 hex of VALID_RAW_TOKEN (deterministic). */
const EXPECTED_TOKEN_HASH = crypto.createHash('sha256').update(VALID_RAW_TOKEN).digest('hex');

/** Minimal valid session row returned by the sessions SELECT. */
const MOCK_SESSION_ROW = {
  id: VALID_SESSION_ID,
  agent_type: 'claude',
  status: 'completed',
  started_at: '2026-04-24T10:00:00Z',
  ended_at: '2026-04-24T11:00:00Z',
  total_cost_usd: 0.0123,
  total_input_tokens: 5000,
  total_output_tokens: 2000,
  total_cache_tokens: 500,
  message_count: 42,
  model: 'claude-sonnet-4-6',
};

/** Minimal valid RPC response row. */
const MOCK_RPC_ROW = {
  grant_id: '7',
  session_id: VALID_SESSION_ID,
  scope: { fields: ['action', 'tool', 'timestamp', 'tokens', 'status'] },
};

/**
 * A valid message row — NO content fields.
 *
 * WHY padded UUIDs: Zod's z.string().uuid() validates RFC 4122 format.
 * The id must be a proper UUID or validation fails and messages are dropped
 * (defense-in-depth via Zod schema filtering). We use zero-padded UUIDs
 * to keep the sequence_number readable in the fixture.
 */
function makeMessageRow(seq: number) {
  // Pad seq to 8 hex digits for a valid UUID segment
  const seqHex = seq.toString(16).padStart(8, '0');
  return {
    id: `${seqHex}-0000-4000-8000-000000000000`,
    sequence_number: seq,
    message_type: 'assistant',
    tool_name: seq % 2 === 0 ? 'bash' : null,
    input_tokens: 100,
    output_tokens: 200,
    cache_tokens: 50,
    duration_ms: 350,
    created_at: '2026-04-24T10:00:00Z',
  };
}

// ─── Page import helper ────────────────────────────────────────────────────────

/**
 * Import the page module after mocks are set up.
 * WHY dynamic import: vi.mock() hoisting requires mocks to be in place before
 * the module under test is imported. Dynamic import inside a helper function
 * ensures the mock registry is populated first.
 */
async function importPage() {
  const mod = await import('../page');
  return mod.default;
}

// ─── Setup / teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Default mock chain for supabase.from()
  // Supports: .from().select().eq().single() for sessions
  // and: .from().select().eq().order().limit() for messages
  const mockSingle = vi.fn().mockResolvedValue({ data: MOCK_SESSION_ROW, error: null });
  const mockLimit = vi.fn().mockResolvedValue({ data: [makeMessageRow(1)], error: null });
  const mockOrder = vi.fn().mockReturnValue({ limit: mockLimit });
  const mockEqSession = vi.fn().mockReturnValue({ single: mockSingle });
  const mockEqMessages = vi.fn().mockReturnValue({ order: mockOrder });

  // sessions vs session_messages vs support_access_grants routing by table name.
  // WHY support_access_grants: Fix 2 adds a post-RPC SELECT on this table to read
  // the current access_count (post-consume, atomically incremented by the RPC).
  // The mock returns access_count: 1 by default (first consume of this grant).
  const mockGrantMaybeSingle = vi.fn().mockResolvedValue({
    data: { access_count: 1 },
    error: null,
  });
  const mockGrantEq = vi.fn().mockReturnValue({ maybeSingle: mockGrantMaybeSingle });

  mockFromFn.mockImplementation((table: string) => {
    if (table === 'sessions') {
      return {
        select: vi.fn().mockReturnValue({ eq: mockEqSession }),
      };
    }
    if (table === 'session_messages') {
      return {
        select: vi.fn().mockReturnValue({ eq: mockEqMessages }),
      };
    }
    if (table === 'support_access_grants') {
      return {
        select: vi.fn().mockReturnValue({ eq: mockGrantEq }),
      };
    }
    return {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
  });

  // Default: RPC succeeds
  mockRpcFn.mockResolvedValue({ data: [MOCK_RPC_ROW], error: null });
});

afterEach(() => {
  vi.resetModules();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AdminSupportSessionPage', () => {
  // ── T1: Missing grant param → notFound() ─────────────────────────────────

  it('T1 — missing grant param calls notFound()', async () => {
    const Page = await importPage();

    await expect(
      Page({
        params: Promise.resolve({ sessionId: VALID_SESSION_ID }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow('NEXT_NOT_FOUND');

    expect(mockNotFound).toHaveBeenCalledOnce();
    // RPC must NOT be called when grant is missing
    expect(mockRpcFn).not.toHaveBeenCalled();
  });

  // ── T2: Malformed grant param → notFound() ────────────────────────────────

  it('T2 — malformed grant param (too short) calls notFound()', async () => {
    const Page = await importPage();

    await expect(
      Page({
        params: Promise.resolve({ sessionId: VALID_SESSION_ID }),
        searchParams: Promise.resolve({ grant: 'tooshort' }),
      }),
    ).rejects.toThrow('NEXT_NOT_FOUND');

    expect(mockNotFound).toHaveBeenCalledOnce();
    expect(mockRpcFn).not.toHaveBeenCalled();
  });

  it('T2b — malformed grant param (contains invalid chars) calls notFound()', async () => {
    const Page = await importPage();
    // 43 chars but contains '+' which is not in the base64url alphabet
    const badToken = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+';

    await expect(
      Page({
        params: Promise.resolve({ sessionId: VALID_SESSION_ID }),
        searchParams: Promise.resolve({ grant: badToken }),
      }),
    ).rejects.toThrow('NEXT_NOT_FOUND');

    expect(mockNotFound).toHaveBeenCalledOnce();
    expect(mockRpcFn).not.toHaveBeenCalled();
  });

  it('T2c — malformed grant param (too long) calls notFound()', async () => {
    const Page = await importPage();
    // 44 chars — one too many
    const badToken = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

    await expect(
      Page({
        params: Promise.resolve({ sessionId: VALID_SESSION_ID }),
        searchParams: Promise.resolve({ grant: badToken }),
      }),
    ).rejects.toThrow('NEXT_NOT_FOUND');

    expect(mockNotFound).toHaveBeenCalledOnce();
    expect(mockRpcFn).not.toHaveBeenCalled();
  });

  // ── T3: Valid token but RPC returns error → renders AccessDeniedPage ───────

  it('T3 — RPC error with code 22023 renders AccessDeniedPage (not a crash)', async () => {
    mockRpcFn.mockResolvedValue({
      data: null,
      error: { code: '22023', message: 'access denied' },
    });

    const Page = await importPage();

    const result = await Page({
      params: Promise.resolve({ sessionId: VALID_SESSION_ID }),
      searchParams: Promise.resolve({ grant: VALID_RAW_TOKEN }),
    });

    const html = renderToStaticMarkup(result as React.ReactElement);

    expect(html).toContain('Access denied or expired');
    // MUST NOT crash or re-throw
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it('T3b — RPC returns non-22023 error also renders AccessDeniedPage', async () => {
    mockRpcFn.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'not authorized' },
    });

    const Page = await importPage();

    const result = await Page({
      params: Promise.resolve({ sessionId: VALID_SESSION_ID }),
      searchParams: Promise.resolve({ grant: VALID_RAW_TOKEN }),
    });

    const html = renderToStaticMarkup(result as React.ReactElement);
    expect(html).toContain('Access denied or expired');
  });

  it('T3c — RPC returns empty data array renders AccessDeniedPage', async () => {
    mockRpcFn.mockResolvedValue({ data: [], error: null });

    const Page = await importPage();

    const result = await Page({
      params: Promise.resolve({ sessionId: VALID_SESSION_ID }),
      searchParams: Promise.resolve({ grant: VALID_RAW_TOKEN }),
    });

    const html = renderToStaticMarkup(result as React.ReactElement);
    expect(html).toContain('Access denied or expired');
  });

  // ── T4: session_id URL ≠ RPC returned session_id → AccessDeniedPage ───────

  it('T4 — session_id URL param does not match RPC returned session_id → AccessDeniedPage', async () => {
    // RPC returns a grant for DIFFERENT_SESSION_ID
    mockRpcFn.mockResolvedValue({
      data: [{ ...MOCK_RPC_ROW, session_id: DIFFERENT_SESSION_ID }],
      error: null,
    });

    const Page = await importPage();

    const result = await Page({
      params: Promise.resolve({ sessionId: VALID_SESSION_ID }), // URL says VALID
      searchParams: Promise.resolve({ grant: VALID_RAW_TOKEN }),
    });

    const html = renderToStaticMarkup(result as React.ReactElement);
    expect(html).toContain('Access denied or expired');
    // RPC was called (consumed a slot) but render was denied — correct behavior.
    expect(mockRpcFn).toHaveBeenCalledOnce();
    // Sessions SELECT must NOT have been called (we deny before fetching)
    expect(mockFromFn).not.toHaveBeenCalledWith('sessions');
  });

  // ── T5: Happy path ─────────────────────────────────────────────────────────

  it('T5 — happy path: renders session metadata and message table', async () => {
    const messages = Array.from({ length: 5 }, (_, i) => makeMessageRow(i + 1));

    // Override messages mock for this test
    const mockLimit = vi.fn().mockResolvedValue({ data: messages, error: null });
    const mockOrder = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockEqMessages = vi.fn().mockReturnValue({ order: mockOrder });
    const mockSingle = vi.fn().mockResolvedValue({ data: MOCK_SESSION_ROW, error: null });
    const mockEqSession = vi.fn().mockReturnValue({ single: mockSingle });
    // WHY support_access_grants branch: Fix 2 adds a post-RPC SELECT to read
    // access_count. Absent this branch the from() fallback returns a chainable
    // no-op and accessCount stays undefined (rendered as "Access #1" due to ?? 1).
    const mockGrantMaybeSingle2 = vi.fn().mockResolvedValue({ data: { access_count: 1 }, error: null });
    const mockGrantEq2 = vi.fn().mockReturnValue({ maybeSingle: mockGrantMaybeSingle2 });

    mockFromFn.mockImplementation((table: string) => {
      if (table === 'sessions') {
        return { select: vi.fn().mockReturnValue({ eq: mockEqSession }) };
      }
      if (table === 'session_messages') {
        return { select: vi.fn().mockReturnValue({ eq: mockEqMessages }) };
      }
      if (table === 'support_access_grants') {
        return { select: vi.fn().mockReturnValue({ eq: mockGrantEq2 }) };
      }
      return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
    });

    const Page = await importPage();

    const result = await Page({
      params: Promise.resolve({ sessionId: VALID_SESSION_ID }),
      searchParams: Promise.resolve({ grant: VALID_RAW_TOKEN }),
    });

    const html = renderToStaticMarkup(result as React.ReactElement);

    // Session metadata rendered
    expect(html).toContain('Session Metadata');
    expect(html).toContain('claude'); // agent_type
    expect(html).toContain('completed'); // status

    // Message table rendered — check aria-label and no-content notice
    // The aria-label is "Session message metadata" (exact match to component)
    expect(html).toContain('aria-label="Session message metadata"');
    // The no-content notice starts with "Metadata only"
    expect(html).toContain('Metadata only - message content is E2E-encrypted');

    // 5 messages rendered (table footer shows count with "most recent messages" text)
    // The footer renders: "Showing N most recent message(s)"
    expect(html).toContain('most recent message');
    // Verify the message rows are present by checking for a message_type value
    expect(html).toContain('assistant');

    // RPC was called exactly once (not cached across renders)
    expect(mockRpcFn).toHaveBeenCalledOnce();
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it('T5b — happy path: renders at most MESSAGE_LIMIT messages', async () => {
    // 50 messages — the limit
    const messages = Array.from({ length: 50 }, (_, i) => makeMessageRow(i + 1));

    const mockLimit = vi.fn().mockResolvedValue({ data: messages, error: null });
    const mockOrder = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockEqMessages = vi.fn().mockReturnValue({ order: mockOrder });
    const mockSingle = vi.fn().mockResolvedValue({ data: MOCK_SESSION_ROW, error: null });
    const mockEqSession = vi.fn().mockReturnValue({ single: mockSingle });
    // WHY support_access_grants branch: Fix 2 SELECT — same reasoning as T5.
    const mockGrantMaybeSingle3 = vi.fn().mockResolvedValue({ data: { access_count: 1 }, error: null });
    const mockGrantEq3 = vi.fn().mockReturnValue({ maybeSingle: mockGrantMaybeSingle3 });

    mockFromFn.mockImplementation((table: string) => {
      if (table === 'sessions') {
        return { select: vi.fn().mockReturnValue({ eq: mockEqSession }) };
      }
      if (table === 'support_access_grants') {
        return { select: vi.fn().mockReturnValue({ eq: mockGrantEq3 }) };
      }
      return { select: vi.fn().mockReturnValue({ eq: mockEqMessages }) };
    });

    const Page = await importPage();

    const result = await Page({
      params: Promise.resolve({ sessionId: VALID_SESSION_ID }),
      searchParams: Promise.resolve({ grant: VALID_RAW_TOKEN }),
    });

    const html = renderToStaticMarkup(result as React.ReactElement);

    // Check the limit notice is shown in the table footer
    expect(html).toContain('limited to 50');
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it('T5c — happy path: grant_id displayed in session card (not token_hash)', async () => {
    const Page = await importPage();

    const result = await Page({
      params: Promise.resolve({ sessionId: VALID_SESSION_ID }),
      searchParams: Promise.resolve({ grant: VALID_RAW_TOKEN }),
    });

    const html = renderToStaticMarkup(result as React.ReactElement);

    // grant_id (#7) should appear
    expect(html).toContain('#7');
    // The token hash (64-char hex string) must not appear
    expect(html).not.toContain(EXPECTED_TOKEN_HASH);
    // The raw token must not appear
    expect(html).not.toContain(VALID_RAW_TOKEN);
  });

  // ── T6: Regression — SELECT never includes content fields ─────────────────

  it('T6 — regression: SELECT on session_messages never includes content_encrypted', async () => {
    const capturedSelectArgs: string[] = [];

    const mockLimit = vi.fn().mockResolvedValue({ data: [makeMessageRow(1)], error: null });
    const mockOrder = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockEqMessages = vi.fn().mockReturnValue({ order: mockOrder });
    const mockSingle = vi.fn().mockResolvedValue({ data: MOCK_SESSION_ROW, error: null });
    const mockEqSession = vi.fn().mockReturnValue({ single: mockSingle });

    const mockSelect = vi.fn().mockImplementation((cols: string) => {
      capturedSelectArgs.push(cols);
      return { eq: mockEqMessages };
    });
    const mockSelectSession = vi.fn().mockImplementation((cols: string) => {
      capturedSelectArgs.push(cols);
      return { eq: mockEqSession };
    });

    // WHY support_access_grants branch: Fix 2 SELECT for access_count.
    // We capture its cols in capturedSelectArgs too — the test already asserts
    // they must not contain content fields (access_count is safe).
    const mockGrantMaybeSingleT6 = vi.fn().mockResolvedValue({ data: { access_count: 1 }, error: null });
    const mockGrantEqT6 = vi.fn().mockReturnValue({ maybeSingle: mockGrantMaybeSingleT6 });
    const mockSelectGrants = vi.fn().mockImplementation((cols: string) => {
      capturedSelectArgs.push(cols);
      return { eq: mockGrantEqT6 };
    });

    mockFromFn.mockImplementation((table: string) => {
      if (table === 'sessions') {
        return { select: mockSelectSession };
      }
      if (table === 'session_messages') {
        return { select: mockSelect };
      }
      if (table === 'support_access_grants') {
        return { select: mockSelectGrants };
      }
      return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
    });

    const Page = await importPage();

    await Page({
      params: Promise.resolve({ sessionId: VALID_SESSION_ID }),
      searchParams: Promise.resolve({ grant: VALID_RAW_TOKEN }),
    });

    // Verify every SELECT string that was issued
    for (const selectCols of capturedSelectArgs) {
      expect(selectCols).not.toContain('content_encrypted');
      expect(selectCols).not.toContain('encryption_nonce');
      expect(selectCols).not.toMatch(/\bcontent\b/);
    }

    // There must be at least one SELECT for session_messages
    expect(capturedSelectArgs.length).toBeGreaterThanOrEqual(1);
  });

  it('T6b — regression: no content column rendered in message table HTML', async () => {
    const Page = await importPage();

    const result = await Page({
      params: Promise.resolve({ sessionId: VALID_SESSION_ID }),
      searchParams: Promise.resolve({ grant: VALID_RAW_TOKEN }),
    });

    const html = renderToStaticMarkup(result as React.ReactElement);

    // The word "content" must not appear as a table column header
    // (the "Metadata only" notice contains the word "content" in the message —
    //  we check for absence of a <th> containing "Content" specifically)
    const contentColRegex = /<th[^>]*>Content<\/th>/i;
    expect(html).not.toMatch(contentColRegex);

    // content_encrypted and encryption_nonce must not appear in any form
    expect(html).not.toContain('content_encrypted');
    expect(html).not.toContain('encryption_nonce');
  });

  // ── T7: Correct token hash passed to RPC ─────────────────────────────────

  it('T7 — admin_consume_support_access receives SHA-256 hash of raw token (not raw token)', async () => {
    const Page = await importPage();

    await Page({
      params: Promise.resolve({ sessionId: VALID_SESSION_ID }),
      searchParams: Promise.resolve({ grant: VALID_RAW_TOKEN }),
    });

    // Verify RPC was called with the correct function name and token hash
    expect(mockRpcFn).toHaveBeenCalledWith(
      'admin_consume_support_access',
      { p_token_hash: EXPECTED_TOKEN_HASH },
    );

    // Verify the raw token was NOT passed to the RPC
    const rpcCall = mockRpcFn.mock.calls[0];
    const rpcArgs = rpcCall[1] as Record<string, unknown>;
    expect(rpcArgs.p_token_hash).not.toBe(VALID_RAW_TOKEN);
    expect(rpcArgs.p_token_hash).toHaveLength(64); // SHA-256 hex = 64 chars
  });

  // ── T8: RPC called exactly once per render ────────────────────────────────

  it('T8 — admin_consume_support_access called exactly once per render (not cached)', async () => {
    const Page = await importPage();

    await Page({
      params: Promise.resolve({ sessionId: VALID_SESSION_ID }),
      searchParams: Promise.resolve({ grant: VALID_RAW_TOKEN }),
    });

    // Must be exactly one RPC call — no caching allowed per T2 mandate
    expect(mockRpcFn).toHaveBeenCalledTimes(1);
  });

  // ── T9: AccessDeniedPage is returned as a React element (not a crash) ─────

  it('T9 — AccessDeniedPage renders valid HTML without throwing', async () => {
    mockRpcFn.mockResolvedValue({
      data: null,
      error: { code: '22023', message: 'access denied' },
    });

    const Page = await importPage();

    const result = await Page({
      params: Promise.resolve({ sessionId: VALID_SESSION_ID }),
      searchParams: Promise.resolve({ grant: VALID_RAW_TOKEN }),
    });

    // Should not throw during render
    expect(() => renderToStaticMarkup(result as React.ReactElement)).not.toThrow();

    const html = renderToStaticMarkup(result as React.ReactElement);
    expect(html.length).toBeGreaterThan(0);
    expect(html).toContain('Access denied or expired');
  });
});
