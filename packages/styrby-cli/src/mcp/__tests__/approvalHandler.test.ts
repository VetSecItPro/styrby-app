/**
 * Regression tests for createSupabaseApprovalHandler.
 *
 * H41 Phase 4-step4: rewritten to mock StyrbyApiClient.writeAuditEvent +
 * searchAuditLog instead of a Supabase client. Drops the column-shape
 * regression tests (those guarantees moved to the server-side /api/v1/audit
 * route's tests + Zod .strict() schema). Tests now focus on:
 *  - The handler calls apiClient.writeAuditEvent for the request row
 *  - The handler polls via apiClient.searchAuditLog
 *  - Decision rows return the correct {decision, reason} shape
 *  - Timeout path writes a `mcp_approval_timeout` audit row
 *  - Insert errors propagate (timeout-row write swallows by design)
 */

import { describe, expect, it, vi } from 'vitest';

import { createSupabaseApprovalHandler } from '../approvalHandler.js';
import type { RequestApprovalInput } from '../tools.js';
import type { StyrbyApiClient } from '@/api/styrbyApiClient';

interface RecordedAudit {
  action: string;
  resource_type?: string;
  resource_id?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Build a deeply-mocked StyrbyApiClient stub. Records each writeAuditEvent
 * call; serves searchAuditLog responses from the supplied queue.
 *
 * WHY a focused stub (not vi.fn() on the whole class): the handler only
 * uses two methods. A targeted stub keeps the test signal-to-noise high
 * and surfaces accidental dependencies on other client methods as
 * compile errors via the explicit cast.
 */
function buildStubApiClient(opts: {
  writeAuditError?: Error;
  searchResults?: Array<{
    events: Array<{
      id?: string;
      action: string;
      resource_type?: string | null;
      resource_id?: string | null;
      metadata: unknown;
      created_at: string;
    }>;
    count: number;
  }>;
  searchError?: Error;
}) {
  const audits: RecordedAudit[] = [];
  let searchIdx = 0;
  const searchQueue = opts.searchResults ?? [];

  const stub = {
    writeAuditEvent: async (event: RecordedAudit) => {
      audits.push(event);
      if (opts.writeAuditError) throw opts.writeAuditError;
      return { id: 'audit-' + audits.length, created_at: new Date().toISOString() };
    },
    searchAuditLog: async () => {
      if (opts.searchError) throw opts.searchError;
      return searchQueue[searchIdx++] ?? { events: [], count: 0 };
    },
  } as unknown as StyrbyApiClient;

  return { stub, audits };
}

const SAMPLE_INPUT: RequestApprovalInput = {
  action: 'bash',
  reason: 'Run npm install',
  risk: 'medium',
  context: { command: 'npm install' },
};

describe('createSupabaseApprovalHandler', () => {
  it('writes request row via apiClient.writeAuditEvent with mcp_approval_requested action', async () => {
    const { stub, audits } = buildStubApiClient({
      // Decision row arrives on the first poll cycle.
      searchResults: [
        {
          events: [
            {
              action: 'mcp_approval_decided',
              resource_id: 'placeholder',
              metadata: { approval_id: 'placeholder', decision: 'approved', user_message: 'ok' },
              created_at: '2026-04-30T00:00:00Z',
            },
          ],
          count: 1,
        },
      ],
    });

    const handler = createSupabaseApprovalHandler(stub, 'user-1', 'machine-1');
    await handler.request(SAMPLE_INPUT, 5_000).catch(() => undefined);

    expect(audits.length).toBeGreaterThanOrEqual(1);
    const request = audits[0];
    expect(request.action).toBe('mcp_approval_requested');
    expect(request.resource_type).toBe('mcp_approval');
    expect(request.resource_id).toBeTruthy();
    // machine_id is in metadata (not as a column — the audit_log table has no such column)
    expect((request.metadata as { machine_id: string }).machine_id).toBe('machine-1');
    // requested_action holds the original input.action (no name collision with column `action`)
    expect((request.metadata as { requested_action: string }).requested_action).toBe('bash');
  });

  it('writes timeout row with mcp_approval_timeout action when no decision arrives', async () => {
    const { stub, audits } = buildStubApiClient({
      // All search cycles return empty — decision never arrives, handler times out.
      searchResults: Array.from({ length: 100 }, () => ({ events: [], count: 0 })),
    });

    const handler = createSupabaseApprovalHandler(stub, 'user-1', 'machine-1');

    // Use a very short timeout so the test doesn't sit waiting. The poll
    // interval is 1s by default; we accept a 1s wait + a few hundred ms of
    // jitter in test environment.
    const result = await handler.request(SAMPLE_INPUT, 50);
    expect(result.decision).toBe('denied');

    // Two writes: the request, and the timeout.
    const timeoutAudit = audits.find((a) => a.action === 'mcp_approval_timeout');
    expect(timeoutAudit).toBeDefined();
    expect(timeoutAudit!.resource_id).toBeTruthy();
    expect((timeoutAudit!.metadata as { machine_id: string }).machine_id).toBe('machine-1');
  });

  it('returns the decision when a matching row arrives', async () => {
    const { stub } = buildStubApiClient({
      searchResults: [
        {
          events: [
            {
              action: 'mcp_approval_decided',
              metadata: {
                approval_id: 'will-match', // resource_id filter handles correctness in real prod
                decision: 'approved',
                user_message: 'go ahead',
              },
              created_at: '2026-04-30T00:00:00Z',
            },
          ],
          count: 1,
        },
      ],
    });

    const handler = createSupabaseApprovalHandler(stub, 'user-1', 'machine-1');
    const result = await handler.request(SAMPLE_INPUT, 5_000);

    expect(result.decision).toBe('approved');
    expect(result.reason).toBe('go ahead');
  });

  it('throws on writeAuditEvent error rather than swallowing (request path)', async () => {
    const { stub } = buildStubApiClient({
      writeAuditError: new Error('permission denied for table audit_log'),
    });

    const handler = createSupabaseApprovalHandler(stub, 'user-1', 'machine-1');
    await expect(handler.request(SAMPLE_INPUT, 5_000)).rejects.toThrow(
      /permission denied for table audit_log/,
    );
  });

  it('swallows timeout-record write errors (best-effort, primary contract is denied return)', async () => {
    // Force search to always return empty → handler times out and tries to
    // write the timeout audit row. We make THAT write throw too; the handler
    // must still return denied (the primary contract).
    const { stub } = buildStubApiClient({
      searchResults: Array.from({ length: 100 }, () => ({ events: [], count: 0 })),
    });
    // Patch writeAuditEvent: succeed on first call (request row), fail on subsequent.
    const original = stub.writeAuditEvent;
    let count = 0;
    (stub as unknown as { writeAuditEvent: typeof stub.writeAuditEvent }).writeAuditEvent = async (event) => {
      count++;
      if (count >= 2) throw new Error('storage unavailable');
      return original(event);
    };

    // Silence the expected console.error from the catch block.
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const handler = createSupabaseApprovalHandler(stub, 'user-1', 'machine-1');
    const result = await handler.request(SAMPLE_INPUT, 50);
    expect(result.decision).toBe('denied');
    expect(result.reason).toMatch(/timed out/i);
    consoleErrSpy.mockRestore();
  });
});
