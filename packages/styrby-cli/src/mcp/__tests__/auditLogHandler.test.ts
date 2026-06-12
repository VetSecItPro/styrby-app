/**
 * Tests for createApiAuditLogHandler (mcp/auditLogHandler.ts).
 *
 * Verifies the handler maps the log_to_audit tool input onto a writeAuditEvent
 * call with the fixed `mcp_agent_log` action, folds note+level+context into
 * metadata, and surfaces API errors.
 *
 * @module mcp/__tests__/auditLogHandler
 */

import { describe, it, expect, vi } from 'vitest';
import { createApiAuditLogHandler } from '../auditLogHandler';
import type { StyrbyApiClient } from '@/api/styrbyApiClient';

/** Minimal apiClient stub exposing only writeAuditEvent. */
function clientStub(impl: StyrbyApiClient['writeAuditEvent']): StyrbyApiClient {
  return { writeAuditEvent: impl } as unknown as StyrbyApiClient;
}

describe('createApiAuditLogHandler', () => {
  it('writes the mcp_agent_log action with note+level+context in metadata', async () => {
    const writeAuditEvent = vi.fn(async () => ({ id: 'audit-1', created_at: '2026-06-12T00:00:00Z' }));
    const handler = createApiAuditLogHandler(clientStub(writeAuditEvent as never));

    const out = await handler.log({
      message: 'ran migration 014',
      level: 'warning',
      resourceType: 'migration',
      resourceId: '014',
      context: { files: 3 },
    });

    expect(writeAuditEvent).toHaveBeenCalledWith({
      action: 'mcp_agent_log',
      resource_type: 'migration',
      resource_id: '014',
      metadata: { message: 'ran migration 014', level: 'warning', files: 3 },
    });
    expect(out).toEqual({ id: 'audit-1', recordedAt: '2026-06-12T00:00:00Z' });
  });

  it('defaults level to info when omitted', async () => {
    const writeAuditEvent = vi.fn(async () => ({ id: 'a', created_at: 't' }));
    const handler = createApiAuditLogHandler(clientStub(writeAuditEvent as never));

    await handler.log({ message: 'did a thing' });

    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { message: 'did a thing', level: 'info' } }),
    );
  });

  it('wraps API errors with a clear message', async () => {
    const handler = createApiAuditLogHandler(
      clientStub((async () => {
        throw new Error('429 rate limited');
      }) as never),
    );

    await expect(handler.log({ message: 'x' })).rejects.toThrow(/Failed to record audit event: 429 rate limited/);
  });
});
