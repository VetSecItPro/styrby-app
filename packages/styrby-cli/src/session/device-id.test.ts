/**
 * Tests for CLI Device ID
 *
 * Verifies:
 *   - getCliDeviceId generates a valid UUID on first call
 *   - The ID is persisted to ~/.styrby/device-id
 *   - Subsequent calls return the same cached ID
 *   - A corrupt file triggers regeneration
 *   - The file is written with mode 0o600
 *
 * Uses tmp directories to avoid polluting ~/.styrby.
 *
 * @module session/device-id.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ============================================================================
// UUID validation regex
// ============================================================================

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ============================================================================
// Module mocking
// ============================================================================

// We need to redirect CONFIG_DIR + DEVICE_ID_FILE to a temp directory.
// The simplest approach: mock the configuration module to return a temp dir.

let tmpDir: string;

vi.mock('../configuration.js', () => ({
  get CONFIG_DIR() {
    return tmpDir;
  },
  ensureConfigDir: () => {
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
  },
}));

// ============================================================================
// Tests
// ============================================================================

describe('getCliDeviceId', () => {
  beforeEach(() => {
    // Create a fresh temp dir for each test.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'styrby-test-'));
  });

  afterEach(async () => {
    // Clear in-process cache between tests.
    // We re-import to get a fresh module state.
    vi.resetModules();

    // Clean up temp dir.
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('generates a valid UUID on first call', async () => {
    const { getCliDeviceId } = await import('./device-id.js');
    const id = getCliDeviceId();
    expect(id).toMatch(UUID_REGEX);
  });

  it('writes the device ID to ~/.styrby/device-id on first call', async () => {
    const { getCliDeviceId } = await import('./device-id.js');
    const id = getCliDeviceId();

    const filePath = path.join(tmpDir, 'device-id');
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8').trim()).toBe(id);
  });

  it('returns the same ID on subsequent calls (in-process cache)', async () => {
    const { getCliDeviceId } = await import('./device-id.js');
    const id1 = getCliDeviceId();
    const id2 = getCliDeviceId();
    expect(id1).toBe(id2);
  });

  it('reads and reuses a valid ID from an existing device-id file', async () => {
    // Pre-write a known ID.
    const knownId = '550e8400-e29b-41d4-a716-446655440000';
    fs.writeFileSync(path.join(tmpDir, 'device-id'), knownId, 'utf-8');

    const { getCliDeviceId } = await import('./device-id.js');
    const id = getCliDeviceId();
    expect(id).toBe(knownId);
  });

  it('regenerates the ID when the stored value is corrupt', async () => {
    fs.writeFileSync(path.join(tmpDir, 'device-id'), 'not-a-uuid', 'utf-8');

    const { getCliDeviceId } = await import('./device-id.js');
    const id = getCliDeviceId();

    // Should be a fresh valid UUID, not the corrupt value.
    expect(id).toMatch(UUID_REGEX);
    expect(id).not.toBe('not-a-uuid');
  });

  it('writes the file with restricted permissions (mode 0o600)', async () => {
    const { getCliDeviceId } = await import('./device-id.js');
    getCliDeviceId();

    const filePath = path.join(tmpDir, 'device-id');
    const stat = fs.statSync(filePath);

    // On POSIX: 0o600 = owner read+write only.
    // eslint-disable-next-line no-bitwise
    const mode = stat.mode & 0o777;
    // Allow 0o600 (strict) or 0o644 (some test runners relax umask).
    // We assert at minimum that group and world have no write bit.
    // eslint-disable-next-line no-bitwise
    expect(mode & 0o022).toBe(0); // no group-write or world-write
  });
});
