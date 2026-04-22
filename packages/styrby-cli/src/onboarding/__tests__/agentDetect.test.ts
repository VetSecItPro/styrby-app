/**
 * Tests for smart agent detection (onboarding/agentDetect.ts).
 *
 * Covers:
 * - whichSync: returns path when command is found, null when not found
 * - isExecutable: true for accessible file, false for missing/permission denied
 * - detectSingleAgent: PATH hit, extraPath fallback, not found
 * - detectAgents: zero-found branch, single-found branch, multi-found branch
 *
 * WHY: detectAgents drives the onboarding branching decision (install /
 * auto-select / picker). A regression here silently mis-routes users into
 * the wrong UX path on first install.
 *
 * @module onboarding/__tests__/agentDetect.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// Mocks — must be declared before import
// ============================================================================

vi.mock('node:child_process', () => ({
  execSync: vi.fn<[string, object?], string>(),
}));

vi.mock('node:fs', () => ({
  accessSync: vi.fn<[string, number?], void>(),
  constants: { X_OK: 1 },
  existsSync: vi.fn<[string], boolean>(() => false),
}));

// ============================================================================
// Import after mocks are registered
// ============================================================================

import { execSync } from 'node:child_process';
import * as nodeFsModule from 'node:fs';
import {
  whichSync,
  isExecutable,
  detectSingleAgent,
  detectAgents,
} from '../agentDetect.js';

// ============================================================================
// Helpers
// ============================================================================

const mockExecSync = execSync as ReturnType<typeof vi.fn>;
const mockAccessSync = nodeFsModule.accessSync as ReturnType<typeof vi.fn>;

// A minimal registry entry for testing
const claudeEntry = {
  id: 'claude' as const,
  name: 'Claude Code',
  command: 'claude',
  extraPaths: ['/usr/local/bin/claude'],
};

// ============================================================================
// whichSync
// ============================================================================

describe('whichSync', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it('returns the binary path when the command is found', () => {
    mockExecSync.mockReturnValue('/usr/local/bin/claude\n');
    const result = whichSync('claude');
    expect(result).toBe('/usr/local/bin/claude');
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('claude'),
      expect.any(Object)
    );
  });

  it('returns null when the command is not found', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('not found');
    });
    const result = whichSync('nonexistent-agent');
    expect(result).toBeNull();
  });

  it('returns null when execSync returns empty string', () => {
    mockExecSync.mockReturnValue('');
    const result = whichSync('claude');
    expect(result).toBeNull();
  });

  it('trims trailing newlines from the path', () => {
    mockExecSync.mockReturnValue('/home/user/.local/bin/claude\n\n');
    expect(whichSync('claude')).toBe('/home/user/.local/bin/claude');
  });
});

// ============================================================================
// isExecutable
// ============================================================================

describe('isExecutable', () => {
  beforeEach(() => {
    mockAccessSync.mockReset();
  });

  it('returns true when accessSync succeeds', () => {
    mockAccessSync.mockImplementation(() => undefined);
    expect(isExecutable('/usr/local/bin/claude')).toBe(true);
  });

  it('returns false when accessSync throws (file missing or no execute bit)', () => {
    mockAccessSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(isExecutable('/usr/local/bin/nonexistent')).toBe(false);
  });
});

// ============================================================================
// detectSingleAgent
// ============================================================================

describe('detectSingleAgent', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockAccessSync.mockReset();
  });

  it('returns a DetectedAgent when found via PATH (which)', () => {
    mockExecSync.mockReturnValue('/usr/local/bin/claude\n');
    const result = detectSingleAgent(claudeEntry);
    expect(result).not.toBeNull();
    expect(result?.id).toBe('claude');
    expect(result?.binPath).toBe('/usr/local/bin/claude');
  });

  it('falls back to extraPaths when which fails', () => {
    // which fails
    mockExecSync.mockImplementation(() => {
      throw new Error('not found');
    });
    // extraPath is executable
    mockAccessSync.mockImplementation(() => undefined);

    const result = detectSingleAgent(claudeEntry);
    expect(result).not.toBeNull();
    expect(result?.id).toBe('claude');
    expect(result?.binPath).toBe('/usr/local/bin/claude');
  });

  it('returns null when both which and extraPaths fail', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('not found');
    });
    mockAccessSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(detectSingleAgent(claudeEntry)).toBeNull();
  });

  it('prefers the PATH result over extraPaths when both are available', () => {
    mockExecSync.mockReturnValue('/custom/path/claude\n');
    // accessSync would succeed too, but PATH should win
    mockAccessSync.mockImplementation(() => undefined);

    const result = detectSingleAgent(claudeEntry);
    expect(result?.binPath).toBe('/custom/path/claude');
  });
});

// ============================================================================
// detectAgents — the main branching function
// ============================================================================

describe('detectAgents', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockAccessSync.mockReset();
  });

  it('returns { kind: "none" } when no agents are installed', () => {
    // All which calls throw, all accessSync calls throw
    mockExecSync.mockImplementation(() => {
      throw new Error('not found');
    });
    mockAccessSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const result = detectAgents();
    expect(result.kind).toBe('none');
  });

  it('returns { kind: "single" } when exactly one agent is installed', () => {
    // Only claude is found via PATH
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes(' claude')) return '/usr/local/bin/claude\n';
      throw new Error('not found');
    });
    mockAccessSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const result = detectAgents();
    expect(result.kind).toBe('single');
    if (result.kind === 'single') {
      expect(result.agent.id).toBe('claude');
    }
  });

  it('returns { kind: "multiple" } when more than one agent is installed', () => {
    // claude and codex are found
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes(' claude')) return '/usr/local/bin/claude\n';
      if (cmd.includes(' codex')) return '/usr/local/bin/codex\n';
      throw new Error('not found');
    });
    mockAccessSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const result = detectAgents();
    expect(result.kind).toBe('multiple');
    if (result.kind === 'multiple') {
      expect(result.agents.length).toBeGreaterThanOrEqual(2);
      const ids = result.agents.map((a) => a.id);
      expect(ids).toContain('claude');
      expect(ids).toContain('codex');
    }
  });

  it('includes agents found via extraPaths (not in PATH)', () => {
    // which throws for all agents
    mockExecSync.mockImplementation(() => {
      throw new Error('not found');
    });
    // Only the extraPath for goose is accessible
    mockAccessSync.mockImplementation((p: string) => {
      if (p.includes('goose')) return undefined;
      throw new Error('ENOENT');
    });

    const result = detectAgents();
    if (result.kind !== 'none') {
      const ids =
        result.kind === 'single' ? [result.agent.id] : result.agents.map((a) => a.id);
      expect(ids).toContain('goose');
    }
  });

  it('detects all 11 agents when all are in PATH', () => {
    const allIds = ['claude','codex','gemini','opencode','aider','goose','amp','crush','kilo','kiro','droid'];
    mockExecSync.mockImplementation((cmd: string) => {
      for (const id of allIds) {
        if (cmd.includes(` ${id}`)) return `/usr/local/bin/${id}\n`;
      }
      throw new Error('not found');
    });

    const result = detectAgents();
    expect(result.kind).toBe('multiple');
    if (result.kind === 'multiple') {
      expect(result.agents.length).toBe(11);
    }
  });
});
