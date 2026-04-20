/**
 * Integration Tests: POST /api/internal/test-push
 *
 * Tests the full route handler behavior with mocked dependencies.
 * Does NOT hit real APNs, FCM, or Expo Push endpoints — all external
 * calls are intercepted via vitest mocks.
 *
 * Covers:
 *   1. Unauthenticated request → 401
 *   2. Non-admin user → 403
 *   3. Missing device_token_id → 400
 *   4. Invalid UUID for device_token_id → 400
 *   5. Valid admin, token exists, push succeeds → 200
 *   6. Valid admin, token exists, push soft-fails (inactive token, edge fn
 *      returns success=false) → 200 with failure detail
 *   7. Dead-letter path: invalid token → edge fn returns success=false,
 *      failureCount > 0 → caller gets the accurate failure count
 *   8. Quiet hours active → edge fn returns success=false (quiet_hours reason)
 *   9. Device token not found → 404
 *  10. Edge function returns non-2xx → 502 propagated
 *  11. Network error calling edge function → 500
 *  12. Audit log write failure → 200 still returned (non-fatal)
 *  13. Edge function is called with timing-safe Bearer token
 *  14. Audit log metadata includes control_ref SOC2 CC7.2
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// ============================================================================
// Mock hoisting — must use vi.hoisted() so variables are available when
// vi.mock() factories are evaluated (vi.mock is hoisted to the top of the
// file by Vitest, before variable declarations).
// ============================================================================

const {
  mockGetUser,
  mockAdminSingle,
  mockAdminInsert,
  mockAdminFrom,
  mockIsAdmin,
} = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockAdminSingle: vi.fn(),
  mockAdminInsert: vi.fn(),
  mockAdminFrom: vi.fn(),
  mockIsAdmin: vi.fn(),
}));

// ============================================================================
// Mock: @/lib/supabase/server
// ============================================================================

/**
 * Supabase clients are mocked so tests don't need real DB credentials.
 */
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
  })),
  createAdminClient: vi.fn(() => ({
    from: mockAdminFrom,
  })),
}));

// ============================================================================
// Mock: @/lib/admin
// ============================================================================

vi.mock('@/lib/admin', () => ({
  isAdmin: mockIsAdmin,
}));

// ============================================================================
// Import route under test (after mocks are declared)
// ============================================================================

import { POST } from '../test-push/route';

// ============================================================================
// Mock: global fetch (for edge function call)
// ============================================================================

const mockFetch = vi.fn();
global.fetch = mockFetch;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Builds a NextRequest with a JSON body.
 *
 * @param body - Object to serialize as JSON body
 * @returns NextRequest suitable for passing to POST()
 */
function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/internal/test-push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Test fixture: a valid device token row.
 */
const VALID_DEVICE_TOKEN = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  user_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  token: 'ExponentPushToken[abcdef1234567890]',
  platform: 'ios',
  is_active: true,
};

/**
 * Standard successful edge function response.
 */
const EDGE_FN_SUCCESS = {
  success: true,
  message: 'Notification sent to 1 device(s)',
  deviceCount: 1,
  successCount: 1,
  failureCount: 0,
};

/**
 * Configures the from() mock to return select chain for device_tokens
 * and insert chain for audit_log.
 */
function setupAdminClientForTokenAndAudit(
  tokenResult: { data: unknown; error: unknown },
  auditResult: { error: unknown } = { error: null }
) {
  mockAdminFrom.mockImplementation((table: string) => {
    if (table === 'device_tokens') {
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: mockAdminSingle.mockResolvedValueOnce(tokenResult),
      };
    }
    if (table === 'audit_log') {
      return {
        insert: mockAdminInsert.mockResolvedValueOnce(auditResult),
      };
    }
    return {};
  });
}

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeEach(() => {
  vi.clearAllMocks();

  // Default env vars (overridable per test)
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
});

afterEach(() => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

// ============================================================================
// Tests
// ============================================================================

describe('POST /api/internal/test-push', () => {
  // --------------------------------------------------------------------------
  // Authentication & Authorization
  // --------------------------------------------------------------------------

  it('1. returns 401 for unauthenticated request', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: null },
      error: new Error('Not authenticated'),
    });

    const res = await POST(makeRequest({ device_token_id: VALID_DEVICE_TOKEN.id }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Unauthorized');
  });

  it('2. returns 403 for authenticated non-admin user', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: 'user-123' } },
      error: null,
    });
    mockIsAdmin.mockResolvedValueOnce(false);

    const res = await POST(makeRequest({ device_token_id: VALID_DEVICE_TOKEN.id }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
  });

  // --------------------------------------------------------------------------
  // Input Validation
  // --------------------------------------------------------------------------

  it('3. returns 400 when device_token_id is missing', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: { id: 'admin-1' } }, error: null });
    mockIsAdmin.mockResolvedValueOnce(true);

    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    const body = await res.json();
    // WHY: Zod returns "Required" (not the field name) when a required field is absent.
    // We verify the error field exists and is a non-empty string indicating a validation failure.
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);
  });

  it('4. returns 400 when device_token_id is not a valid UUID', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: { id: 'admin-1' } }, error: null });
    mockIsAdmin.mockResolvedValueOnce(true);

    const res = await POST(makeRequest({ device_token_id: 'not-a-uuid' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/uuid/i);
  });

  // --------------------------------------------------------------------------
  // Happy Path
  // --------------------------------------------------------------------------

  it('5. valid admin + valid token + edge fn success → 200', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: { id: 'admin-1' } }, error: null });
    mockIsAdmin.mockResolvedValueOnce(true);

    setupAdminClientForTokenAndAudit(
      { data: VALID_DEVICE_TOKEN, error: null },
      { error: null }
    );

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => EDGE_FN_SUCCESS,
    });

    const res = await POST(makeRequest({ device_token_id: VALID_DEVICE_TOKEN.id }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.edgeFunctionResponse).toEqual(EDGE_FN_SUCCESS);

    // Verify edge function was called with correct Authorization header
    expect(mockFetch).toHaveBeenCalledWith(
      'https://test.supabase.co/functions/v1/send-push-notification',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-service-role-key',
        }),
      })
    );
  });

  // --------------------------------------------------------------------------
  // Soft-failure / Dead-letter paths
  // --------------------------------------------------------------------------

  it('6. edge fn returns success=false (push_disabled) → 200 with failure detail', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: { id: 'admin-1' } }, error: null });
    mockIsAdmin.mockResolvedValueOnce(true);

    setupAdminClientForTokenAndAudit(
      { data: VALID_DEVICE_TOKEN, error: null },
      { error: null }
    );

    const edgeFnDisabledResponse = {
      success: false,
      message: 'Notification blocked: push_disabled',
      deviceCount: 1,
      successCount: 0,
      failureCount: 0,
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => edgeFnDisabledResponse,
    });

    const res = await POST(makeRequest({ device_token_id: VALID_DEVICE_TOKEN.id }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.edgeFunctionResponse.message).toMatch(/push_disabled/);
  });

  it('7. dead-letter path: invalid token → edge fn reports failureCount > 0', async () => {
    // WHY: When Expo reports DeviceNotRegistered, the edge function deactivates
    // the token (dead-letter behavior) and returns failureCount > 0 / successCount 0.
    // The route should surface this accurately to the caller so the admin knows
    // the token was dead-lettered.

    mockGetUser.mockResolvedValueOnce({ data: { user: { id: 'admin-1' } }, error: null });
    mockIsAdmin.mockResolvedValueOnce(true);

    const inactiveToken = { ...VALID_DEVICE_TOKEN, is_active: false };
    setupAdminClientForTokenAndAudit(
      { data: inactiveToken, error: null },
      { error: null }
    );

    const deadLetterResponse = {
      success: false,
      message: 'Sent to 0 device(s), 1 failed',
      deviceCount: 1,
      successCount: 0,
      failureCount: 1,
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => deadLetterResponse,
    });

    const res = await POST(makeRequest({ device_token_id: inactiveToken.id }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.edgeFunctionResponse.failureCount).toBe(1);
    expect(body.edgeFunctionResponse.successCount).toBe(0);
  });

  it('8. quiet hours active → edge fn returns success=false with quiet_hours reason', async () => {
    // WHY: Quiet hours are enforced by the edge function, not this route.
    // This test confirms we surface the suppression reason accurately and
    // return 200 (not an error) because the push being blocked is expected
    // behavior, not a server failure.
    // Governing standard: GDPR Art. 25 (privacy by design - DND enforcement).

    mockGetUser.mockResolvedValueOnce({ data: { user: { id: 'admin-1' } }, error: null });
    mockIsAdmin.mockResolvedValueOnce(true);

    setupAdminClientForTokenAndAudit(
      { data: VALID_DEVICE_TOKEN, error: null },
      { error: null }
    );

    const quietHoursResponse = {
      success: false,
      message: 'Notification blocked: quiet_hours',
      deviceCount: 1,
      successCount: 0,
      failureCount: 0,
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => quietHoursResponse,
    });

    const res = await POST(makeRequest({ device_token_id: VALID_DEVICE_TOKEN.id }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.edgeFunctionResponse.message).toMatch(/quiet_hours/);
  });

  // --------------------------------------------------------------------------
  // Error paths
  // --------------------------------------------------------------------------

  it('9. device token not found → 404', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: { id: 'admin-1' } }, error: null });
    mockIsAdmin.mockResolvedValueOnce(true);

    setupAdminClientForTokenAndAudit(
      { data: null, error: { code: 'PGRST116', message: 'Not found' } },
      { error: null }
    );

    const res = await POST(makeRequest({ device_token_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc' }));
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBe('Device token not found');
  });

  it('10. edge function returns non-2xx → 502 propagated to caller', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: { id: 'admin-1' } }, error: null });
    mockIsAdmin.mockResolvedValueOnce(true);

    setupAdminClientForTokenAndAudit(
      { data: VALID_DEVICE_TOKEN, error: null },
      { error: null }
    );

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable',
    });

    const res = await POST(makeRequest({ device_token_id: VALID_DEVICE_TOKEN.id }));
    expect(res.status).toBe(502);

    const body = await res.json();
    expect(body.error).toMatch(/503/);
  });

  it('11. network error calling edge function → 500', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: { id: 'admin-1' } }, error: null });
    mockIsAdmin.mockResolvedValueOnce(true);

    setupAdminClientForTokenAndAudit(
      { data: VALID_DEVICE_TOKEN, error: null },
      { error: null }
    );

    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const res = await POST(makeRequest({ device_token_id: VALID_DEVICE_TOKEN.id }));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.error).toMatch(/edge function/i);
  });

  it('12. audit log write failure → still returns 200 (non-fatal side-effect)', async () => {
    // WHY: Audit log failures must not block the push test response.
    // The push already happened. Failing to log it is a monitoring issue,
    // not a delivery failure.

    mockGetUser.mockResolvedValueOnce({ data: { user: { id: 'admin-1' } }, error: null });
    mockIsAdmin.mockResolvedValueOnce(true);

    setupAdminClientForTokenAndAudit(
      { data: VALID_DEVICE_TOKEN, error: null },
      { error: { message: 'DB write failed' } }
    );

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => EDGE_FN_SUCCESS,
    });

    const res = await POST(makeRequest({ device_token_id: VALID_DEVICE_TOKEN.id }));
    // Even though audit log failed, the route returns 200 because the push succeeded
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Payload integrity
  // --------------------------------------------------------------------------

  it('13. edge function is called with service role Bearer token (timing-safe auth)', async () => {
    // WHY: Validates the Authorization header format. The edge function uses
    // a timing-safe XOR comparison on this key — we must send it as "Bearer <key>".

    mockGetUser.mockResolvedValueOnce({ data: { user: { id: 'admin-1' } }, error: null });
    mockIsAdmin.mockResolvedValueOnce(true);

    setupAdminClientForTokenAndAudit(
      { data: VALID_DEVICE_TOKEN, error: null },
      { error: null }
    );

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => EDGE_FN_SUCCESS,
    });

    await POST(makeRequest({ device_token_id: VALID_DEVICE_TOKEN.id }));

    const [, fetchOptions] = mockFetch.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    const headers = fetchOptions.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`);
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('14. audit log metadata includes control_ref SOC2 CC7.2', async () => {
    // WHY: SOC2 CC7.2 requires evidence of system monitoring. The control_ref
    // in metadata makes the audit trail machine-searchable for compliance.

    const auditInsertMock = vi.fn().mockResolvedValueOnce({ error: null });

    mockGetUser.mockResolvedValueOnce({ data: { user: { id: 'admin-1' } }, error: null });
    mockIsAdmin.mockResolvedValueOnce(true);

    mockAdminFrom.mockImplementation((table: string) => {
      if (table === 'device_tokens') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValueOnce({ data: VALID_DEVICE_TOKEN, error: null }),
        };
      }
      if (table === 'audit_log') {
        return { insert: auditInsertMock };
      }
      return {};
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => EDGE_FN_SUCCESS,
    });

    await POST(makeRequest({ device_token_id: VALID_DEVICE_TOKEN.id }));

    const insertCall = auditInsertMock.mock.calls[0][0] as { metadata: { control_ref: string } };
    expect(insertCall.metadata.control_ref).toBe('SOC2 CC7.2');
  });
});
