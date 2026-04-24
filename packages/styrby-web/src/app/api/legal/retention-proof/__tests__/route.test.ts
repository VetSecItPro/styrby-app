/**
 * Tests for GET /api/legal/retention-proof
 *
 * Coverage:
 *   - Happy path: returns JSON with sessions_purged_30d (number) + as_of (ISO string)
 *   - Happy path: includes Cache-Control: public, max-age=3600 header
 *   - DB error: returns 503 + { error: true }
 *   - DB error: no Cache-Control: public on error response
 *   - Zero sessions purged: valid response with count 0
 *   - Response shape matches RetentionProofResponse type contract
 *
 * WHY: This API drives the live-proof section on /legal/retention-proof.
 * If it silently returns wrong data (e.g., NaN count), the public compliance
 * page displays misleading information.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock Sentry — we don't want real Sentry calls in tests
vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));

// Track calls to captureException for error path assertions
import * as Sentry from '@sentry/nextjs';
const mockCaptureException = vi.mocked(Sentry.captureException);

// Chainable Supabase query builder factory.
// WHY: The route builds: supabase.from('sessions').select(...).not(...).gte(...) — all chainable.
// We need full chain support ending in a promise-like that resolves { count, error }.
function createQueryChain(result: { count: number | null; error: unknown }) {
  const chain: Record<string, unknown> = {};
  const chainMethods = ['select', 'not', 'gte', 'lte', 'eq', 'is', 'order', 'limit'];
  for (const method of chainMethods) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  // The final awaited value
  chain['then'] = (resolve: (v: unknown) => void) => {
    return Promise.resolve(result).then(resolve);
  };
  return chain;
}

// Mutable mock state — tests set these
let mockQueryResult: { count: number | null; error: unknown } = { count: 0, error: null };

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: vi.fn(() => ({
    from: vi.fn(() => createQueryChain(mockQueryResult)),
  })),
}));

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

import { GET } from '../route';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/legal/retention-proof', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock result to happy path
    mockQueryResult = { count: 42, error: null };
  });

  describe('happy path', () => {
    it('returns 200 with correct JSON shape', async () => {
      mockQueryResult = { count: 42, error: null };

      const response = await GET();
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body).toMatchObject({
        sessions_purged_30d: 42,
        as_of: expect.any(String),
      });
    });

    it('as_of is a valid ISO 8601 string', async () => {
      mockQueryResult = { count: 10, error: null };

      const response = await GET();
      const body = await response.json();

      const parsed = new Date(body.as_of);
      expect(isNaN(parsed.getTime())).toBe(false);
    });

    it('returns Cache-Control: public, max-age=3600', async () => {
      mockQueryResult = { count: 5, error: null };

      const response = await GET();
      const cacheControl = response.headers.get('Cache-Control');

      expect(cacheControl).toContain('public');
      expect(cacheControl).toContain('max-age=3600');
    });

    it('returns 0 when no sessions were purged', async () => {
      mockQueryResult = { count: 0, error: null };

      const response = await GET();
      const body = await response.json();

      expect(body.sessions_purged_30d).toBe(0);
    });

    it('handles null count gracefully (Supabase returns null for empty result)', async () => {
      mockQueryResult = { count: null, error: null };

      const response = await GET();
      expect(response.status).toBe(200);

      const body = await response.json();
      // Null should be coerced to 0
      expect(body.sessions_purged_30d).toBe(0);
    });

    it('does not call captureException on success', async () => {
      mockQueryResult = { count: 7, error: null };

      await GET();

      expect(mockCaptureException).not.toHaveBeenCalled();
    });
  });

  describe('error path — DB failure', () => {
    it('returns 503 when DB query returns an error', async () => {
      mockQueryResult = { count: null, error: { message: 'connection refused', code: '08006' } };

      const response = await GET();
      expect(response.status).toBe(503);
    });

    it('returns { error: true } body on DB failure', async () => {
      mockQueryResult = { count: null, error: { message: 'timeout' } };

      const response = await GET();
      const body = await response.json();

      expect(body).toEqual({ error: true });
    });

    it('does not include public Cache-Control on error response', async () => {
      mockQueryResult = { count: null, error: { message: 'timeout' } };

      const response = await GET();
      const cacheControl = response.headers.get('Cache-Control');

      // Error responses must not be cached publicly
      expect(cacheControl).not.toContain('public');
    });

    it('calls captureException with the DB error on failure', async () => {
      const dbError = { message: 'relation does not exist', code: '42P01' };
      mockQueryResult = { count: null, error: dbError };

      await GET();

      expect(mockCaptureException).toHaveBeenCalledWith(
        dbError,
        expect.objectContaining({
          tags: { route: 'GET /api/legal/retention-proof' },
        })
      );
    });
  });
});
