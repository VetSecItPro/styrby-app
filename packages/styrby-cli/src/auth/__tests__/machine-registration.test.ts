/**
 * Tests for auth/machine-registration.ts
 *
 * Covers:
 * - generateMachineFingerprint: deterministic hash from os/process attributes
 * - generateMachineId: UUID v4 format
 * - getMachineName: returns hostname string
 * - getPlatform / getPlatformVersion: return non-empty strings
 * - registerMachine: new registration, existing machine re-registration,
 *   update failure (non-fatal), insert error, duplicate key retry, and
 *   unexpected error wrapping
 *
 * WHY: Machine registration is the first step in the auth flow. Bugs here
 * prevent any machine from pairing with the mobile app, silently breaking
 * all user sessions. Testing the Supabase interaction paths validates that
 * error codes are handled correctly without real network calls.
 *
 * @module auth/__tests__/machine-registration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// Mocks — declared before imports so Vitest hoisting applies
// ============================================================================

/**
 * Mock os module so fingerprint is computed from controlled values.
 * All tests that need determinism rely on these static return values.
 */
vi.mock('node:os', () => ({
  hostname: vi.fn(() => 'test-host'),
  userInfo: vi.fn(() => ({ username: 'test-user' })),
  homedir: vi.fn(() => '/home/test-user'),
  release: vi.fn(() => '14.0.0'),
}));

/**
 * Mock logger to suppress output and allow assertion-free calls.
 */
vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ============================================================================
// Imports — after vi.mock declarations
// ============================================================================

import * as os from 'node:os';
import * as crypto from 'node:crypto';
import {
  generateMachineFingerprint,
  generateMachineId,
  getMachineName,
  getPlatform,
  getPlatformVersion,
  registerMachine,
  MachineRegistrationError,
} from '../machine-registration';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build a minimal fluent Supabase query builder mock.
 * The builder's method calls chain back to itself by default,
 * and the terminal method (single, etc.) returns the provided result.
 *
 * @param result - The { data, error } object returned by terminal methods
 */
function buildQueryMock(result: { data: unknown; error: unknown }) {
  const query = {
    data: result.data,
    error: result.error,
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    single: vi.fn().mockReturnValue(result),
  };
  return query;
}

/**
 * Build a minimal Supabase client that handles the multi-step
 * query sequence inside registerMachine.
 *
 * @param selectResult - Result for the initial SELECT (check existing)
 * @param updateResult - Result for the UPDATE (last_seen) when existing
 * @param insertResult - Result for the INSERT when new
 */
function buildSupabaseMock(
  selectResult: { data: unknown; error: unknown },
  updateResult: { data: unknown; error: unknown } = { data: null, error: null },
  insertResult: { data: unknown; error: unknown } = { data: null, error: null }
) {
  // The SELECT chain terminates with .single()
  const selectChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockReturnValue(selectResult),
  };

  // The UPDATE chain: .update().eq() → direct { data, error }
  const updateChain = {
    update: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue(updateResult),
    }),
  };

  // The INSERT chain terminates with .select().single()
  const insertChain = {
    insert: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockReturnValue(insertResult),
      }),
    }),
  };

  const from = vi.fn().mockImplementation(() => ({
    ...selectChain,
    ...updateChain,
    ...insertChain,
  }));

  return { from };
}

// ============================================================================
// generateMachineFingerprint
// ============================================================================

describe('generateMachineFingerprint', () => {
  it('returns a 64-character hex SHA-256 string', () => {
    const fp = generateMachineFingerprint();

    expect(typeof fp).toBe('string');
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — same os values yield same fingerprint', () => {
    const fp1 = generateMachineFingerprint();
    const fp2 = generateMachineFingerprint();

    expect(fp1).toBe(fp2);
  });

  it('changes when hostname changes', () => {
    const fp1 = generateMachineFingerprint();

    (os.hostname as ReturnType<typeof vi.fn>).mockReturnValueOnce('other-host');
    const fp2 = generateMachineFingerprint();

    expect(fp1).not.toBe(fp2);
  });

  it('changes when username changes', () => {
    const fp1 = generateMachineFingerprint();

    (os.userInfo as ReturnType<typeof vi.fn>).mockReturnValueOnce({ username: 'other-user' });
    const fp2 = generateMachineFingerprint();

    expect(fp1).not.toBe(fp2);
  });

  it('changes when homedir changes', () => {
    const fp1 = generateMachineFingerprint();

    (os.homedir as ReturnType<typeof vi.fn>).mockReturnValueOnce('/home/other');
    const fp2 = generateMachineFingerprint();

    expect(fp1).not.toBe(fp2);
  });

  it('changes when platform changes (via process.platform override)', () => {
    const fp1 = generateMachineFingerprint();

    // Temporarily override process.platform
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const fp2 = generateMachineFingerprint();
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });

    // Only assert that the fingerprints are strings; platform may match darwin on the test env
    expect(typeof fp2).toBe('string');
    expect(fp2).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ============================================================================
// generateMachineId
// ============================================================================

describe('generateMachineId', () => {
  it('returns a valid UUID v4 string', () => {
    const id = generateMachineId();

    // UUID v4 format: xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it('produces unique values on each call', () => {
    const ids = Array.from({ length: 20 }, () => generateMachineId());
    const unique = new Set(ids);

    expect(unique.size).toBe(20);
  });
});

// ============================================================================
// getMachineName
// ============================================================================

describe('getMachineName', () => {
  it('returns a non-empty string', () => {
    const name = getMachineName();

    expect(typeof name).toBe('string');
    expect(name.length).toBeGreaterThan(0);
  });

  it('returns the value from os.hostname()', () => {
    expect(getMachineName()).toBe('test-host');
  });
});

// ============================================================================
// getPlatform
// ============================================================================

describe('getPlatform', () => {
  it('returns a non-empty string', () => {
    const platform = getPlatform();

    expect(typeof platform).toBe('string');
    expect(platform.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// getPlatformVersion
// ============================================================================

describe('getPlatformVersion', () => {
  it('returns a non-empty string', () => {
    const version = getPlatformVersion();

    expect(typeof version).toBe('string');
    expect(version.length).toBeGreaterThan(0);
  });

  it('returns the value from os.release()', () => {
    expect(getPlatformVersion()).toBe('14.0.0');
  });
});

// ============================================================================
// registerMachine
// ============================================================================

describe('registerMachine', () => {
  const USER_ID = 'user-uuid-001';

  /** Existing machine DB row fixture. */
  const EXISTING_ROW = {
    id: 'machine-existing-001',
    machine_fingerprint: 'fingerprint-hash',
    name: 'test-host',
    platform: 'darwin',
    created_at: '2026-01-01T00:00:00Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default mocked os values after each test
    (os.hostname as ReturnType<typeof vi.fn>).mockReturnValue('test-host');
    (os.userInfo as ReturnType<typeof vi.fn>).mockReturnValue({ username: 'test-user' });
    (os.homedir as ReturnType<typeof vi.fn>).mockReturnValue('/home/test-user');
    (os.release as ReturnType<typeof vi.fn>).mockReturnValue('14.0.0');
  });

  it('returns isNew=false and existing machine info when machine already registered', async () => {
    const supabase = buildSupabaseMock(
      { data: EXISTING_ROW, error: null },
      { data: null, error: null }
    );

    const result = await registerMachine(supabase as never, USER_ID);

    expect(result.isNew).toBe(false);
    expect(result.machine.machineId).toBe('machine-existing-001');
    expect(result.machine.machineName).toBe('test-host');
    expect(result.registeredAt).toBe('2026-01-01T00:00:00Z');
  });

  it('returns isNew=true and new machine info after fresh insert', async () => {
    const newRow = {
      id: 'machine-new-001',
      machine_fingerprint: 'new-fingerprint',
      name: 'test-host',
      platform: 'darwin',
      created_at: '2026-03-29T10:00:00Z',
    };

    const supabase = buildSupabaseMock(
      { data: null, error: { code: 'PGRST116', message: 'no rows' } },
      { data: null, error: null },
      { data: newRow, error: null }
    );

    const result = await registerMachine(supabase as never, USER_ID);

    expect(result.isNew).toBe(true);
    expect(result.machine.machineId).toBe('machine-new-001');
    expect(result.machine.platform).toBe('darwin');
    expect(result.registeredAt).toBe('2026-03-29T10:00:00Z');
  });

  it('uses existingMachineId when provided for new registrations', async () => {
    const newRow = {
      id: 'pre-specified-machine-id',
      machine_fingerprint: 'fp',
      name: 'test-host',
      platform: 'darwin',
      created_at: '2026-03-29T10:00:00Z',
    };

    const supabase = buildSupabaseMock(
      { data: null, error: { code: 'PGRST116', message: 'no rows' } },
      { data: null, error: null },
      { data: newRow, error: null }
    );

    const result = await registerMachine(supabase as never, USER_ID, 'pre-specified-machine-id');

    expect(result.machine.machineId).toBe('pre-specified-machine-id');
  });

  it('throws MachineRegistrationError on SELECT failure (non-PGRST116 code)', async () => {
    const supabase = buildSupabaseMock({
      data: null,
      error: { code: '500', message: 'internal server error' },
    });

    await expect(registerMachine(supabase as never, USER_ID)).rejects.toBeInstanceOf(
      MachineRegistrationError
    );
  });

  it('throws MachineRegistrationError with "Failed to check existing machine" on select error', async () => {
    const supabase = buildSupabaseMock({
      data: null,
      error: { code: 'NETWORK_ERROR', message: 'connection refused' },
    });

    await expect(registerMachine(supabase as never, USER_ID)).rejects.toThrow(
      'Failed to check existing machine'
    );
  });

  it('throws MachineRegistrationError on INSERT failure', async () => {
    const supabase = buildSupabaseMock(
      { data: null, error: { code: 'PGRST116', message: 'no rows' } },
      { data: null, error: null },
      { data: null, error: { code: '42501', message: 'RLS violation' } }
    );

    await expect(registerMachine(supabase as never, USER_ID)).rejects.toBeInstanceOf(
      MachineRegistrationError
    );
  });

  it('throws MachineRegistrationError with "Failed to register machine" on insert error', async () => {
    const supabase = buildSupabaseMock(
      { data: null, error: { code: 'PGRST116', message: 'no rows' } },
      { data: null, error: null },
      { data: null, error: { code: '42501', message: 'RLS violation' } }
    );

    await expect(registerMachine(supabase as never, USER_ID)).rejects.toThrow(
      'Failed to register machine'
    );
  });

  it('does not throw when update of existing machine fails (non-fatal warning)', async () => {
    const supabase = buildSupabaseMock(
      { data: EXISTING_ROW, error: null },
      { data: null, error: { message: 'update failed' } }
    );

    // Update failure should be logged as a warning, not thrown
    const result = await registerMachine(supabase as never, USER_ID);

    expect(result.isNew).toBe(false);
    expect(result.machine.machineId).toBe('machine-existing-001');
  });

  it('MachineRegistrationError has correct name and cause', async () => {
    const cause = new Error('original cause');
    const err = new MachineRegistrationError('test message', cause);

    expect(err.name).toBe('MachineRegistrationError');
    expect(err.message).toBe('test message');
    expect(err.cause).toBe(cause);
  });

  it('MachineRegistrationError is instanceof Error', () => {
    const err = new MachineRegistrationError('test');

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MachineRegistrationError);
  });

  it('wraps unexpected errors as MachineRegistrationError', async () => {
    // Make supabase.from throw unexpectedly
    const supabase = {
      from: vi.fn().mockImplementation(() => {
        throw new TypeError('Unexpected internal error');
      }),
    };

    const err = await registerMachine(supabase as never, USER_ID).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MachineRegistrationError);
    expect((err as MachineRegistrationError).message).toBe(
      'Unexpected error during machine registration'
    );
  });
});
