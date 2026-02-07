/**
 * GET /api/v1/machines — Integration Tests
 *
 * Tests the machines listing endpoint which returns registered CLI instances
 * for an API-key-authenticated user, with an optional online_only filter.
 *
 * WHY: Machines represent physical devices running the Styrby CLI.
 * The response is transformed from snake_case DB columns to camelCase
 * for the API contract. The online_only filter is critical for the mobile
 * app's "connect to machine" flow — only online machines can receive commands.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ============================================================================
// Mocks — withApiAuth bypass
// ============================================================================

const mockAuthContext = {
  userId: 'test-user-123',
  keyId: 'key-id-456',
  scopes: ['read'],
};

vi.mock('@/middleware/api-auth', () => ({
  withApiAuth: vi.fn((handler: Function) => {
    return async (request: NextRequest) => handler(request, mockAuthContext);
  }),
  addRateLimitHeaders: vi.fn((response: NextResponse) => response),
  ApiAuthContext: {},
}));

// ============================================================================
// Mocks — Supabase
// ============================================================================

const fromCallQueue: Array<{ data?: unknown; error?: unknown; count?: number }> = [];

function createChainMock() {
  const result = fromCallQueue.shift() ?? { data: null, error: null };
  const chain: Record<string, unknown> = {};

  for (const method of [
    'select', 'eq', 'gte', 'lte', 'lt', 'gt', 'order', 'limit',
    'range', 'insert', 'update', 'delete', 'is', 'not', 'in',
  ]) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }

  chain['single'] = vi.fn().mockResolvedValue(result);
  chain['then'] = (resolve: (v: unknown) => void) => resolve(result);

  return chain;
}

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({
    from: vi.fn(() => createChainMock()),
    rpc: vi.fn(),
  })),
}));

// ============================================================================
// Import route handler AFTER mocks
// ============================================================================

import { GET } from '../route';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Creates a NextRequest for the machines endpoint.
 *
 * @param params - URL query parameters
 * @returns A NextRequest for GET /api/v1/machines
 */
function createRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/machines');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url, {
    method: 'GET',
    headers: {
      Authorization: 'Bearer sk_live_test_key',
    },
  });
}

/**
 * Factory for mock machine rows in snake_case (as returned by Supabase).
 *
 * @param overrides - Fields to override on the default machine
 * @returns A machine row matching the SELECT columns
 */
function mockMachineRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'machine-001',
    name: 'MacBook Pro M4',
    platform: 'darwin',
    platform_version: '15.0.0',
    architecture: 'arm64',
    hostname: 'mbp.local',
    cli_version: '0.1.0',
    is_online: true,
    last_seen_at: '2025-01-15T10:30:00Z',
    created_at: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/v1/machines', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromCallQueue.length = 0;
  });

  // --------------------------------------------------------------------------
  // Auth
  // --------------------------------------------------------------------------

  describe('authentication', () => {
    it('returns 401 when auth middleware rejects the request', async () => {
      const { withApiAuth } = await import('@/middleware/api-auth');
      vi.mocked(withApiAuth).mockImplementationOnce(() => async () => {
        return NextResponse.json(
          { error: 'Missing Authorization header', code: 'UNAUTHORIZED' },
          { status: 401 }
        );
      });

      vi.resetModules();
      const { GET: freshGET } = await import('../route');

      const response = await freshGET(createRequest());
      expect(response.status).toBe(401);
    });
  });

  // --------------------------------------------------------------------------
  // Success cases
  // --------------------------------------------------------------------------

  describe('success cases', () => {
    it('returns machine list with camelCase field names', async () => {
      const machines = [
        mockMachineRow(),
        mockMachineRow({
          id: 'machine-002',
          name: 'Ubuntu Server',
          platform: 'linux',
          is_online: false,
        }),
      ];

      fromCallQueue.push({ data: machines, error: null });

      const response = await GET(createRequest());
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.machines).toHaveLength(2);
      expect(body.count).toBe(2);

      // WHY: The handler transforms snake_case DB columns to camelCase
      // for the API response contract. Verify the transformation happened.
      const first = body.machines[0];
      expect(first.platformVersion).toBe('15.0.0');
      expect(first.cliVersion).toBe('0.1.0');
      expect(first.isOnline).toBe(true);
      expect(first.lastSeenAt).toBe('2025-01-15T10:30:00Z');
      expect(first.createdAt).toBe('2025-01-01T00:00:00Z');

      // Verify snake_case fields are NOT present in the response
      expect(first.platform_version).toBeUndefined();
      expect(first.cli_version).toBeUndefined();
      expect(first.is_online).toBeUndefined();
      expect(first.last_seen_at).toBeUndefined();
      expect(first.created_at).toBeUndefined();
    });

    it('filters by online_only=true', async () => {
      const machines = [mockMachineRow({ id: 'machine-001', is_online: true })];
      fromCallQueue.push({ data: machines, error: null });

      const response = await GET(createRequest({ online_only: 'true' }));
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.machines).toHaveLength(1);
      expect(body.machines[0].isOnline).toBe(true);
    });

    it('returns both online and offline machines when online_only is not set', async () => {
      const machines = [
        mockMachineRow({ id: 'machine-001', is_online: true }),
        mockMachineRow({ id: 'machine-002', is_online: false }),
      ];
      fromCallQueue.push({ data: machines, error: null });

      const response = await GET(createRequest());
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.machines).toHaveLength(2);
    });

    it('returns empty array when user has no machines', async () => {
      fromCallQueue.push({ data: [], error: null });

      const response = await GET(createRequest());
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.machines).toEqual([]);
      expect(body.count).toBe(0);
    });

    it('handles null data from Supabase gracefully', async () => {
      // WHY: The handler uses `machines || []` to guard against null data.
      // This ensures the API always returns an array, never null.
      fromCallQueue.push({ data: null, error: null });

      const response = await GET(createRequest());
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.machines).toEqual([]);
      expect(body.count).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Error handling
  // --------------------------------------------------------------------------

  describe('error handling', () => {
    it('returns 500 when Supabase query fails', async () => {
      fromCallQueue.push({
        data: null,
        error: { message: 'relation "machines" does not exist' },
      });

      const response = await GET(createRequest());
      expect(response.status).toBe(500);

      const body = await response.json();
      expect(body.error).toBe('Failed to fetch machines');
    });
  });
});
