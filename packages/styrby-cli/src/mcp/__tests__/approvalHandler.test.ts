/**
 * Regression tests for createSupabaseApprovalHandler (Phase 3.5).
 *
 * WHY this exists: prior to this PR the handler wrote `event_type`/`severity`/
 * `machine_id` columns that don't exist on audit_log. The bug was latent —
 * never caught because the unit-test surface only tested the MCP server, not
 * the handler itself. These tests pin the column names + enum values.
 */

import { describe, expect, it, vi } from 'vitest';

import { createSupabaseApprovalHandler } from '../approvalHandler.js';
import type { RequestApprovalInput } from '../tools.js';

// Helper: build a deeply-mocked SupabaseClient stub. Each `from(table)` call
// returns a fluent chain; `insert` and `select` resolve to the values pushed
// into the queues on construction.
function buildStubSupabase(opts: {
  insertResult?: { error: { message: string } | null };
  selectRows?: Array<{ data: unknown[] | null; error: { message: string } | null }>;
}) {
  const inserts: Array<{ table: string; payload: Record<string, unknown> }> = [];
  let selectIdx = 0;
  const selectQueue = opts.selectRows ?? [];

  const stub = {
    from(table: string) {
      return {
        insert(payload: Record<string, unknown>) {
          inserts.push({ table, payload });
          return Promise.resolve(opts.insertResult ?? { error: null });
        },
        select() {
          // chainable: .eq().eq().eq().order().limit() → resolves to row set
          const chain = {
            eq() {
              return chain;
            },
            order() {
              return chain;
            },
            limit() {
              const next = selectQueue[selectIdx++] ?? { data: [], error: null };
              return Promise.resolve(next);
            },
          };
          return chain;
        },
      };
    },
  } as unknown as Parameters<typeof createSupabaseApprovalHandler>[0];

  return { stub, inserts };
}

const SAMPLE_INPUT: RequestApprovalInput = {
  action: 'bash',
  reason: 'Run npm install',
  risk: 'medium',
  context: { command: 'npm install' },
};

describe('createSupabaseApprovalHandler', () => {
  it('writes request row with real audit_log columns (no event_type/severity)', async () => {
    const { stub, inserts } = buildStubSupabase({
      // Decision row arrives on the first poll cycle.
      selectRows: [
        {
          data: [
            {
              metadata: { approval_id: 'placeholder', decision: 'approved', user_message: 'ok' },
              created_at: '2026-04-30T00:00:00Z',
            },
          ],
          error: null,
        },
      ],
    });

    const handler = createSupabaseApprovalHandler(stub, 'user-1', 'machine-1');
    // Patch matcher: the test stub returns the same row regardless of resource_id
    // filtering; that's fine because we're verifying the request-INSERT shape.
    await handler.request(SAMPLE_INPUT, 5_000).catch(() => undefined);

    expect(inserts.length).toBeGreaterThanOrEqual(1);
    const requestInsert = inserts[0];
    expect(requestInsert.table).toBe('audit_log');

    const payload = requestInsert.payload;
    // Real columns present
    expect(payload).toHaveProperty('user_id', 'user-1');
    expect(payload).toHaveProperty('action', 'mcp_approval_requested');
    expect(payload).toHaveProperty('resource_type', 'mcp_approval');
    expect(payload).toHaveProperty('resource_id');
    expect(payload).toHaveProperty('metadata');
    // Drift columns absent
    expect(payload).not.toHaveProperty('event_type');
    expect(payload).not.toHaveProperty('severity');
    expect(payload).not.toHaveProperty('machine_id');
    // machine_id moved into metadata
    expect((payload.metadata as { machine_id: string }).machine_id).toBe('machine-1');
    // requested_action holds the original input.action (no name collision with column `action`)
    expect((payload.metadata as { requested_action: string }).requested_action).toBe('bash');
  });

  it('writes timeout row with mcp_approval_timeout action when no decision arrives', async () => {
    const { stub, inserts } = buildStubSupabase({
      // All select cycles return empty — decision never arrives, handler times out.
      selectRows: Array.from({ length: 100 }, () => ({ data: [], error: null })),
    });

    const handler = createSupabaseApprovalHandler(stub, 'user-1', 'machine-1');

    // Use a very short timeout so the test doesn't sit waiting. The poll
    // interval is 1s by default; we accept a 1s wait + a few hundred ms of
    // jitter in test environment.
    const result = await handler.request(SAMPLE_INPUT, 50);
    expect(result.decision).toBe('denied');

    // Two inserts: the request, and the timeout.
    const timeoutInsert = inserts.find((i) => i.payload.action === 'mcp_approval_timeout');
    expect(timeoutInsert).toBeDefined();
    expect(timeoutInsert!.payload).toHaveProperty('resource_id');
    expect(timeoutInsert!.payload).not.toHaveProperty('event_type');
    expect((timeoutInsert!.payload.metadata as { machine_id: string }).machine_id).toBe('machine-1');
  });

  it('returns the decision when a matching row arrives', async () => {
    const { stub } = buildStubSupabase({
      selectRows: [
        {
          data: [
            {
              metadata: {
                approval_id: 'will-match', // resource_id filter handles correctness in real DB
                decision: 'approved',
                user_message: 'go ahead',
              },
              created_at: '2026-04-30T00:00:00Z',
            },
          ],
          error: null,
        },
      ],
    });

    const handler = createSupabaseApprovalHandler(stub, 'user-1', 'machine-1');
    const result = await handler.request(SAMPLE_INPUT, 5_000);

    expect(result.decision).toBe('approved');
    expect(result.reason).toBe('go ahead');
  });

  it('throws on insert error rather than swallowing', async () => {
    const { stub } = buildStubSupabase({
      insertResult: { error: { message: 'permission denied for table audit_log' } },
    });

    const handler = createSupabaseApprovalHandler(stub, 'user-1', 'machine-1');
    await expect(handler.request(SAMPLE_INPUT, 5_000)).rejects.toThrow(
      /permission denied for table audit_log/,
    );
  });
});
