/**
 * Tests for runPolicyEngine.
 *
 * These tests stub `fetch` to avoid any real network traffic — the
 * edge function itself ships in PR #3. We cover:
 *   - exit-code correctness for approved / denied / timeout / cancelled
 *   - poll cadence (respect pollIntervalMs)
 *   - cancellation via external AbortSignal cleans up the pending row
 *   - pre-check emits the expected status message
 *
 * @module approvals/__tests__/policyEngine
 */

import { describe, it, expect, vi } from 'vitest';
import { runPolicyEngine } from '../policyEngine.js';
import type { TeamPolicy } from 'styrby-shared';

const UUID = '00000000-0000-0000-0000-000000000001';

function makeFetch(
  responses: Array<
    | { status: 'pending' | 'approved' | 'denied'; approvalId?: string; reason?: string }
    | Error
  >,
): { fetchImpl: typeof fetch; calls: Array<{ body: any }> } {
  const calls: Array<{ body: any }> = [];
  let i = 0;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    calls.push({ body });
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (next instanceof Error) throw next;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      async json() {
        return {
          approvalId: next.approvalId ?? UUID,
          status: next.status,
          reason: next.reason,
        };
      },
      async text() {
        return '';
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const baseInput = {
  sessionId: UUID,
  riskLevel: 'high' as const,
  toolName: 'Bash',
  supabaseUrl: 'https://example.supabase.co',
  authToken: 'jwt',
  pollIntervalMs: 5,
  timeoutMs: 500,
};

describe('runPolicyEngine exit codes', () => {
  it('returns APPROVED (0) when server returns approved on submit', async () => {
    const { fetchImpl, calls } = makeFetch([{ status: 'approved' }]);
    const res = await runPolicyEngine({ ...baseInput, fetchImpl });
    expect(res.status).toBe('approved');
    expect(res.exitCode).toBe(0);
    expect(calls[0].body.action).toBe('submit');
  });

  it('returns DENIED (10) when server returns denied on submit', async () => {
    const { fetchImpl } = makeFetch([{ status: 'denied', reason: 'blocked' }]);
    const res = await runPolicyEngine({ ...baseInput, fetchImpl });
    expect(res.status).toBe('denied');
    expect(res.exitCode).toBe(10);
    expect(res.reason).toBe('blocked');
  });

  it('returns APPROVED after a pending poll then an approval', async () => {
    const { fetchImpl, calls } = makeFetch([
      { status: 'pending' },
      { status: 'pending' },
      { status: 'approved' },
    ]);
    const res = await runPolicyEngine({ ...baseInput, fetchImpl });
    expect(res.exitCode).toBe(0);
    // submit + 2 polls = 3 fetch calls
    expect(calls.length).toBe(3);
    expect(calls[1].body.action).toBe('poll');
    expect(calls[2].body.action).toBe('poll');
  });

  it('returns TIMEOUT (124) when polls never resolve', async () => {
    const { fetchImpl, calls } = makeFetch([{ status: 'pending' }]);
    const res = await runPolicyEngine({
      ...baseInput,
      fetchImpl,
      pollIntervalMs: 10,
      timeoutMs: 40,
    });
    expect(res.status).toBe('timeout');
    expect(res.exitCode).toBe(124);
    // at least one cancel attempted
    expect(calls.some((c) => c.body.action === 'cancel')).toBe(true);
  });
});

describe('runPolicyEngine cancellation', () => {
  it('returns CANCELLED (130) when the external signal aborts mid-poll', async () => {
    const { fetchImpl, calls } = makeFetch([{ status: 'pending' }]);
    const controller = new AbortController();
    const statusMessages: string[] = [];

    const promise = runPolicyEngine({
      ...baseInput,
      fetchImpl,
      pollIntervalMs: 50,
      timeoutMs: 5000,
      signal: controller.signal,
      onStatus: (m) => statusMessages.push(m),
    });

    // Abort after first submit settles.
    setTimeout(() => controller.abort(), 10);

    const res = await promise;
    expect(res.status).toBe('cancelled');
    expect(res.exitCode).toBe(130);
    expect(calls.some((c) => c.body.action === 'cancel')).toBe(true);
  });
});

describe('runPolicyEngine pre-check', () => {
  it('emits a "will require approval from ..." message when pre-check yields pending', async () => {
    const { fetchImpl } = makeFetch([{ status: 'approved' }]);
    const messages: string[] = [];

    const policy: TeamPolicy = {
      id: UUID,
      teamId: UUID,
      name: 'Require approval for Bash',
      description: null,
      ruleType: 'tool_allowlist',
      threshold: null,
      approverRole: 'any_admin',
      approverUserId: null,
      agentFilter: ['bash'],
      action: 'require_approval',
      settings: {},
      enabled: true,
      priority: 100,
      createdBy: UUID,
      createdAt: '2026-04-20T00:00:00.000Z',
      updatedAt: '2026-04-20T00:00:00.000Z',
    };

    await runPolicyEngine({
      ...baseInput,
      fetchImpl,
      onStatus: (m) => messages.push(m),
      preCheck: {
        policy,
        roster: [
          { userId: 'u-owner', role: 'owner', active: true },
          { userId: 'u-admin', role: 'admin', active: true },
          { userId: 'u-member', role: 'member', active: true },
        ],
        requesterUserId: 'u-member',
      },
    });

    const precheck = messages.find((m) => m.startsWith('Pre-check:'));
    expect(precheck).toBeDefined();
    expect(precheck!).toContain('require approval from');
    expect(precheck!).toContain('u-owner');
    expect(precheck!).toContain('u-admin');
  });
});

describe('runPolicyEngine SIGINT handler lifecycle', () => {
  it('does not leak SIGINT listeners across invocations', async () => {
    const { fetchImpl } = makeFetch([{ status: 'approved' }]);
    const before = process.listenerCount('SIGINT');
    await runPolicyEngine({ ...baseInput, fetchImpl });
    await runPolicyEngine({ ...baseInput, fetchImpl });
    await runPolicyEngine({ ...baseInput, fetchImpl });
    const after = process.listenerCount('SIGINT');
    expect(after).toBe(before);
  });
});
