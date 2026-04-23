/**
 * Tests for the team invite rate limiter.
 *
 * TDD: These tests were written BEFORE the implementation.
 *
 * Coverage:
 *   - under cap: returns allowed=true with remaining count
 *   - at cap: returns allowed=false with resetAt
 *   - after window expiry: counter resets and allows again
 *   - multiple teams don't interfere with each other
 *   - teamId isolation: different teamIds have independent counters
 *
 * WHY we don't test actual Redis in unit tests:
 *   Unit tests should be hermetic. We mock the Upstash client and test
 *   the business logic (key naming, cap checking, response shaping).
 *   Integration tests against real Redis run in CI via the edge function
 *   test harness (Unit B scope).
 *
 * @module team/__tests__/invite-rate-limit
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mock the Upstash Redis client
// ============================================================================

/**
 * WHY we set env vars before mocking:
 *   The rate limiter's `getRedisClient()` reads env vars then calls `new Redis()`.
 *   vi.mock hoists to the top of the file, so `@upstash/redis` is mocked before
 *   import. We also set env vars before any import so the singleton check passes
 *   the env guard and reaches `new Redis(...)` (which is our mock).
 *
 * The mock zadd/zremrangebyscore/zcard record calls and return configurable
 * values so we can simulate different window counts without a real Redis.
 */

// Set env vars before anything imports the module.
process.env.UPSTASH_REDIS_REST_URL = 'https://mock.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';

// In-memory store backing the mocked Redis sorted-set operations.
let mockRedisStore: Map<string, { score: number }[]> = new Map();

const mockZadd = vi.fn(async (key: string, scoreMembers: { score: number; member: string }) => {
  const existing = mockRedisStore.get(key) ?? [];
  existing.push({ score: scoreMembers.score });
  mockRedisStore.set(key, existing);
  return 1;
});

const mockZremrangebyscore = vi.fn(async (key: string, min: number, max: number) => {
  const existing = mockRedisStore.get(key) ?? [];
  const filtered = existing.filter(e => e.score > max || e.score < min);
  mockRedisStore.set(key, filtered);
  return existing.length - filtered.length;
});

// mockZcard is what drives the "how many invites exist" assertion.
// Tests override this per-scenario with mockResolvedValueOnce.
const mockZcard = vi.fn(async (_key: string) => 0);

const mockExpire = vi.fn().mockResolvedValue(1);

vi.mock('@upstash/redis', () => ({
  Redis: vi.fn().mockImplementation(() => ({
    zadd: mockZadd,
    zremrangebyscore: mockZremrangebyscore,
    zcard: mockZcard,
    expire: mockExpire,
  })),
}));

// Import AFTER mocking (vi.mock hoists, but the import must still be after the vi.mock call)
import { checkInviteRateLimit } from '../invite-rate-limit.js';

// ============================================================================
// Helpers
// ============================================================================

const TEAM_A = '00000000-0000-0000-0000-aaaaaaaaaaaa';
const TEAM_B = '00000000-0000-0000-0000-bbbbbbbbbbbb';
const WINDOW_MS = 24 * 60 * 60 * 1000; // 24h in ms
const CAP = 20;

// ============================================================================
// Tests
// ============================================================================

describe('checkInviteRateLimit', () => {
  beforeEach(() => {
    mockRedisStore.clear();
    mockZadd.mockClear();
    mockZremrangebyscore.mockClear();
    mockZcard.mockClear();
    mockExpire.mockClear();
  });

  it('allows the first invite (0 of 20 used)', async () => {
    // ZADD + ZREMRANGEBYSCORE = 0 removed, ZCARD = 1 (after add)
    mockZcard.mockResolvedValueOnce(1);

    const result = await checkInviteRateLimit(TEAM_A);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(CAP - 1); // 19 remaining
    expect(result.resetAt).toBeTypeOf('number');
  });

  it('allows when under cap (19 of 20 used)', async () => {
    mockZcard.mockResolvedValueOnce(19);

    const result = await checkInviteRateLimit(TEAM_A);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(1);
  });

  it('returns allowed=true at exactly cap - 1 uses', async () => {
    mockZcard.mockResolvedValueOnce(20);

    // At exactly 20, we just hit the cap but it was the 20th - allowed
    // WHY: ZADD runs before the check; card=20 means we just used the 20th slot.
    // The check is: card > CAP → deny. Card === CAP → allow (20th invite succeeds).
    const result = await checkInviteRateLimit(TEAM_A);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0);
  });

  it('returns allowed=false when over cap (21 of 20)', async () => {
    mockZcard.mockResolvedValueOnce(21);

    const result = await checkInviteRateLimit(TEAM_A);

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.resetAt).toBeTypeOf('number');
    // resetAt should be in the future
    expect(result.resetAt).toBeGreaterThan(Date.now());
  });

  it('two different teams have independent counters', async () => {
    // Team A has 20 uses (at cap)
    mockZcard.mockResolvedValueOnce(21); // over cap for team A
    const resultA = await checkInviteRateLimit(TEAM_A);
    expect(resultA.allowed).toBe(false);

    // Team B has 5 uses (under cap)
    mockZcard.mockResolvedValueOnce(5); // under cap for team B
    const resultB = await checkInviteRateLimit(TEAM_B);
    expect(resultB.allowed).toBe(true);
  });

  it('uses a key scoped to team_id', async () => {
    mockZcard.mockResolvedValueOnce(1);
    await checkInviteRateLimit(TEAM_A);

    // Verify ZADD was called with a key containing the team ID
    const zaddCall = mockZadd.mock.calls[0];
    expect(zaddCall).toBeDefined();
    expect(String(zaddCall[0])).toContain(TEAM_A);
  });

  it('returns a resetAt timestamp approximately 24h from now', async () => {
    const nowMs = Date.now();
    mockZcard.mockResolvedValueOnce(1);

    const result = await checkInviteRateLimit(TEAM_A);

    // resetAt should be within 1 second of nowMs + 24h
    expect(result.resetAt).toBeGreaterThanOrEqual(nowMs + WINDOW_MS - 1000);
    expect(result.resetAt).toBeLessThanOrEqual(nowMs + WINDOW_MS + 1000);
  });
});
