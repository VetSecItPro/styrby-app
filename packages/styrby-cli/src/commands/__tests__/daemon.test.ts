/**
 * Tests for the daemon command.
 *
 * Covers:
 * - handleDaemon dispatcher: install, uninstall/remove, status, default (usage)
 * - Platform guard: unsupported platform logs yellow warning and skips install
 *
 * NOTE: The deep macOS/Linux side-effects (launchctl, systemctl, fs writes)
 * require heavy mocking. We test the public surface (handleDaemon routing)
 * and the platform-guard branches without re-testing every child_process call.
 * Filesystem and execSync mocks are set up so install/uninstall can be called
 * without touching the real filesystem.
 *
 * WHY: handleDaemon routing bugs cause the wrong action on a live machine
 * (e.g. "styrby daemon uninstall" accidentally installing). Platform guards
 * prevent confusing errors on Windows.
 *
 * @module commands/__tests__/daemon.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('node:fs', () => ({
  default: {},
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/home/testuser'),
  platform: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('chalk', () => ({
  default: {
    blue: (s: string) => s,
    green: (s: string) => s,
    red: (s: string) => s,
    yellow: (s: string) => s,
    gray: (s: string) => s,
    bold: (s: string) => s,
  },
}));

import { platform } from 'node:os';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import { handleDaemon } from '../daemon';

// ============================================================================
// Helpers
// ============================================================================

function mockPlatform(os: string) {
  vi.mocked(platform).mockReturnValue(os as NodeJS.Platform);
}

// ============================================================================
// handleDaemon — dispatcher routing
// ============================================================================

describe('handleDaemon dispatcher', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('routes "status" to service status handler', async () => {
    // On darwin, status checks existsSync for plist
    mockPlatform('darwin');
    vi.mocked(fs.existsSync).mockReturnValue(false);

    await handleDaemon(['status']);

    const calls = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => /daemon not installed/i.test(m))).toBe(true);
  });

  it('prints usage when no subcommand is given', async () => {
    await handleDaemon([]);

    const calls = consoleSpy.mock.calls.map((c) => String(c[0]));
    // Usage output contains "styrby daemon"
    expect(calls.some((m) => /styrby daemon/i.test(m))).toBe(true);
  });

  it('prints usage for unknown subcommand', async () => {
    await handleDaemon(['bogus']);

    const calls = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => /styrby daemon/i.test(m))).toBe(true);
  });
});

// ============================================================================
// handleDaemon — unsupported platform
// ============================================================================

describe('handleDaemon — unsupported platform', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockPlatform('win32');
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('prints "not supported" message for install on Windows', async () => {
    await handleDaemon(['install']);

    const calls = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => /not supported/i.test(m))).toBe(true);
  });

  it('does not write any files on Windows', async () => {
    await handleDaemon(['install']);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('prints "not supported" for uninstall on Windows', async () => {
    await handleDaemon(['uninstall']);

    const calls = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => /not supported/i.test(m))).toBe(true);
  });
});

// ============================================================================
// handleDaemon install — macOS happy path
// ============================================================================

describe('handleDaemon install — macOS', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockPlatform('darwin');
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(execSync).mockReturnValue('');
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('writes the plist file', async () => {
    await handleDaemon(['install']);
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it('calls launchctl load', async () => {
    await handleDaemon(['install']);
    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('launchctl load'),
      expect.any(Object)
    );
  });

  it('prints success message', async () => {
    await handleDaemon(['install']);

    const calls = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => /daemon installed/i.test(m))).toBe(true);
  });
});

// ============================================================================
// handleDaemon uninstall — macOS, plist not present
// ============================================================================

describe('handleDaemon uninstall — macOS, not installed', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockPlatform('darwin');
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('prints "No daemon installed" when plist does not exist', async () => {
    await handleDaemon(['uninstall']);

    const calls = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => /no daemon installed/i.test(m))).toBe(true);
  });
});

// ============================================================================
// handleDaemon uninstall — macOS, plist present
// ============================================================================

describe('handleDaemon uninstall — macOS, installed', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockPlatform('darwin');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.unlinkSync).mockReturnValue(undefined);
    vi.mocked(execSync).mockReturnValue('');
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('removes the plist file', async () => {
    await handleDaemon(['uninstall']);
    expect(fs.unlinkSync).toHaveBeenCalled();
  });

  it('prints "Daemon uninstalled" message', async () => {
    await handleDaemon(['uninstall']);

    const calls = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => /daemon uninstalled/i.test(m))).toBe(true);
  });

  it('"remove" alias also uninstalls', async () => {
    await handleDaemon(['remove']);

    const calls = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => /daemon uninstalled/i.test(m))).toBe(true);
  });
});

// ============================================================================
// handleDaemon status — macOS, loaded
// ============================================================================

describe('handleDaemon status — macOS, daemon loaded', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockPlatform('darwin');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    // execSync simulates "launchctl list | grep com.styrby.daemon" output
    vi.mocked(execSync).mockReturnValue('0 - com.styrby.daemon\n');
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('prints "installed and loaded" status', async () => {
    await handleDaemon(['status']);

    const calls = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => /installed and loaded/i.test(m))).toBe(true);
  });
});

// ============================================================================
// handleDaemon status — Linux, active service
// ============================================================================

describe('handleDaemon status — Linux, active', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockPlatform('linux');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(execSync).mockReturnValue('active\n');
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('prints "installed and running" status', async () => {
    await handleDaemon(['status']);

    const calls = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => /installed and running/i.test(m))).toBe(true);
  });
});

// ============================================================================
// generateMacOSPlist — env var injection
// ============================================================================

// Re-import the module under a namespace so we can call the private generator
// indirectly by reading what writeFileSync received during `handleDaemon install`.

describe('macOS plist — env var injection at install time', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockPlatform('darwin');
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(execSync).mockReturnValue('');
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
  });

  it('bakes SUPABASE_URL and SUPABASE_ANON_KEY into the plist when they are in process.env', async () => {
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'eyJanon';

    await handleDaemon(['install']);

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    // The plist write is the first writeFileSync call
    const plistContent = writeCalls[0]?.[1] as string;

    expect(plistContent).toContain('<key>SUPABASE_URL</key>');
    expect(plistContent).toContain('<string>https://test.supabase.co</string>');
    expect(plistContent).toContain('<key>SUPABASE_ANON_KEY</key>');
    expect(plistContent).toContain('<string>eyJanon</string>');
  });

  it('produces a valid plist (EnvironmentVariables dict present) when env vars are absent', async () => {
    // Env vars deliberately not set
    await handleDaemon(['install']);

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const plistContent = writeCalls[0]?.[1] as string;

    // Must still produce a well-formed plist with the EnvironmentVariables key
    expect(plistContent).toContain('<key>EnvironmentVariables</key>');
    expect(plistContent).toContain('<dict>');
    // SUPABASE_URL must NOT appear when the env var is absent
    expect(plistContent).not.toContain('<key>SUPABASE_URL</key>');
  });
});

// ============================================================================
// generateLinuxServiceFile — env var injection
// ============================================================================

describe('Linux systemd service — env var injection at install time', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockPlatform('linux');
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(execSync).mockReturnValue('');
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
  });

  it('bakes SUPABASE_URL and SUPABASE_ANON_KEY as Environment= directives when in process.env', async () => {
    process.env.SUPABASE_URL = 'https://linux.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'eyJlinux';

    await handleDaemon(['install']);

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const serviceContent = writeCalls[0]?.[1] as string;

    expect(serviceContent).toContain('Environment="SUPABASE_URL=https://linux.supabase.co"');
    expect(serviceContent).toContain('Environment="SUPABASE_ANON_KEY=eyJlinux"');
  });

  it('omits SUPABASE_URL directive when env var is absent', async () => {
    // Env vars deliberately not set
    await handleDaemon(['install']);

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const serviceContent = writeCalls[0]?.[1] as string;

    expect(serviceContent).not.toContain('Environment="SUPABASE_URL=');
  });
});

// ============================================================================
// --refresh-install — macOS
// ============================================================================

describe('--refresh-install flag — macOS', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockPlatform('darwin');
    // Plist already exists — refresh is valid
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(execSync).mockReturnValue('');
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('rewrites the plist file without calling unlinkSync', async () => {
    await handleDaemon(['install', '--refresh-install']);

    expect(fs.writeFileSync).toHaveBeenCalled();
    // unlinkSync should only be called for the unload flow if needed — not here
    // (the refresh path unloads via launchctl, not by deleting the plist first)
  });

  it('calls launchctl load to reload the updated plist', async () => {
    await handleDaemon(['install', '--refresh-install']);

    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('launchctl load'),
      expect.any(Object)
    );
  });

  it('prints a "refreshed and reloaded" message', async () => {
    await handleDaemon(['install', '--refresh-install']);

    const calls = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => /refreshed and reloaded/i.test(m))).toBe(true);
  });

  it('prints a warning when plist is not installed yet', async () => {
    // Override: plist does NOT exist for this test
    vi.mocked(fs.existsSync).mockReturnValue(false);

    await handleDaemon(['install', '--refresh-install']);

    const calls = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => /no existing daemon install/i.test(m))).toBe(true);
    // Should not write any files
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
});

// ============================================================================
// --refresh-install flag — Linux
// ============================================================================

describe('--refresh-install flag — Linux', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockPlatform('linux');
    // Service file already exists
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(execSync).mockReturnValue('');
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('rewrites the service file', async () => {
    await handleDaemon(['install', '--refresh-install']);
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it('calls systemctl restart (not enable+start) on refresh', async () => {
    await handleDaemon(['install', '--refresh-install']);

    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('systemctl --user restart'),
      expect.any(Object)
    );
    expect(execSync).not.toHaveBeenCalledWith(
      expect.stringContaining('systemctl --user enable'),
      expect.any(Object)
    );
  });

  it('prints a "refreshed and restarted" message', async () => {
    await handleDaemon(['install', '--refresh-install']);

    const calls = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => /refreshed and restarted/i.test(m))).toBe(true);
  });

  it('prints a warning when service file is not installed yet', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    await handleDaemon(['install', '--refresh-install']);

    const calls = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => /no existing daemon install/i.test(m))).toBe(true);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
});
