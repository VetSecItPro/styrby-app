/**
 * Tests for relay-message zod validation + length caps (CLI-008) and the
 * permission-response nonce verification (CLI-009). Audit 2026-05-04.
 *
 * Targets the schema directly + the StyrbyApi.verifyAndConsumePermissionNonce
 * helper. We don't exercise the full handleRelayMessage pipeline here —
 * that requires bootstrapping a SupabaseClient + AgentBackend mock; the
 * dispatch logic on top of safeParse is one switch statement and is
 * covered by integration tests elsewhere. The security primitives are what
 * we lock in here.
 *
 * @module api/__tests__/relay-message-validation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RelayMessageSchema } from 'styrby-shared';
import { StyrbyApi } from '../api';

const baseFields = {
  id: 'msg_abc',
  timestamp: new Date().toISOString(),
  sender_device_id: 'device-1',
  sender_type: 'mobile' as const,
};

// ----------------------------------------------------------------------
// CLI-008: schema validation
// ----------------------------------------------------------------------
describe('RelayMessageSchema (CLI-008)', () => {
  it('accepts a well-formed chat message under all length caps', () => {
    const ok = RelayMessageSchema.safeParse({
      ...baseFields,
      type: 'chat',
      payload: { content: 'hello world', agent: 'claude', session_id: 's1' },
    });
    expect(ok.success).toBe(true);
  });

  it('rejects chat content above MAX_CONTENT_LEN (100KB)', () => {
    const huge = 'x'.repeat(100 * 1024 + 1);
    const result = RelayMessageSchema.safeParse({
      ...baseFields,
      type: 'chat',
      payload: { content: huge, agent: 'claude' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.path.join('.') === 'payload.content')).toBe(true);
    }
  });

  it('rejects request_id longer than MAX_ID_LEN (128) on permission_response', () => {
    const result = RelayMessageSchema.safeParse({
      ...baseFields,
      type: 'permission_response',
      payload: {
        request_id: 'r'.repeat(129),
        approved: true,
        request_nonce: 'n',
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown command action via discriminated union', () => {
    const result = RelayMessageSchema.safeParse({
      ...baseFields,
      type: 'command',
      payload: { action: 'reboot_machine' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a known command action ("ping")', () => {
    const result = RelayMessageSchema.safeParse({
      ...baseFields,
      type: 'command',
      payload: { action: 'ping' },
    });
    expect(result.success).toBe(true);
  });
});

// ----------------------------------------------------------------------
// CLI-009: nonce verification + Map cap
// ----------------------------------------------------------------------
describe('StyrbyApi.verifyAndConsumePermissionNonce (CLI-009)', () => {
  let api: StyrbyApi;

  beforeEach(() => {
    api = new StyrbyApi();
  });

  it('returns false for an unknown request_id', () => {
    expect(api.verifyAndConsumePermissionNonce('unknown-req', 'whatever')).toBe(false);
  });

  it('accepts a matching nonce on the first call and rejects replays', () => {
    // Use the private trackPermissionNonce via a thin (any) cast so we don't
    // need to bootstrap a full relay round-trip in this unit test.
    const nonce = 'matching-nonce-value';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (api as any).trackPermissionNonce('req-1', nonce);

    expect(api.verifyAndConsumePermissionNonce('req-1', nonce)).toBe(true);
    // Single-use: a second attempt is rejected (nonce was consumed).
    expect(api.verifyAndConsumePermissionNonce('req-1', nonce)).toBe(false);
  });

  it('rejects a wrong nonce and does NOT consume the entry', () => {
    const nonce = 'real-nonce';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (api as any).trackPermissionNonce('req-2', nonce);

    expect(api.verifyAndConsumePermissionNonce('req-2', 'wrong-nonce')).toBe(false);
    // Real nonce still works because the wrong attempt did not consume it.
    expect(api.verifyAndConsumePermissionNonce('req-2', nonce)).toBe(true);
  });

  it('caps the in-flight nonce map at PENDING_NONCES_MAX (oldest evicted)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const max: number = (StyrbyApi as any).PENDING_NONCES_MAX;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const track = (api as any).trackPermissionNonce.bind(api);

    track('first', 'first-nonce');
    for (let i = 0; i < max; i++) {
      track(`req-${i}`, `nonce-${i}`);
    }
    // 'first' should have been evicted by FIFO once we exceeded the cap.
    expect(api.verifyAndConsumePermissionNonce('first', 'first-nonce')).toBe(false);
    // The most recent entry should still be there.
    expect(api.verifyAndConsumePermissionNonce(`req-${max - 1}`, `nonce-${max - 1}`)).toBe(true);
  });
});
