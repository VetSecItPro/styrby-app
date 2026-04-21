/**
 * Agent Configs API Route Tests
 *
 * Tests GET and POST /api/agent-configs.
 *
 * WHY: The POST handler enforces the user's tier agent limit (SEC-LOGIC-002).
 * A regression here could let free users create unlimited agent configs by
 * calling Supabase directly, bypassing the quota enforcement.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ============================================================================
// Mocks
// ============================================================================

const mockGetUser = vi.fn();

const fromCallQueue: Array<{ data?: unknown; error?: unknown; count?: number }> = [];

function createChainMock() {
  const result = fromCallQueue.shift() ?? { data: null, error: null };
  const chain: Record<string, unknown> = {};

  for (const method of [
    'select', 'eq', 'order', 'limit', 'insert', 'update', 'delete', 'is', 'single',
  ]) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }

  chain['single'] = vi.fn().mockResolvedValue(result);
  chain['then'] = (resolve: (v: unknown) => void) => resolve(result);

  return chain;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: vi.fn(() => createChainMock()),
  })),
}));

vi.mock('@/lib/tier-enforcement', () => ({
  checkTierLimit: vi.fn(() => ({
    allowed: true,
    limit: 3,
    current: 0,
    tier: 'pro',
    upgradeUrl: '/pricing',
  })),
}));

vi.mock('@/lib/rateLimit', () => ({
  rateLimit: vi.fn(() => ({ allowed: true, remaining: 29 })),
  RATE_LIMITS: {
    budgetAlerts: { windowMs: 60000, maxRequests: 30 },
  },
  rateLimitResponse: vi.fn((retryAfter: number) =>
    new Response(JSON.stringify({ error: 'RATE_LIMITED' }), {
      status: 429,
      headers: { 'Retry-After': String(retryAfter) },
    })
  ),
}));

// @styrby/shared TIER_LIMITS
vi.mock('@styrby/shared', () => ({
  TIER_LIMITS: {
    free: { maxAgents: 1 },
    pro: { maxAgents: 3 },
    power: { maxAgents: 9 },
  },
}));

import { GET, POST } from '../route';
import { checkTierLimit } from '@/lib/tier-enforcement';

// ============================================================================
// Helpers
// ============================================================================

const AUTH_USER = { id: 'user-uuid-abc', email: 'dev@example.com' };

function mockAuthenticated() {
  mockGetUser.mockResolvedValue({ data: { user: AUTH_USER }, error: null });
}

function mockUnauthenticated() {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'Not authenticated' } });
}

function makePostRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/agent-configs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
    body: JSON.stringify(body),
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('Agent Configs API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromCallQueue.length = 0;
  });

  // --------------------------------------------------------------------------
  // Authentication
  // --------------------------------------------------------------------------

  describe('authentication', () => {
    it('GET returns 401 when unauthenticated', async () => {
      mockUnauthenticated();
      const res = await GET();
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('UNAUTHORIZED');
    });

    it('POST returns 401 when unauthenticated', async () => {
      mockUnauthenticated();
      const res = await POST(makePostRequest({ agentType: 'claude' }));
      expect(res.status).toBe(401);
    });
  });

  // --------------------------------------------------------------------------
  // GET /api/agent-configs
  // --------------------------------------------------------------------------

  describe('GET /api/agent-configs', () => {
    it('returns configs with tier and maxAgents for authenticated user', async () => {
      mockAuthenticated();
      // 1. agent_configs select
      fromCallQueue.push({ data: [{ id: 'cfg-1', agent_type: 'claude', is_enabled: true }], error: null });
      // 2. subscriptions select (tier lookup)
      fromCallQueue.push({ data: { tier: 'pro' }, error: null });

      const res = await GET();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.configs).toHaveLength(1);
      expect(body.tier).toBe('pro');
      expect(body.maxAgents).toBe(3);
      expect(body.configCount).toBe(1);
    });

    it('returns empty configs array and defaults to free tier', async () => {
      mockAuthenticated();
      fromCallQueue.push({ data: [], error: null });
      fromCallQueue.push({ data: null, error: null }); // no subscription → free

      const res = await GET();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.configs).toHaveLength(0);
      expect(body.tier).toBe('free');
      expect(body.maxAgents).toBe(1);
    });

    it('returns 500 on DB fetch error', async () => {
      mockAuthenticated();
      fromCallQueue.push({ data: null, error: { message: 'DB down' } });

      const res = await GET();
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('INTERNAL_ERROR');
    });
  });

  // --------------------------------------------------------------------------
  // POST /api/agent-configs
  // --------------------------------------------------------------------------

  describe('POST /api/agent-configs — input validation', () => {
    it('rejects invalid agentType', async () => {
      mockAuthenticated();
      const res = await POST(makePostRequest({ agentType: 'gpt-5' }));
      expect(res.status).toBe(400);
    });

    it('rejects temperature out of range', async () => {
      mockAuthenticated();
      const res = await POST(makePostRequest({ agentType: 'claude', temperature: 3.5 }));
      expect(res.status).toBe(400);
    });

    it('rejects customSystemPrompt exceeding 50,000 chars', async () => {
      mockAuthenticated();
      const res = await POST(makePostRequest({ agentType: 'claude', customSystemPrompt: 'x'.repeat(50_001) }));
      expect(res.status).toBe(400);
    });

    it('rejects autoApprovePatterns exceeding 50 entries', async () => {
      mockAuthenticated();
      const patterns = Array.from({ length: 51 }, (_, i) => `pattern-${i}`);
      const res = await POST(makePostRequest({ agentType: 'claude', autoApprovePatterns: patterns }));
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/agent-configs — tier enforcement', () => {
    it('returns 403 when tier limit exceeded', async () => {
      mockAuthenticated();
      vi.mocked(checkTierLimit).mockResolvedValueOnce({
        allowed: false as const,
        limit: 1,
        current: 1,
        tier: 'free' as const,
        upgradeUrl: '/pricing' as const,
      });

      const res = await POST(makePostRequest({ agentType: 'claude' }));
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('TIER_LIMIT_EXCEEDED');
    });
  });

  describe('POST /api/agent-configs — happy path', () => {
    it('creates config and returns 201 with the new config', async () => {
      mockAuthenticated();
      vi.mocked(checkTierLimit).mockResolvedValueOnce({
        allowed: true as const,
      });
      const newConfig = { id: 'cfg-new', agent_type: 'claude', is_enabled: true };
      fromCallQueue.push({ data: newConfig, error: null });

      const res = await POST(makePostRequest({ agentType: 'claude' }));
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.config.agent_type).toBe('claude');
    });

    it('returns 409 when config already exists for agent type', async () => {
      mockAuthenticated();
      vi.mocked(checkTierLimit).mockResolvedValueOnce({
        allowed: true as const,
      });
      fromCallQueue.push({ data: null, error: { code: '23505', message: 'unique violation' } });

      const res = await POST(makePostRequest({ agentType: 'codex' }));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe('CONFLICT');
    });
  });

  describe('POST /api/agent-configs — rate limit', () => {
    it('returns 429 when rate limited', async () => {
      const { rateLimit } = await import('@/lib/rateLimit');
      vi.mocked(rateLimit).mockResolvedValueOnce({ allowed: false, retryAfter: 30, remaining: 0, resetAt: Date.now() + 30000 });

      mockAuthenticated();
      const res = await POST(makePostRequest({ agentType: 'claude' }));
      expect(res.status).toBe(429);
    });
  });
});
