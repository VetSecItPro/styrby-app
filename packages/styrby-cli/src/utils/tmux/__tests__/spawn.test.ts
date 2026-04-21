/**
 * Tests for spawnInTmux — Phase 1 #4 batch 2 follow-up.
 *
 * Stubs `TmuxUtilities.executeTmuxCommand` and `ensureSessionExists` so
 * we can assert spawnInTmux's branching behavior:
 *   - tmux unavailable → error result
 *   - explicit session name path
 *   - default-session path (uses first existing or "happy")
 *   - env propagation through buildEnvFlags
 *   - PID extraction failure
 *   - new-window failure surfaced
 *
 * @module utils/tmux/__tests__/spawn
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnInTmuxStandalone as spawnInTmux } from '../spawn';
import type { TmuxUtilities } from '../utilities';

// Mock the module logger to keep test output clean
vi.mock('@/ui/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/**
 * Build a fake TmuxUtilities with stubbable executeTmuxCommand +
 * ensureSessionExists. Returns the stub object plus a record of every call.
 */
function makeUtils(overrides: Partial<TmuxUtilities> = {}): {
  utils: TmuxUtilities;
  exec: ReturnType<typeof vi.fn>;
  ensure: ReturnType<typeof vi.fn>;
} {
  const exec = vi.fn();
  const ensure = vi.fn().mockResolvedValue(true);
  const utils = {
    executeTmuxCommand: exec,
    ensureSessionExists: ensure,
    ...overrides,
  } as unknown as TmuxUtilities;
  return { utils, exec, ensure };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('spawnInTmux', () => {
  it('returns failure when tmux is not available', async () => {
    const { utils, exec } = makeUtils();
    exec.mockResolvedValueOnce(null); // first call (list-sessions check) returns null

    const result = await spawnInTmux(utils, ['echo', 'hi']);

    expect(result.success).toBe(false);
    expect(result.error).toContain('tmux not available');
  });

  it('uses the explicit sessionName when provided', async () => {
    const { utils, exec, ensure } = makeUtils();
    // 1st call: tmux availability check
    exec.mockResolvedValueOnce({ returncode: 0, stdout: '', stderr: '' });
    // 2nd call: new-window with PID stdout
    exec.mockResolvedValueOnce({ returncode: 0, stdout: '12345\n', stderr: '' });

    const result = await spawnInTmux(utils, ['npm', 'run', 'dev'], {
      sessionName: 'my-session',
    });

    expect(result.success).toBe(true);
    expect(result.pid).toBe(12345);
    expect(ensure).toHaveBeenCalledWith('my-session');
  });

  it('falls back to first existing session when sessionName is empty', async () => {
    const { utils, exec } = makeUtils();
    // tmux check
    exec.mockResolvedValueOnce({ returncode: 0, stdout: '', stderr: '' });
    // list-sessions for default-session resolution
    exec.mockResolvedValueOnce({
      returncode: 0,
      stdout: 'existing-1\nexisting-2\n',
      stderr: '',
    });
    // new-window
    exec.mockResolvedValueOnce({ returncode: 0, stdout: '999\n', stderr: '' });

    const result = await spawnInTmux(utils, ['ls'], { sessionName: '' });

    expect(result.success).toBe(true);
    expect(result.sessionId).toContain('existing-1');
  });

  it('falls back to "happy" session when no sessions exist', async () => {
    const { utils, exec } = makeUtils();
    exec.mockResolvedValueOnce({ returncode: 0, stdout: '', stderr: '' });
    exec.mockResolvedValueOnce({ returncode: 0, stdout: '', stderr: '' });
    exec.mockResolvedValueOnce({ returncode: 0, stdout: '5555\n', stderr: '' });

    const result = await spawnInTmux(utils, ['ls']);

    expect(result.success).toBe(true);
    expect(result.sessionId).toContain('happy');
  });

  it('returns failure when new-window returncode is non-zero', async () => {
    const { utils, exec } = makeUtils();
    exec.mockResolvedValueOnce({ returncode: 0, stdout: '', stderr: '' });
    exec.mockResolvedValueOnce({
      returncode: 1,
      stdout: '',
      stderr: 'duplicate window name',
    });

    const result = await spawnInTmux(utils, ['ls'], { sessionName: 's1' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to create tmux window');
  });

  it('returns failure when PID extraction fails (NaN stdout)', async () => {
    const { utils, exec } = makeUtils();
    exec.mockResolvedValueOnce({ returncode: 0, stdout: '', stderr: '' });
    exec.mockResolvedValueOnce({
      returncode: 0,
      stdout: 'not-a-pid\n',
      stderr: '',
    });

    const result = await spawnInTmux(utils, ['ls'], { sessionName: 's1' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to extract PID');
  });

  it('passes env vars through to new-window via -e flags', async () => {
    const { utils, exec } = makeUtils();
    exec.mockResolvedValueOnce({ returncode: 0, stdout: '', stderr: '' });
    exec.mockResolvedValueOnce({ returncode: 0, stdout: '7777\n', stderr: '' });

    await spawnInTmux(
      utils,
      ['npm', 'start'],
      { sessionName: 's1' },
      { FOO: 'bar', PATH: '/x' },
    );

    // The new-window call (2nd exec) must contain `-e` flags for both env vars.
    // buildEnvFlags wraps the value in double quotes (`KEY="value"`) for the
    // shell-escaping path; assert on the wrapped form.
    const newWindowArgs = exec.mock.calls[1][0] as string[];
    expect(newWindowArgs.filter((a) => a === '-e')).toHaveLength(2);
    expect(newWindowArgs).toContain('FOO="bar"');
    expect(newWindowArgs).toContain('PATH="/x"');
  });

  it('honors explicit windowName when provided', async () => {
    const { utils, exec } = makeUtils();
    exec.mockResolvedValueOnce({ returncode: 0, stdout: '', stderr: '' });
    exec.mockResolvedValueOnce({ returncode: 0, stdout: '1\n', stderr: '' });

    await spawnInTmux(utils, ['x'], { sessionName: 's1', windowName: 'custom-name' });

    const newWindowArgs = exec.mock.calls[1][0] as string[];
    const nIdx = newWindowArgs.indexOf('-n');
    expect(newWindowArgs[nIdx + 1]).toBe('custom-name');
  });

  it('passes -c <cwd> when options.cwd is a string', async () => {
    const { utils, exec } = makeUtils();
    exec.mockResolvedValueOnce({ returncode: 0, stdout: '', stderr: '' });
    exec.mockResolvedValueOnce({ returncode: 0, stdout: '1\n', stderr: '' });

    await spawnInTmux(utils, ['x'], { sessionName: 's1', cwd: '/tmp/foo' });

    const newWindowArgs = exec.mock.calls[1][0] as string[];
    const cIdx = newWindowArgs.indexOf('-c');
    expect(newWindowArgs[cIdx + 1]).toBe('/tmp/foo');
  });

  it('returns failure on thrown exception', async () => {
    const { utils, exec } = makeUtils();
    exec.mockRejectedValueOnce(new Error('tmux exploded'));

    const result = await spawnInTmux(utils, ['x']);

    expect(result.success).toBe(false);
    expect(result.error).toContain('tmux exploded');
  });
});
