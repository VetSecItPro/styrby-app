/**
 * Tests for daemon/configFile — ~/.styrby/config.json loader & writer.
 *
 * Covers:
 * - loadDaemonConfig: file present + valid → returns config
 * - loadDaemonConfig: file absent → returns null (no throw)
 * - loadDaemonConfig: malformed JSON → returns null + warns
 * - loadDaemonConfig: missing required fields → returns null + warns
 * - writeDaemonConfig: creates dir, writes file, merges existing fields
 * - writeDaemonConfig: mode 0o600 is requested on the write call
 *
 * WHY: The config file is the last-resort fallback for SUPABASE_URL and
 * SUPABASE_ANON_KEY when the daemon boots via LaunchAgent without a shell session.
 * Correctness here directly prevents the "daemon boots but can't connect" regression.
 *
 * @module daemon/__tests__/configFile.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// Mocks — must appear before any imports that use the mocked modules
// ============================================================================

vi.mock('node:fs', () => ({
  default: {},
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/home/testuser'),
}));

import * as fs from 'node:fs';
import { loadDaemonConfig, writeDaemonConfig, CONFIG_FILE_PATH } from '../configFile';

// ============================================================================
// Helpers
// ============================================================================

/** Minimal valid config object for test comparisons. */
const VALID_CONFIG = {
  supabaseUrl: 'https://abc.supabase.co',
  supabaseAnonKey: 'eyJtest',
  machineId: 'machine-uuid-123',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T01:00:00.000Z',
};

// ============================================================================
// CONFIG_FILE_PATH
// ============================================================================

describe('CONFIG_FILE_PATH', () => {
  it('is under the .styrby directory in the home folder', () => {
    expect(CONFIG_FILE_PATH).toContain('.styrby');
    expect(CONFIG_FILE_PATH).toContain('config.json');
  });
});

// ============================================================================
// loadDaemonConfig — file present and valid
// ============================================================================

describe('loadDaemonConfig — file present, valid JSON', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(VALID_CONFIG));
  });

  it('returns the parsed config object', () => {
    const result = loadDaemonConfig();
    expect(result).not.toBeNull();
    expect(result?.supabaseUrl).toBe(VALID_CONFIG.supabaseUrl);
    expect(result?.supabaseAnonKey).toBe(VALID_CONFIG.supabaseAnonKey);
    expect(result?.machineId).toBe(VALID_CONFIG.machineId);
  });

  it('does not throw', () => {
    expect(() => loadDaemonConfig()).not.toThrow();
  });
});

// ============================================================================
// loadDaemonConfig — file absent
// ============================================================================

describe('loadDaemonConfig — file absent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  it('returns null when the file does not exist', () => {
    const result = loadDaemonConfig();
    expect(result).toBeNull();
  });

  it('does not call readFileSync', () => {
    loadDaemonConfig();
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });
});

// ============================================================================
// loadDaemonConfig — malformed JSON
// ============================================================================

describe('loadDaemonConfig — malformed JSON', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('this is not json {{{');
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('returns null on malformed JSON', () => {
    const result = loadDaemonConfig();
    expect(result).toBeNull();
  });

  it('logs a warning rather than throwing', () => {
    loadDaemonConfig();
    expect(warnSpy).toHaveBeenCalled();
    const msg = warnSpy.mock.calls[0]?.[0] as string;
    expect(msg).toMatch(/config\.json/i);
  });
});

// ============================================================================
// loadDaemonConfig — missing required fields
// ============================================================================

describe('loadDaemonConfig — valid JSON but missing required fields', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(true);
    // Valid JSON but no supabaseUrl or supabaseAnonKey
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ machineId: 'x' }));
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('returns null when required fields are absent', () => {
    const result = loadDaemonConfig();
    expect(result).toBeNull();
  });

  it('logs a warning about missing fields', () => {
    loadDaemonConfig();
    expect(warnSpy).toHaveBeenCalled();
    const msg = warnSpy.mock.calls[0]?.[0] as string;
    expect(msg).toMatch(/missing required fields/i);
  });
});

// ============================================================================
// writeDaemonConfig — creates directory and file
// ============================================================================

describe('writeDaemonConfig — fresh write (no existing file)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No config dir and no existing config file
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(fs.readFileSync).mockReturnValue(''); // unreachable but safe
  });

  it('creates the config directory', () => {
    writeDaemonConfig({ supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'key1' });
    expect(fs.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('.styrby'),
      expect.objectContaining({ recursive: true })
    );
  });

  it('writes the config file', () => {
    writeDaemonConfig({ supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'key1' });
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it('writes with mode 0o600', () => {
    writeDaemonConfig({ supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'key1' });
    const [, , options] = vi.mocked(fs.writeFileSync).mock.calls[0] as [unknown, unknown, { mode: number }];
    expect(options?.mode).toBe(0o600);
  });

  it('serialises supabaseUrl and supabaseAnonKey into the written content', () => {
    writeDaemonConfig({ supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'key1' });
    const [, content] = vi.mocked(fs.writeFileSync).mock.calls[0] as [unknown, string];
    const parsed = JSON.parse(content);
    expect(parsed.supabaseUrl).toBe('https://x.supabase.co');
    expect(parsed.supabaseAnonKey).toBe('key1');
  });

  it('sets createdAt and updatedAt', () => {
    writeDaemonConfig({ supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'key1' });
    const [, content] = vi.mocked(fs.writeFileSync).mock.calls[0] as [unknown, string];
    const parsed = JSON.parse(content);
    expect(typeof parsed.createdAt).toBe('string');
    expect(typeof parsed.updatedAt).toBe('string');
  });
});

// ============================================================================
// writeDaemonConfig — merges with existing config
// ============================================================================

describe('writeDaemonConfig — merge with existing config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Config dir exists but config file also exists
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      // The dirname (config dir) exists; the file itself also exists
      return true;
    });
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(VALID_CONFIG));
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
  });

  it('preserves existing machineId when not overwritten', () => {
    writeDaemonConfig({ supabaseUrl: 'https://new.supabase.co', supabaseAnonKey: 'newkey' });
    const [, content] = vi.mocked(fs.writeFileSync).mock.calls[0] as [unknown, string];
    const parsed = JSON.parse(content);
    expect(parsed.machineId).toBe(VALID_CONFIG.machineId);
  });

  it('overwrites supabaseUrl when new value is supplied', () => {
    writeDaemonConfig({ supabaseUrl: 'https://new.supabase.co', supabaseAnonKey: 'newkey' });
    const [, content] = vi.mocked(fs.writeFileSync).mock.calls[0] as [unknown, string];
    const parsed = JSON.parse(content);
    expect(parsed.supabaseUrl).toBe('https://new.supabase.co');
  });

  it('preserves original createdAt on update', () => {
    writeDaemonConfig({ supabaseUrl: 'https://new.supabase.co', supabaseAnonKey: 'newkey' });
    const [, content] = vi.mocked(fs.writeFileSync).mock.calls[0] as [unknown, string];
    const parsed = JSON.parse(content);
    expect(parsed.createdAt).toBe(VALID_CONFIG.createdAt);
  });

  it('updates updatedAt on each write', () => {
    writeDaemonConfig({ supabaseUrl: 'https://new.supabase.co', supabaseAnonKey: 'newkey' });
    const [, content] = vi.mocked(fs.writeFileSync).mock.calls[0] as [unknown, string];
    const parsed = JSON.parse(content);
    // updatedAt should differ from the original value (it is set to `now`)
    expect(parsed.updatedAt).not.toBe(VALID_CONFIG.updatedAt);
  });
});
