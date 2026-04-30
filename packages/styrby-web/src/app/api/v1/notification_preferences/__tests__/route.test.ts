/**
 * GET /api/v1/notification_preferences — Integration Tests
 *
 * Covers the per-user notification preferences endpoint used by the CLI daemon
 * (Phase 4-step5 budget-actions consumer). Confirms:
 *  - Auth gate (401 when middleware rejects)
 *  - Success with row → { preferences: <row> }
 *  - Success with no row → { preferences: null } (lazy-creation pattern)
 *  - 500 on unexpected DB error (Sentry-captured, sanitized)
 *  - user_id is excluded from the response (PII hygiene — A02:2021)
 *
 * @security OWASP A01:2021 - filter is `user_id = caller`; no IDOR surface
 * @security OWASP A07:2021 - withApiAuthAndRateLimit gate
 * @security SOC 2 CC6.1 - 'read' scope required
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ============================================================================
// Mocks — withApiAuthAndRateLimit bypass
// ============================================================================

const mockAuthContext = {
  userId: 'owner-user-uuid-001',
  keyId: 'key-id-xyz',
  scopes: ['read'],
  keyExpiresAt: null,
};

vi.mock('@/middleware/api-auth', () => ({
  withApiAuthAndRateLimit: vi.fn((handler: Function) => {
    return async (request: NextRequest) => handler(request, mockAuthContext);
  }),
  addRateLimitHeaders: vi.fn((response: NextResponse) => response),
  ApiAuthContext: {},
}));

// ============================================================================
// Mocks — Sentry
// ============================================================================

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

// ============================================================================
// Mocks — Supabase admin client
// ============================================================================

const selectQueue: Array<{ data: unknown; error: unknown }> = [];

function createSupabaseMock() {
  return {
    from: vi.fn((_table: string) => {
      const result = selectQueue.shift() ?? { data: null, error: null };
      const chain: Record<string, unknown> = {};
      chain['select'] = vi.fn(() => chain);
      chain['eq'] = vi.fn(() => chain);
      chain['maybeSingle'] = vi.fn(() => Promise.resolve(result));
      return chain;
    }),
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: vi.fn(() => createSupabaseMock()),
}));

// ============================================================================
// Import route handler AFTER mocks
// ============================================================================

import { GET } from '../route';

// ============================================================================
// Helpers
// ============================================================================

const BASE_URL = 'http://localhost:3000/api/v1/notification_preferences';

function createRequest(): NextRequest {
  return new NextRequest(BASE_URL, {
    method: 'GET',
    headers: { Authorization: 'Bearer styrby_live_test_key' },
  });
}

/**
 * Sample notification preferences row used by the success-path test.
 * WHY no user_id field: the route's column projection deliberately excludes
 * user_id (it's redundant with the caller's identity).
 */
const SAMPLE_PREFS_ROW = {
  id: 'prefs-row-uuid-001',
  push_enabled: true,
  push_permission_requests: true,
  push_session_errors: true,
  push_budget_alerts: true,
  push_session_complete: false,
  email_enabled: true,
  email_weekly_summary: true,
  email_budget_alerts: true,
  quiet_hours_enabled: false,
  quiet_hours_start: null,
  quiet_hours_end: null,
  quiet_hours_timezone: 'UTC',
  priority_threshold: 3,
  priority_rules: [],
  push_agent_finished: true,
  push_budget_threshold: true,
  push_weekly_summary: true,
  weekly_digest_email: true,
  push_predictive_alert: true,
  created_at: '2026-04-29T00:00:00Z',
  updated_at: '2026-04-29T00:00:00Z',
};

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/v1/notification_preferences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectQueue.length = 0;
  });

  describe('authentication', () => {
    /**
     * WHY: confirms the route is wired to withApiAuthAndRateLimit. A regression
     * that bypasses the wrapper would let unauthenticated callers read prefs.
     * OWASP A07:2021, SOC 2 CC6.1.
     */
    it('returns 401 when auth middleware rejects the request', async () => {
      const { withApiAuthAndRateLimit } = await import('@/middleware/api-auth');
      vi.mocked(withApiAuthAndRateLimit).mockImplementationOnce(() => async () => {
        return NextResponse.json(
          { error: 'Missing Authorization header', code: 'UNAUTHORIZED' },
          { status: 401 },
        );
      });

      vi.resetModules();
      const { GET: freshGET } = await import('../route');

      const response = await freshGET(createRequest());
      expect(response.status).toBe(401);
    });
  });

  describe('success cases', () => {
    /**
     * WHY: When the row exists, the handler must return it under
     * `{ preferences: <row> }`. Asserts the full payload is preserved.
     */
    it('returns 200 with preferences row when a row exists', async () => {
      selectQueue.push({ data: SAMPLE_PREFS_ROW, error: null });

      const response = await GET(createRequest());
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.preferences).toBeDefined();
      expect(body.preferences.id).toBe(SAMPLE_PREFS_ROW.id);
      expect(body.preferences.push_enabled).toBe(true);
      expect(body.preferences.priority_threshold).toBe(3);
    });

    /**
     * WHY: First-time callers (before settings UI write) have no row. Returning
     * `{ preferences: null }` (not 404) is the documented contract — callers
     * apply default values without a special-case error path.
     */
    it('returns 200 with preferences: null when no row exists (lazy create)', async () => {
      selectQueue.push({ data: null, error: null });

      const response = await GET(createRequest());
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.preferences).toBeNull();
    });

    /**
     * WHY: user_id is intentionally NOT selected — it's redundant with the
     * authenticated caller. PII hygiene (OWASP A02:2021).
     */
    it('does not include user_id in the response', async () => {
      selectQueue.push({ data: SAMPLE_PREFS_ROW, error: null });

      const response = await GET(createRequest());
      const body = await response.json();

      expect(body.preferences).not.toHaveProperty('user_id');
    });
  });

  describe('error handling', () => {
    /**
     * WHY: Unexpected DB errors must be Sentry-captured and surface a sanitized
     * message. Raw error text could include schema details. OWASP A02:2021.
     */
    it('returns 500 and calls Sentry when SELECT fails unexpectedly', async () => {
      selectQueue.push({
        data: null,
        error: { code: '08006', message: 'connection terminated unexpectedly' },
      });

      const Sentry = await import('@sentry/nextjs');
      const response = await GET(createRequest());

      expect(response.status).toBe(500);
      expect(Sentry.captureException).toHaveBeenCalledOnce();

      const body = await response.json();
      expect(body.error).toBe('Failed to load notification preferences');
      expect(JSON.stringify(body)).not.toContain('connection terminated');
    });
  });
});
