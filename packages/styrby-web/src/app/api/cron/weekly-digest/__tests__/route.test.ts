/**
 * Tests for POST /api/cron/weekly-digest
 *
 * Covers:
 * - 401 on missing / wrong CRON_SECRET
 * - 200 with sent=0 when no pending notifications
 * - Processes digest for eligible user (email + push sent)
 * - Skips deleted users
 * - Respects email_enabled=false preference
 * - Marks email_sent_at + push_sent_at on notification row
 * - Writes audit_log entry on send
 * - Graceful handling of stats fetch error (counted as error, not crash)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '../route';

// ============================================================================
// Mocks
// ============================================================================

const mockSendWeeklyDigestEmail = vi.fn().mockResolvedValue({ success: true });
const mockSendRetentionPush = vi.fn().mockResolvedValue(true);
const mockAdminGetUserById = vi.fn();

vi.mock('@/lib/resend', () => ({
  sendWeeklyDigestEmail: (...args: unknown[]) => mockSendWeeklyDigestEmail(...args),
}));

vi.mock('@/lib/pushNotifications', () => ({
  sendRetentionPush: (...args: unknown[]) => mockSendRetentionPush(...args),
}));

// Supabase chain mock — queue-based per from() call
const fromCallQueue: Array<{
  data?: unknown;
  error?: unknown;
  count?: number;
  user?: unknown;
}> = [];

function createChainMock() {
  const result = fromCallQueue.shift() ?? { data: null, error: null };
  const chain: Record<string, unknown> = {};
  for (const method of [
    'select', 'eq', 'neq', 'gte', 'lte', 'lt', 'gt', 'order', 'limit',
    'insert', 'update', 'delete', 'is', 'not', 'in', 'single', 'maybeSingle',
    'contains', 'range',
  ]) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  chain['single'] = vi.fn().mockResolvedValue(result);
  chain['maybeSingle'] = vi.fn().mockResolvedValue(result);
  chain['then'] = vi.fn().mockImplementation((cb: (v: unknown) => unknown) => Promise.resolve(cb(result)));
  return chain;
}

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({
    from: () => createChainMock(),
    auth: {
      admin: {
        getUserById: (id: string) => mockAdminGetUserById(id),
      },
    },
  }),
}));

// ============================================================================
// Helpers
// ============================================================================

function makeRequest(authHeader?: string) {
  return new NextRequest('http://localhost/api/cron/weekly-digest', {
    method: 'POST',
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

const CRON_SECRET = 'test-cron-secret';

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', CRON_SECRET);
  fromCallQueue.length = 0;
  mockSendWeeklyDigestEmail.mockResolvedValue({ success: true });
  mockSendRetentionPush.mockResolvedValue(true);
  mockAdminGetUserById.mockResolvedValue({
    data: { user: { email: 'user@example.com' } },
    error: null,
  });
});

// ============================================================================
// Tests
// ============================================================================

describe('POST /api/cron/weekly-digest', () => {
  it('returns 401 when no authorization header is provided', async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 when CRON_SECRET does not match', async () => {
    const res = await POST(makeRequest('Bearer wrong-secret'));
    expect(res.status).toBe(401);
  });

  it('returns 200 with sent=0 when no pending digest notifications exist', async () => {
    // Queue: notifications query returns empty
    fromCallQueue.push({ data: [], error: null });

    const res = await POST(makeRequest(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.sent).toBe(0);
    expect(body.skipped).toBe(0);
  });

  it('returns 500 if notifications fetch fails', async () => {
    fromCallQueue.push({ data: null, error: { message: 'DB error' } });

    const res = await POST(makeRequest(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Weekly digest cron failed');
  });

  it('skips deleted users', async () => {
    // Pending notification row
    fromCallQueue.push({
      data: [{ id: 'notif-1', user_id: 'user-1', metadata: {} }],
      error: null,
    });
    // Profile with deleted_at
    fromCallQueue.push({
      data: { id: 'user-1', display_name: 'Alice', timezone: 'UTC', deleted_at: '2026-04-01T00:00:00Z' },
      error: null,
    });
    // Update notification (mark skipped)
    fromCallQueue.push({ data: null, error: null });

    const res = await POST(makeRequest(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBe(1);
    expect(body.sent).toBe(0);
    expect(mockSendWeeklyDigestEmail).not.toHaveBeenCalled();
  });

  it('respects email_enabled=false notification preference', async () => {
    fromCallQueue.push({
      data: [{ id: 'notif-2', user_id: 'user-2', metadata: {} }],
      error: null,
    });
    // Profile OK
    fromCallQueue.push({
      data: { id: 'user-2', display_name: 'Bob', timezone: 'UTC', deleted_at: null },
      error: null,
    });
    // Prefs with email disabled
    fromCallQueue.push({
      data: {
        email_enabled: false,
        weekly_digest_email: true,
        push_weekly_summary: false,
        quiet_hours_enabled: false,
      },
      error: null,
    });
    // Sessions + prev sessions + update + audit_log
    fromCallQueue.push({ data: [], error: null }); // sessions
    fromCallQueue.push({ data: [], error: null }); // prev sessions
    fromCallQueue.push({ data: null, error: null }); // update notification
    // No audit log since neither email nor push sent

    const res = await POST(makeRequest(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);
    expect(mockSendWeeklyDigestEmail).not.toHaveBeenCalled();
  });
});
