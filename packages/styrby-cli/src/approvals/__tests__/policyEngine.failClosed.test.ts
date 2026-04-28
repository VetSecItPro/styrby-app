/**
 * H-6 regression tests — policy engine fail-closed behavior.
 *
 * Verifies three correctness properties introduced to fix audit finding H-6:
 *
 *   1. `teamId` is forwarded on the submit call so the edge function can
 *      look up the right policy and eligible approvers.
 *
 *   2. `approvalToken` returned by submit is forwarded on every subsequent
 *      poll and cancel call (ISO 27001 A.9.1 — IDOR guard).
 *
 *   3. FAIL-CLOSED: any non-2xx response or network error from the edge
 *      function results in an explicit DENY (exitCode 10) rather than a
 *      silent pass-through. This satisfies OWASP A01:2021 (Broken Access
 *      Control) — the policy engine must fail closed, never open.
 *
 * All tests stub `fetch` — no network traffic occurs.
 *
 * @module approvals/__tests__/policyEngine.failClosed
 */

import { describe, it, expect } from 'vitest';
import { POLICY_ENGINE_EXIT_CODES } from 'styrby-shared';
import { runPolicyEngine } from '../policyEngine.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const UUID = '00000000-0000-0000-0000-000000000001';
const TEAM_ID = '00000000-0000-0000-0000-000000000010';
const APPROVAL_ID = '00000000-0000-0000-0000-000000000099';
const APPROVAL_TOKEN = 'deadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678';

const BASE_INPUT = {
  sessionId: UUID,
  teamId: TEAM_ID,
  riskLevel: 'high' as const,
  toolName: 'Bash',
  supabaseUrl: 'https://test.supabase.co',
  authToken: 'test-jwt',
  pollIntervalMs: 5,
  timeoutMs: 500,
};

// ─── Fetch stub helpers ───────────────────────────────────────────────────────

/**
 * Builds a fetch stub that returns a successful submit response then
 * records all subsequent calls.
 */
function makeSuccessfulSubmitFetch(
  submitResponse: { approvalId: string; approvalToken: string; status: 'pending' | 'approved' | 'denied' },
  subsequentResponses: Array<{ approvalId: string; status: 'pending' | 'approved' | 'denied'; reason?: string }>,
): { fetchImpl: typeof fetch; calls: Array<{ url: string; body: Record<string, unknown> }> } {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let callIndex = 0;

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
    calls.push({ url: url as string, body });

    const thisIndex = callIndex++;
    // First call is submit
    const resp = thisIndex === 0
      ? { ...submitResponse, approvalToken: submitResponse.approvalToken }
      : (subsequentResponses[Math.min(thisIndex - 1, subsequentResponses.length - 1)] as { approvalId: string; status: string; reason?: string; approvalToken?: string });

    return {
      ok: true,
      status: 200,
      async json() { return { approvalToken: APPROVAL_TOKEN, ...resp }; },
      async text() { return ''; },
    } as unknown as Response;
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

/**
 * Builds a fetch stub that returns HTTP non-2xx (e.g. 404) on the first call.
 */
function makeHttpErrorFetch(httpStatus: number): typeof fetch {
  return (async (_url: string) => {
    return {
      ok: false,
      status: httpStatus,
      statusText: httpStatus === 404 ? 'Not Found' : 'Service Unavailable',
      async text() { return `{"error":"HTTP ${httpStatus}"}` ; },
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

/**
 * Builds a fetch stub that throws a network error (e.g. ECONNREFUSED).
 */
function makeNetworkErrorFetch(message: string): typeof fetch {
  return (async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}

/**
 * Builds a fetch stub that succeeds on submit but throws on the first poll.
 */
function makeSubmitOkPollErrorFetch(pollError: Error): typeof fetch {
  let callCount = 0;
  return (async (_url: string, init?: RequestInit) => {
    callCount++;
    if (callCount === 1) {
      // submit succeeds
      return {
        ok: true,
        status: 201,
        async json() {
          return { approvalId: APPROVAL_ID, approvalToken: APPROVAL_TOKEN, status: 'pending' };
        },
        async text() { return ''; },
      } as unknown as Response;
    }
    // poll throws
    throw pollError;
  }) as unknown as typeof fetch;
}

// ============================================================================
// 1. teamId is forwarded on submit
// ============================================================================

describe('H-6 — teamId forwarded on submit', () => {
  it('includes teamId in the submit request body', async () => {
    const { fetchImpl, calls } = makeSuccessfulSubmitFetch(
      { approvalId: APPROVAL_ID, approvalToken: APPROVAL_TOKEN, status: 'approved' },
      [],
    );

    await runPolicyEngine({ ...BASE_INPUT, fetchImpl });

    const submitCall = calls.find((c) => c.body.action === 'submit');
    expect(submitCall).toBeDefined();
    expect(submitCall!.body.teamId).toBe(TEAM_ID);
  });

  it('does NOT include teamId in poll requests (only approvalId + approvalToken)', async () => {
    const { fetchImpl, calls } = makeSuccessfulSubmitFetch(
      { approvalId: APPROVAL_ID, approvalToken: APPROVAL_TOKEN, status: 'pending' },
      [{ approvalId: APPROVAL_ID, status: 'approved' }],
    );

    await runPolicyEngine({ ...BASE_INPUT, fetchImpl });

    const pollCall = calls.find((c) => c.body.action === 'poll');
    expect(pollCall).toBeDefined();
    // teamId is a submit-only field; polls identify the row via approvalId + approvalToken
    expect(pollCall!.body.teamId).toBeUndefined();
  });
});

// ============================================================================
// 2. approvalToken round-trip
// ============================================================================

describe('H-6 — approvalToken forwarded on poll and cancel', () => {
  it('forwards the submit-returned approvalToken on poll requests', async () => {
    const { fetchImpl, calls } = makeSuccessfulSubmitFetch(
      { approvalId: APPROVAL_ID, approvalToken: APPROVAL_TOKEN, status: 'pending' },
      [{ approvalId: APPROVAL_ID, status: 'approved' }],
    );

    await runPolicyEngine({ ...BASE_INPUT, fetchImpl });

    const pollCall = calls.find((c) => c.body.action === 'poll');
    expect(pollCall).toBeDefined();
    expect(pollCall!.body.approvalToken).toBe(APPROVAL_TOKEN);
  });

  it('forwards the approvalToken on cancel when timeout fires', async () => {
    const { fetchImpl, calls } = makeSuccessfulSubmitFetch(
      { approvalId: APPROVAL_ID, approvalToken: APPROVAL_TOKEN, status: 'pending' },
      [{ approvalId: APPROVAL_ID, status: 'pending' }],
    );

    // Set timeoutMs < pollIntervalMs so deadline fires immediately
    await runPolicyEngine({
      ...BASE_INPUT,
      fetchImpl,
      pollIntervalMs: 100,
      timeoutMs: 1,
    });

    const cancelCall = calls.find((c) => c.body.action === 'cancel');
    expect(cancelCall).toBeDefined();
    expect(cancelCall!.body.approvalToken).toBe(APPROVAL_TOKEN);
  });

  it('forwards the approvalToken on cancel when user aborts', async () => {
    const { fetchImpl, calls } = makeSuccessfulSubmitFetch(
      { approvalId: APPROVAL_ID, approvalToken: APPROVAL_TOKEN, status: 'pending' },
      [{ approvalId: APPROVAL_ID, status: 'pending' }],
    );

    const controller = new AbortController();
    const promise = runPolicyEngine({
      ...BASE_INPUT,
      fetchImpl,
      pollIntervalMs: 50,
      timeoutMs: 5_000,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 15);
    await promise;

    const cancelCall = calls.find((c) => c.body.action === 'cancel');
    expect(cancelCall).toBeDefined();
    expect(cancelCall!.body.approvalToken).toBe(APPROVAL_TOKEN);
  });
});

// ============================================================================
// 3. Fail-closed — non-2xx HTTP on submit
// ============================================================================

describe('H-6 — fail-closed: HTTP errors on submit → DENY', () => {
  it('returns DENIED (10) when submit returns HTTP 404 (edge function not found)', async () => {
    const fetchImpl = makeHttpErrorFetch(404);
    const messages: string[] = [];

    const res = await runPolicyEngine({
      ...BASE_INPUT,
      fetchImpl,
      onStatus: (m) => messages.push(m),
    });

    // OWASP A01: fail closed, never open
    expect(res.status).toBe('denied');
    expect(res.exitCode).toBe(POLICY_ENGINE_EXIT_CODES.DENIED);
    expect(res.reason).toMatch(/policy engine unavailable/i);
    // Must emit a status message so the CLI can surface it to the user
    expect(messages.some((m) => /submit failed/i.test(m))).toBe(true);
  });

  it('returns DENIED (10) when submit returns HTTP 503 (service unavailable)', async () => {
    const fetchImpl = makeHttpErrorFetch(503);

    const res = await runPolicyEngine({ ...BASE_INPUT, fetchImpl });

    expect(res.status).toBe('denied');
    expect(res.exitCode).toBe(POLICY_ENGINE_EXIT_CODES.DENIED);
  });

  it('returns DENIED (10) when submit returns HTTP 500 (internal server error)', async () => {
    const fetchImpl = makeHttpErrorFetch(500);

    const res = await runPolicyEngine({ ...BASE_INPUT, fetchImpl });

    expect(res.status).toBe('denied');
    expect(res.exitCode).toBe(POLICY_ENGINE_EXIT_CODES.DENIED);
  });

  it('does NOT perform a cancel request when submit fails (no row was created)', async () => {
    const fetchImpl = makeHttpErrorFetch(404);
    const calls: Array<Record<string, unknown>> = [];

    const trackingFetch = (async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      calls.push(body);
      return (fetchImpl as unknown as (u: string, i?: RequestInit) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;

    await runPolicyEngine({ ...BASE_INPUT, fetchImpl: trackingFetch });

    // No cancel should be sent — the row was never created
    expect(calls.every((c) => c['action'] !== 'cancel')).toBe(true);
  });
});

// ============================================================================
// 4. Fail-closed — network errors on submit
// ============================================================================

describe('H-6 — fail-closed: network errors on submit → DENY', () => {
  it('returns DENIED (10) when submit throws ECONNREFUSED', async () => {
    const fetchImpl = makeNetworkErrorFetch('connect ECONNREFUSED 127.0.0.1:54321');

    const res = await runPolicyEngine({ ...BASE_INPUT, fetchImpl });

    expect(res.status).toBe('denied');
    expect(res.exitCode).toBe(POLICY_ENGINE_EXIT_CODES.DENIED);
    expect(res.reason).toContain('ECONNREFUSED');
  });

  it('returns DENIED (10) when submit throws a timeout error', async () => {
    const fetchImpl = makeNetworkErrorFetch('The operation was aborted due to timeout');

    const res = await runPolicyEngine({ ...BASE_INPUT, fetchImpl });

    expect(res.status).toBe('denied');
    expect(res.exitCode).toBe(POLICY_ENGINE_EXIT_CODES.DENIED);
    expect(res.reason).toContain('aborted');
  });

  it('includes the error message in the reason so the CLI can log it', async () => {
    const errorMessage = 'getaddrinfo ENOTFOUND test.supabase.co';
    const fetchImpl = makeNetworkErrorFetch(errorMessage);

    const res = await runPolicyEngine({ ...BASE_INPUT, fetchImpl });

    expect(res.reason).toContain(errorMessage);
  });
});

// ============================================================================
// 5. Fail-closed — errors during polling
// ============================================================================

describe('H-6 — fail-closed: network errors during poll → DENY', () => {
  it('returns DENIED (10) when a poll throws a network error', async () => {
    const fetchImpl = makeSubmitOkPollErrorFetch(new Error('Network timeout during poll'));
    const messages: string[] = [];

    const res = await runPolicyEngine({
      ...BASE_INPUT,
      fetchImpl,
      onStatus: (m) => messages.push(m),
    });

    expect(res.status).toBe('denied');
    expect(res.exitCode).toBe(POLICY_ENGINE_EXIT_CODES.DENIED);
    expect(res.reason).toMatch(/policy engine unavailable during poll/i);
    expect(messages.some((m) => /poll failed/i.test(m))).toBe(true);
  });

  it('attempts to cancel the pending row when a poll error triggers fail-closed', async () => {
    let cancelAttempted = false;
    let callCount = 0;

    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
      callCount++;

      if (body['action'] === 'cancel') {
        cancelAttempted = true;
        return { ok: true, status: 200, async json() { return { approvalId: APPROVAL_ID, status: 'cancelled' }; }, async text() { return ''; } } as unknown as Response;
      }
      if (callCount === 1) {
        // Submit
        return {
          ok: true,
          status: 201,
          async json() { return { approvalId: APPROVAL_ID, approvalToken: APPROVAL_TOKEN, status: 'pending' }; },
          async text() { return ''; },
        } as unknown as Response;
      }
      // Poll throws
      throw new Error('Network failure on poll');
    }) as unknown as typeof fetch;

    await runPolicyEngine({ ...BASE_INPUT, fetchImpl });

    // The engine must try to cancel the pending row so it doesn't block other calls
    expect(cancelAttempted).toBe(true);
  });

  it('passes the approvalToken on the fail-closed cancel call', async () => {
    let cancelBody: Record<string, unknown> | null = null;
    let callCount = 0;

    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
      callCount++;

      if (body['action'] === 'cancel') {
        cancelBody = body;
        return { ok: true, status: 200, async json() { return { approvalId: APPROVAL_ID, status: 'cancelled' }; }, async text() { return ''; } } as unknown as Response;
      }
      if (callCount === 1) {
        return {
          ok: true,
          status: 201,
          async json() { return { approvalId: APPROVAL_ID, approvalToken: APPROVAL_TOKEN, status: 'pending' }; },
          async text() { return ''; },
        } as unknown as Response;
      }
      throw new Error('Network failure on poll');
    }) as unknown as typeof fetch;

    await runPolicyEngine({ ...BASE_INPUT, fetchImpl });

    expect(cancelBody).not.toBeNull();
    expect(cancelBody!['approvalToken']).toBe(APPROVAL_TOKEN);
  });
});
