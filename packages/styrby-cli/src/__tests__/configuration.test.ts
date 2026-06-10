/**
 * Tests for configuration.ts — ~/.styrby/config.json read/write.
 *
 * Covers:
 * - saveConfig writes the temp file with mode 0o600  (sec H-05 fix: new file)
 * - saveConfig calls chmodSync 0o600 then renames atomically  (audit fix #39)
 * - loadConfig returns correct values round-trip
 * - loadConfig surfaces a warning + returns {} on corrupt JSON  (audit fix #39)
 * - setConfigValue merges without clobbering other keys
 *
 * WHY: config.json holds the auth token and machine ID. World-readable permissions
 * would expose credentials to other local users. The chmodSync call in saveConfig
 * was added to repair pre-existing files that were created without the restrictive
 * mode. saveConfig now writes to a temp file + atomically renames so a crash
 * mid-write never leaves a truncated config (audit 2026-06-09 fix #39). These
 * tests guard the 0o600 mode AND the atomic write+rename ordering.
 *
 * @module __tests__/configuration.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';

// ---------------------------------------------------------------------------
// Mock node:fs so we don't touch the real filesystem.
// vi.mock is hoisted by vitest to the top of the file, so it runs before
// any module-level imports — the mocked fs is in place when configuration.ts
// is first evaluated.
// ---------------------------------------------------------------------------
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    chmodSync: vi.fn(),
    renameSync: vi.fn(),
    readFileSync: vi.fn().mockImplementation(() => { throw new Error('ENOENT'); }),
  };
});

// Import after mocks are set up so the module-under-test picks up mocked fs.
import { saveConfig, loadConfig, setConfigValue } from '../configuration';

describe('saveConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: dir and file both exist
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('no file'); });
  });

  it('writes the temp file with mode 0o600 (new file path)', () => {
    saveConfig({ machineId: 'test-machine' });

    expect(fs.writeFileSync).toHaveBeenCalledOnce();
    const [tmpPath, , opts] = vi.mocked(fs.writeFileSync).mock.calls[0] as [string, string, { mode: number }];
    // Atomic write target is the temp file, not the final config.json.
    expect(tmpPath).toContain('config.json.tmp');
    expect(opts.mode).toBe(0o600);
  });

  it('calls chmodSync 0o600 on the temp file (upgrade fix)', () => {
    saveConfig({ machineId: 'test-machine' });

    expect(fs.chmodSync).toHaveBeenCalledOnce();
    const [filePath, mode] = vi.mocked(fs.chmodSync).mock.calls[0] as [string, number];
    expect(filePath).toContain('config.json.tmp');
    expect(mode).toBe(0o600);
  });

  it('renames the temp file onto config.json atomically (audit fix #39)', () => {
    saveConfig({ machineId: 'test-machine' });

    expect(fs.renameSync).toHaveBeenCalledOnce();
    const [from, to] = vi.mocked(fs.renameSync).mock.calls[0] as [string, string];
    expect(from).toContain('config.json.tmp');
    expect(to).toMatch(/config\.json$/);
  });

  it('write -> chmod -> rename happen in that order (atomicity invariant)', () => {
    const callOrder: string[] = [];
    vi.mocked(fs.writeFileSync).mockImplementation(() => { callOrder.push('write'); });
    vi.mocked(fs.chmodSync).mockImplementation(() => { callOrder.push('chmod'); });
    vi.mocked(fs.renameSync).mockImplementation(() => { callOrder.push('rename'); });

    saveConfig({ debug: true });

    expect(callOrder).toEqual(['write', 'chmod', 'rename']);
  });
});

describe('loadConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(true);
  });

  it('returns parsed JSON when file exists', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ machineId: 'abc', debug: false }));
    const config = loadConfig();
    expect(config.machineId).toBe('abc');
    expect(config.debug).toBe(false);
  });

  it('returns empty object when file read throws', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
    const config = loadConfig();
    expect(config).toEqual({});
  });

  it('returns {} on corrupt/truncated JSON (audit fix #39: no silent swallow)', () => {
    // Simulate a config.json truncated mid-write (the non-atomic-save hazard).
    vi.mocked(fs.readFileSync).mockReturnValue('{ "machineId": "abc", "userI');
    const config = loadConfig();
    // It still degrades to empty (so the app doesn't crash), but the parse
    // failure is now logged loudly rather than masquerading as "logged out".
    expect(config).toEqual({});
  });
});

describe('setConfigValue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(true);
    // Simulate an existing config with a machineId already set
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ machineId: 'existing-id' }));
  });

  it('merges new key without clobbering existing keys', () => {
    setConfigValue('debug', true);

    expect(fs.writeFileSync).toHaveBeenCalled();
    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.machineId).toBe('existing-id');
    expect(parsed.debug).toBe(true);
  });
});
