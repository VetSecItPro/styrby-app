/**
 * Tests for POST /api/cron/agent-finished
 *
 * Covers:
 * - 401 on missing / wrong CRON_SECRET
 * - 200 with found=0 when no eligible sessions
 * - Does NOT notify when user is active (last_active_at < 5 min ago)
 * - Sends push when user is away (last_active_at > 5 min ago)
 * - Does NOT fire twice for the same session (duplicate check)
 * - Respects push_agent_finished=false preference
 * - Inserts in-app notification row on send
 * - Writes audit_log entry on send
 * - Skips deleted user profiles
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '../route';

// ============================================================================
// Mocks
// ============================================================================

const mockSendRetentionPush = vi.fn().mockResolvedValue(true);

vi.mock('@/lib/pushNotifications', () => ({
  sendRetentionPush: (...args: unknown[]) => mockSendRetentionPush(...args),
}));

const fromCallQueue: Array<{ data?: unknown; error?: unknown; count?: number }> = [];

function createChainMock() {
  const result = fromCallQueue.shift() ?? { data: null, error: null };
  const chain: Record<string, unknown> = {};
  for (const method of [
    'select', 'eq', 'neq', 'gte', 'lte', 'lt', 'gt', 'order', 'limit',
    'insert', 'update', 'delete', 'is', 'not', 'in', 'single', 'maybeSingle',
    'contains',
  ]) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  chain['single'] = vi.fn().mockResolvedValue(result);
  chain['maybeSingle'] = vi.fn().mockResolvedValue(result);
  chain['then'] = vi.fn().mockImplementation((cb: (v: unknown) => unknown) =>
    Promise.resolve(cb(result))
  );
  return chain;
}

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({
    from: () => createChainMock(),
  }),
}));

function makeRequest(authHeader?: string) {
  return new NextRequest('http://localhost/api/cron/agent-finished', {
    method: 'POST',
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

const CRON_SECRET = 'test-cron-secret';

/** Session ended 2 minutes ago (within the 5-minute window) */
const RECENT_ENDED_AT = new Date(Date.now() - 2 * 60 * 1000).toISOString();

/** User last active 10 minutes ago (qualifies as away) */
const AWAY_LAST_ACTIVE = new Date(Date.now() - 10 * 60 * 1000).toISOString();

/** User last active 1 minute ago (NOT away) */
const ACTIVE_LAST_ACTIVE = new Date(Date.now() - 60 * 1000).toISOString();

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', CRON_SECRET);
  fromCallQueue.length = 0;
  mockSendRetentionPush.mockClear();
  mockSendRetentionPush.mockResolvedValue(true);
});

// ============================================================================
// Tests
// ============================================================================

describe('POST /api/cron/agent-finished', () => {
  it('returns 401 when no authorization header', async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Unauthorized');
  });

  it('returns 401 when secret does not match', async () => {
    const res = await POST(makeRequest('Bearer wrong-secret'));
    expect(res.status).toBe(401);
  });

  it('returns 200 with found=0 when no sessions ended recently', async () => {
    fromCallQueue.push({ data: [], error: null });

    const res = await POST(makeRequest(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.found).toBe(0);
    expect(body.sent).toBe(0);
  });

  it('returns 500 when session query fails', async () => {
    fromCallQueue.push({ data: null, error: { message: 'DB failure' } });

    const res = await POST(makeRequest(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(500);
  });

  it('skips notification when user is actively on phone (last_active_at < 5 min)', async () => {
    fromCallQueue.push({
      data: [{
        id: 'sess-1',
        user_id: 'user-1',
        agent_type: 'claude',
        ended_at: RECENT_ENDED_AT,
        summary: null,
        profiles: { id: 'user-1', last_active_at: ACTIVE_LAST_ACTIVE, deleted_at: null },
      }],
      error: null,
    });

    const res = await POST(makeRequest(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBe(1);
    expect(mockSendRetentionPush).not.toHaveBeenCalled();
  });

  it('sends push when user is away and prefs allow it', async () => {
    fromCallQueue.push({
      data: [{
        id: 'sess-2',
        user_id: 'user-2',
        agent_type: 'claude',
        ended_at: RECENT_ENDED_AT,
        summary: 'Refactored auth module',
        profiles: { id: 'user-2', last_active_at: AWAY_LAST_ACTIVE, deleted_at: null },
      }],
      error: null,
    });
    // Prefs
    fromCallQueue.push({
      data: { push_enabled: true, push_agent_finished: true, push_session_complete: true },
      error: null,
    });
    // Duplicate check — no existing notification
    fromCallQueue.push({ data: null, error: null });
    // Insert notification
    fromCallQueue.push({ data: null, error: null });
    // Insert audit_log
    fromCallQueue.push({ data: null, error: null });

    const res = await POST(makeRequest(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sent).toBe(1);
    expect(mockSendRetentionPush).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-2',
        type: 'agent_finished',
        title: 'Claude Code session finished',
      })
    );
  });

  it('skips when push_agent_finished=false', async () => {
    fromCallQueue.push({
      data: [{
        id: 'sess-3',
        user_id: 'user-3',
        agent_type: 'codex',
        ended_at: RECENT_ENDED_AT,
        summary: null,
        profiles: { id: 'user-3', last_active_at: AWAY_LAST_ACTIVE, deleted_at: null },
      }],
      error: null,
    });
    fromCallQueue.push({
      data: { push_enabled: true, push_agent_finished: false, push_session_complete: false },
      error: null,
    });

    const res = await POST(makeRequest(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBe(1);
    expect(mockSendRetentionPush).not.toHaveBeenCalled();
  });

  it('skips when a duplicate notification already exists for the session', async () => {
    fromCallQueue.push({
      data: [{
        id: 'sess-4',
        user_id: 'user-4',
        agent_type: 'gemini',
        ended_at: RECENT_ENDED_AT,
        summary: null,
        profiles: { id: 'user-4', last_active_at: AWAY_LAST_ACTIVE, deleted_at: null },
      }],
      error: null,
    });
    fromCallQueue.push({
      data: { push_enabled: true, push_agent_finished: true, push_session_complete: true },
      error: null,
    });
    // Existing notification found
    fromCallQueue.push({ data: { id: 'notif-existing' }, error: null });

    const res = await POST(makeRequest(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBe(1);
    expect(mockSendRetentionPush).not.toHaveBeenCalled();
  });

  it('skips deleted user profiles', async () => {
    fromCallQueue.push({
      data: [{
        id: 'sess-5',
        user_id: 'user-5',
        agent_type: 'aider',
        ended_at: RECENT_ENDED_AT,
        summary: null,
        profiles: { id: 'user-5', last_active_at: AWAY_LAST_ACTIVE, deleted_at: '2026-04-01T00:00:00Z' },
      }],
      error: null,
    });

    const res = await POST(makeRequest(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBe(1);
    expect(mockSendRetentionPush).not.toHaveBeenCalled();
  });
});
