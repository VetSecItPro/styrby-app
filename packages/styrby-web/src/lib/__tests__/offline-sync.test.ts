/**
 * Tests for the web offline-sync service.
 *
 * Guards the latent bugs the bug-hunt found (2026-06-09) + the delivery loop
 * added 2026-06-10:
 *  - machine_id uses the command's REAL machine (was userId → FK violation)
 *  - session_id is carried through
 *  - queue_order = Date.parse(created_at) ms-epoch (BIGINT, migration 098)
 *  - upsert on `id` with ignoreDuplicates (idempotent re-sync)
 *  - chat commands are DELIVERED over the relay on reconnect; non-chat aren't
 *  - delivery is best-effort: relay unavailable → commands still persisted
 *
 * @module lib/__tests__/offline-sync
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// openDeliveryRelay reads localStorage for a stable web device id. This test
// env lacks a functional localStorage, so provide a minimal stub (the relay
// delivery path would otherwise fail-soft to "no delivery").
const mockLocalStorage = (() => {
  const store: Record<string, string> = {};
  return {
    getItem: (k: string): string | null => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  };
})();
Object.defineProperty(globalThis, 'localStorage', { value: mockLocalStorage, writable: true });

const h = vi.hoisted(() => ({
  upsert: vi.fn(async (_row: unknown, _opts: unknown) => ({ error: null as { message: string } | null })),
  getUser: vi.fn(
    async (): Promise<{ data: { user: { id: string } | null }; error: unknown }> => ({
      data: { user: { id: 'user-1' } },
      error: null,
    }),
  ),
  connect: vi.fn(async () => {}),
  sendChat: vi.fn(async (_c: string, _a: string, _s?: string) => {}),
  disconnect: vi.fn(async () => {}),
  relayThrows: false,
  pending: [] as Array<Record<string, unknown>>,
  markSynced: vi.fn(async (_id: string) => {}),
  clearSynced: vi.fn(async () => 0),
  encryptForSession: vi.fn(
    async (
      _payload: string,
      _machineId: string,
    ): Promise<{ content_encrypted: string; encryption_nonce: string } | null> => ({
      content_encrypted: 'CIPHERTEXT',
      encryption_nonce: 'NONCE',
    }),
  ),
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => ({ upsert: h.upsert }),
    auth: { getUser: h.getUser },
  }),
}));
vi.mock('../encryption', () => ({
  encryptForSession: (payload: string, machineId: string) => h.encryptForSession(payload, machineId),
}));
vi.mock('@styrby/shared/relay', () => ({
  createRelayClient: () => {
    if (h.relayThrows) throw new Error('relay unavailable');
    return { connect: h.connect, sendChat: h.sendChat, disconnect: h.disconnect };
  },
}));
vi.mock('../offline-storage', () => ({
  getPendingCommands: async () => h.pending,
  markSynced: (id: string) => h.markSynced(id),
  clearSynced: () => h.clearSynced(),
}));

import { syncPendingCommands } from '../offline-sync';

const CREATED_AT = '2026-06-10T00:00:00.000Z';

function chatCommand(over: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    command_type: 'chat',
    payload: JSON.stringify({ content: 'hi there', agent: 'claude' }),
    machine_id: 'machine-xyz',
    session_id: 'sess-1',
    created_at: CREATED_AT,
    synced: false,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.relayThrows = false;
  h.pending = [];
  h.upsert.mockResolvedValue({ error: null });
  h.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
  h.clearSynced.mockResolvedValue(0);
  h.encryptForSession.mockResolvedValue({ content_encrypted: 'CIPHERTEXT', encryption_nonce: 'NONCE' });
});

describe('syncPendingCommands', () => {
  it('upserts with the REAL machine_id (not userId), session_id, id-dedup, and ms queue_order', async () => {
    h.pending = [chatCommand()];

    const count = await syncPendingCommands();

    expect(count).toBe(1);
    expect(h.upsert).toHaveBeenCalledTimes(1);
    const [row, opts] = h.upsert.mock.calls[0];
    expect(row).toMatchObject({
      id: 'c1',
      user_id: 'user-1',
      machine_id: 'machine-xyz', // the FK fix — NOT 'user-1'
      session_id: 'sess-1',
      queue_order: Date.parse(CREATED_AT), // 1.7e12 — only valid as BIGINT
      status: 'pending',
      // payload is encrypted at rest — NOT plaintext, NOT a 'pending' nonce.
      command_encrypted: 'CIPHERTEXT',
      encryption_nonce: 'NONCE',
    });
    expect(h.encryptForSession).toHaveBeenCalledWith(expect.any(String), 'machine-xyz');
    expect((row as { machine_id: string }).machine_id).not.toBe('user-1');
    expect(opts).toEqual({ onConflict: 'id', ignoreDuplicates: true });
    expect(h.markSynced).toHaveBeenCalledWith('c1');
    expect(h.clearSynced).toHaveBeenCalled();
  });

  it('defers a command (no upsert, not marked synced) when the CLI key is unavailable', async () => {
    h.encryptForSession.mockResolvedValue(null); // can't encrypt → never write plaintext
    h.pending = [chatCommand()];

    const count = await syncPendingCommands();

    expect(count).toBe(0);
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.markSynced).not.toHaveBeenCalled();
  });

  it('delivers chat commands over the relay (connect → sendChat → disconnect)', async () => {
    h.pending = [chatCommand()];

    await syncPendingCommands();

    expect(h.connect).toHaveBeenCalled();
    expect(h.sendChat).toHaveBeenCalledWith('hi there', 'claude', 'sess-1');
    expect(h.disconnect).toHaveBeenCalled();
  });

  it('does NOT deliver non-chat commands over the relay (but still persists them)', async () => {
    h.pending = [chatCommand({ id: 'c2', command_type: 'cancel', payload: JSON.stringify({ session_id: 'sess-1' }) })];

    const count = await syncPendingCommands();

    expect(count).toBe(1);
    expect(h.upsert).toHaveBeenCalledTimes(1);
    expect(h.sendChat).not.toHaveBeenCalled();
  });

  it('still persists commands when the delivery relay is unavailable (best-effort)', async () => {
    h.relayThrows = true;
    h.pending = [chatCommand()];

    const count = await syncPendingCommands();

    expect(count).toBe(1);
    expect(h.upsert).toHaveBeenCalledTimes(1);
    expect(h.sendChat).not.toHaveBeenCalled();
    expect(h.markSynced).toHaveBeenCalledWith('c1');
  });

  it('returns 0 and does nothing when there are no pending commands', async () => {
    h.pending = [];
    const count = await syncPendingCommands();
    expect(count).toBe(0);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('defers (returns 0) when there is no authenticated user', async () => {
    h.pending = [chatCommand()];
    h.getUser.mockResolvedValue({ data: { user: null }, error: null });

    const count = await syncPendingCommands();

    expect(count).toBe(0);
    expect(h.upsert).not.toHaveBeenCalled();
  });
});
