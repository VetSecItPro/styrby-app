/**
 * Lamport Clock Test Suite
 *
 * Tests:
 * - LamportClock.tick():
 *     - starts at 0, first tick returns 1
 *     - monotonically increases on every call
 *     - persists to SQLite (value survives simulated restart)
 *     - NEVER goes backward across calls
 * - LamportClock.receive():
 *     - advances local clock to max(local, remote) + 1
 *     - handles remote value < local (no regression)
 *     - handles remote value == local (advances by 1)
 *     - handles remote value >> local (jumps ahead)
 * - LamportClock.peek():
 *     - returns current value without advancing
 * - compareLamportOrder():
 *     - sorts by created_at first
 *     - when created_at equal, sorts by lamport_clock ascending
 *     - when both equal, sorts by id (deterministic)
 *     - handles simultaneous sends (phone + terminal same second)
 *     - out-of-order arrival produces correct final order
 *
 * WHY simulate simultaneous sends: This is the core conflict scenario Phase
 * 1.6.3b is designed to resolve. The tests explicitly verify the spec:
 * "when phone and terminal both send a message at the same wall-clock second,
 * replay order must be deterministic."
 */

// ============================================================================
// SQLite Mock
// ============================================================================

/** In-memory store simulating the lamport_clock_state table */
let clockStore: Record<number, number> = {};
let tableExists = false;

const mockRunAsync = jest.fn(async (sql: string, params: unknown[] = []) => {
  if (sql.includes('CREATE TABLE')) {
    tableExists = true;
    return { changes: 0 };
  }
  if (sql.includes('INSERT OR IGNORE')) {
    if (!(1 in clockStore)) clockStore[1] = 0;
    return { changes: 0 };
  }
  if (sql.includes('UPDATE') && sql.includes('lamport_clock_state')) {
    const value = params[0] as number;
    const id = params[1] as number;
    clockStore[id] = value;
    return { changes: 1 };
  }
  return { changes: 0 };
});

const mockGetFirstAsync = jest.fn(async (_sql: string, params: unknown[] = []) => {
  const id = params[0] as number;
  const value = clockStore[id] ?? 0;
  return { value };
});

const mockExecAsync = jest.fn(async (sql: string) => {
  // Handle combined CREATE + INSERT in a single execAsync call
  if (sql.includes('CREATE TABLE')) {
    tableExists = true;
    if (!(1 in clockStore)) clockStore[1] = 0;
  }
});

function buildMockDb(): import('expo-sqlite').SQLiteDatabase {
  return {
    runAsync: mockRunAsync,
    getFirstAsync: mockGetFirstAsync,
    execAsync: mockExecAsync,
  } as unknown as import('expo-sqlite').SQLiteDatabase;
}

// ============================================================================
// Imports (after mocks)
// ============================================================================

import { LamportClock, compareLamportOrder } from '../lamport-clock';

// ============================================================================
// Test Helpers
// ============================================================================

/** Create a fresh clock instance for each test to avoid shared state */
function freshClock(): LamportClock {
  return new LamportClock();
}

// ============================================================================
// LamportClock.tick()
// ============================================================================

describe('LamportClock.tick()', () => {
  beforeEach(() => {
    clockStore = {};
    tableExists = false;
    jest.clearAllMocks();
  });

  it('starts at 0 and first tick returns 1', async () => {
    const clock = freshClock();
    const db = buildMockDb();
    const value = await clock.tick(db);
    expect(value).toBe(1);
  });

  it('returns monotonically increasing values on successive ticks', async () => {
    const clock = freshClock();
    const db = buildMockDb();
    const values: number[] = [];
    for (let i = 0; i < 10; i++) {
      values.push(await clock.tick(db));
    }
    // Each value should be greater than the previous
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1]);
    }
  });

  it('persists value to SQLite on each tick', async () => {
    const clock = freshClock();
    const db = buildMockDb();
    await clock.tick(db);
    await clock.tick(db);
    await clock.tick(db);

    // The clock store should have value 3
    expect(clockStore[1]).toBe(3);
  });

  it('resumes from persisted value after "restart" (new clock instance, same DB)', async () => {
    const clock1 = freshClock();
    const db = buildMockDb();

    // Tick 5 times with first instance
    for (let i = 0; i < 5; i++) await clock1.tick(db);
    expect(clockStore[1]).toBe(5);

    // Simulate app restart: new clock instance, same persisted DB
    const clock2 = freshClock();
    const value = await clock2.tick(db);

    // Should resume from 5, not restart from 0
    expect(value).toBe(6);
  });

  it('NEVER goes backward across ticks', async () => {
    const clock = freshClock();
    const db = buildMockDb();
    let prev = 0;
    for (let i = 0; i < 100; i++) {
      const val = await clock.tick(db);
      expect(val).toBeGreaterThan(prev);
      prev = val;
    }
  });

  it('persists the ticked value before returning (crash-safe)', async () => {
    // The persisted value must match what tick() returns — if the app crashes
    // immediately after tick(), on boot the clock resumes from the stored value
    const clock = freshClock();
    const db = buildMockDb();
    const tickedValue = await clock.tick(db);
    expect(clockStore[1]).toBe(tickedValue);
  });
});

// ============================================================================
// LamportClock.receive()
// ============================================================================

describe('LamportClock.receive()', () => {
  beforeEach(() => {
    clockStore = {};
    tableExists = false;
    jest.clearAllMocks();
  });

  it('advances to max(local, remote) + 1 when remote > local', async () => {
    const clock = freshClock();
    const db = buildMockDb();
    await clock.tick(db); // local = 1
    const updated = await clock.receive(db, 10); // remote = 10
    expect(updated).toBe(11); // max(1, 10) + 1 = 11
  });

  it('advances by 1 when remote <= local (does not go backward)', async () => {
    const clock = freshClock();
    const db = buildMockDb();
    // Tick to get local = 5
    for (let i = 0; i < 5; i++) await clock.tick(db);
    const updated = await clock.receive(db, 3); // remote < local
    expect(updated).toBe(6); // max(5, 3) + 1 = 6
  });

  it('advances by 1 when remote == local', async () => {
    const clock = freshClock();
    const db = buildMockDb();
    await clock.tick(db); // local = 1
    const updated = await clock.receive(db, 1); // remote == local
    expect(updated).toBe(2); // max(1, 1) + 1 = 2
  });

  it('jumps ahead to accommodate a far-future remote value', async () => {
    const clock = freshClock();
    const db = buildMockDb();
    await clock.tick(db); // local = 1
    const updated = await clock.receive(db, 1000);
    expect(updated).toBe(1001); // max(1, 1000) + 1 = 1001
  });

  it('persists updated value to SQLite', async () => {
    const clock = freshClock();
    const db = buildMockDb();
    await clock.tick(db); // local = 1
    await clock.receive(db, 50);
    expect(clockStore[1]).toBe(51);
  });

  it('local clock does not go backward after receive with small remote', async () => {
    const clock = freshClock();
    const db = buildMockDb();
    // Advance local clock to 20
    for (let i = 0; i < 20; i++) await clock.tick(db);
    await clock.receive(db, 5); // remote is far behind
    // Next tick should be 22 (20+1 from receive, then +1 from tick)
    const nextTick = await clock.tick(db);
    expect(nextTick).toBe(22);
  });
});

// ============================================================================
// LamportClock.peek()
// ============================================================================

describe('LamportClock.peek()', () => {
  beforeEach(() => {
    clockStore = {};
    tableExists = false;
    jest.clearAllMocks();
  });

  it('returns current value without advancing the clock', async () => {
    const clock = freshClock();
    const db = buildMockDb();
    await clock.tick(db); // local = 1
    await clock.tick(db); // local = 2
    const peeked = await clock.peek(db);
    expect(peeked).toBe(2);

    // Peek does not advance
    const afterPeek = await clock.tick(db);
    expect(afterPeek).toBe(3); // not 4
  });
});

// ============================================================================
// compareLamportOrder()
// ============================================================================

describe('compareLamportOrder()', () => {
  it('sorts by created_at first (different timestamps)', () => {
    const messages = [
      { createdAt: '2026-04-22T10:00:01.000Z', lamportClock: 5, id: 'aaa' },
      { createdAt: '2026-04-22T10:00:00.000Z', lamportClock: 10, id: 'bbb' },
    ];
    const sorted = [...messages].sort(compareLamportOrder);
    // Earlier timestamp comes first regardless of higher Lamport clock
    expect(sorted[0].id).toBe('bbb');
    expect(sorted[1].id).toBe('aaa');
  });

  it('sorts by lamport_clock when created_at is equal (same millisecond)', () => {
    const ts = '2026-04-22T10:00:00.000Z';
    const messages = [
      { createdAt: ts, lamportClock: 7, id: 'phone-msg' },
      { createdAt: ts, lamportClock: 3, id: 'terminal-msg' },
    ];
    const sorted = [...messages].sort(compareLamportOrder);
    // Lower Lamport clock = happened-before
    expect(sorted[0].id).toBe('terminal-msg'); // clock=3
    expect(sorted[1].id).toBe('phone-msg');    // clock=7
  });

  it('sorts by id when created_at AND lamport_clock are equal (deterministic)', () => {
    const ts = '2026-04-22T10:00:00.000Z';
    const messages = [
      { createdAt: ts, lamportClock: 5, id: 'zzz-id' },
      { createdAt: ts, lamportClock: 5, id: 'aaa-id' },
    ];
    const sorted = [...messages].sort(compareLamportOrder);
    // Lexicographic UUID comparison
    expect(sorted[0].id).toBe('aaa-id');
    expect(sorted[1].id).toBe('zzz-id');
  });

  it('simultaneous send scenario: phone and terminal at same second are ordered deterministically', () => {
    // The core concurrent-send scenario from the Phase 1.6.3b spec.
    // Phone sent first (lower Lamport clock), terminal replied at same wall second.
    const ts = '2026-04-22T12:00:00.000Z';
    const phoneMsg   = { createdAt: ts, lamportClock: 1,  id: 'phone-id-00000001' };
    const terminalMsg = { createdAt: ts, lamportClock: 2, id: 'term-id-00000002' };

    const order1 = [terminalMsg, phoneMsg].sort(compareLamportOrder);
    const order2 = [phoneMsg, terminalMsg].sort(compareLamportOrder);

    // Both initial orderings should produce the same result
    expect(order1[0].id).toBe(phoneMsg.id);    // clock=1 comes first
    expect(order2[0].id).toBe(phoneMsg.id);
  });

  it('out-of-order arrival produces correct final order', () => {
    // Messages arrive in order: B, C, A (out of order)
    // Correct replay order should be A (clock=1), B (clock=2), C (clock=3)
    const ts = '2026-04-22T12:00:00.000Z';
    const msgA = { createdAt: ts, lamportClock: 1, id: 'msg-a' };
    const msgB = { createdAt: ts, lamportClock: 2, id: 'msg-b' };
    const msgC = { createdAt: ts, lamportClock: 3, id: 'msg-c' };

    // Simulate arrival in wrong order
    const arrived = [msgB, msgC, msgA];
    const sorted = arrived.sort(compareLamportOrder);

    expect(sorted.map((m) => m.id)).toEqual(['msg-a', 'msg-b', 'msg-c']);
  });

  it('returns 0 for identical messages (stable sort guard)', () => {
    const msg = { createdAt: '2026-04-22T10:00:00.000Z', lamportClock: 5, id: 'same-id' };
    expect(compareLamportOrder(msg, msg)).toBe(0);
  });

  it('is stable across large message sets with mixed timestamps', () => {
    // Generate 100 messages with semi-random but deterministic ordering keys
    const base = new Date('2026-04-22T10:00:00.000Z').getTime();
    const messages = Array.from({ length: 100 }, (_, i) => ({
      createdAt: new Date(base + Math.floor(i / 10) * 1000).toISOString(), // 10 per second
      lamportClock: i,
      id: `msg-${String(i).padStart(3, '0')}`,
    }));

    // Shuffle
    const shuffled = [...messages].sort(() => Math.random() - 0.5);
    const sorted = shuffled.sort(compareLamportOrder);

    // All 100 messages should be in the original order (ascending by clock within each second)
    expect(sorted.map((m) => m.id)).toEqual(messages.map((m) => m.id));
  });
});
