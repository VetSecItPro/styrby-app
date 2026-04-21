/**
 * Tests for agent/factories/gemini.ts
 *
 * Covers:
 * - createGeminiBackend: returns backend + model + modelSource
 * - createGeminiBackend: apiKey resolution priority (cloudToken > localConfig > env > explicit)
 * - createGeminiBackend: model resolution via determineGeminiModel
 * - createGeminiBackend: Google Cloud Project forwarding
 * - createGeminiBackend: hasChangeTitleInstruction heuristic
 * - registerGeminiAgent: registers with the global agent registry
 *
 * All filesystem, child_process, and ACP SDK calls are mocked.
 * No real Gemini CLI binary is required.
 *
 * @module factories/__tests__/gemini
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared before factory imports so Vitest's hoisting intercepts them.
// ---------------------------------------------------------------------------

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// WHY: readGeminiLocalConfig reads ~/.gemini/ filesystem paths. Mock it to
// return a controlled baseline so tests are hermetic and don't depend on the
// developer's local Gemini CLI installation.
vi.mock('@/gemini/utils/config', () => ({
  readGeminiLocalConfig: vi.fn(() => ({
    token: null,
    model: null,
    googleCloudProject: null,
    googleCloudProjectEmail: null,
  })),
  determineGeminiModel: vi.fn((model: string | null | undefined) => {
    if (model !== undefined && model !== null) return model;
    return 'gemini-2.5-pro';
  }),
  getGeminiModelSource: vi.fn((model: string | null | undefined) => {
    if (model !== undefined && model !== null) return 'explicit';
    return 'default';
  }),
}));

vi.mock('@/gemini/constants', () => ({
  GEMINI_API_KEY_ENV: 'GEMINI_API_KEY',
  GOOGLE_API_KEY_ENV: 'GOOGLE_API_KEY',
  GEMINI_MODEL_ENV: 'GEMINI_MODEL',
  DEFAULT_GEMINI_MODEL: 'gemini-2.5-pro',
}));

// WHY: AcpBackend spawns a real subprocess on start. We replace it with a
// minimal stub that only validates factory options are forwarded correctly.
vi.mock('../../acp/AcpBackend', () => ({
  AcpBackend: vi.fn().mockImplementation((opts: Record<string, unknown>) => ({
    _opts: opts,
    startSession: vi.fn().mockResolvedValue({ sessionId: 'mock-session' }),
    sendPrompt: vi.fn(),
    cancel: vi.fn(),
    onMessage: vi.fn(),
    offMessage: vi.fn(),
    dispose: vi.fn(),
    respondToPermission: vi.fn(),
    waitForResponseComplete: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Imports AFTER vi.mock declarations
// ---------------------------------------------------------------------------

import { createGeminiBackend, registerGeminiAgent } from '../gemini';
import { agentRegistry } from '../../core';
import { AcpBackend } from '../../acp/AcpBackend';
import { readGeminiLocalConfig, determineGeminiModel, getGeminiModelSource } from '@/gemini/utils/config';

const MockAcpBackend = AcpBackend as unknown as ReturnType<typeof vi.fn>;
const mockReadConfig = readGeminiLocalConfig as unknown as ReturnType<typeof vi.fn>;
const mockDetermineModel = determineGeminiModel as unknown as ReturnType<typeof vi.fn>;
const mockGetModelSource = getGeminiModelSource as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Reset to no-op defaults
  mockReadConfig.mockReturnValue({
    token: null,
    model: null,
    googleCloudProject: null,
    googleCloudProjectEmail: null,
  });
  mockDetermineModel.mockImplementation((m: string | null | undefined) =>
    m !== undefined && m !== null ? m : 'gemini-2.5-pro'
  );
  mockGetModelSource.mockImplementation((m: string | null | undefined) =>
    m !== undefined && m !== null ? 'explicit' : 'default'
  );
  MockAcpBackend.mockImplementation((opts: Record<string, unknown>) => ({
    _opts: opts,
    startSession: vi.fn().mockResolvedValue({ sessionId: 'mock-session' }),
    sendPrompt: vi.fn(),
    cancel: vi.fn(),
    onMessage: vi.fn(),
    offMessage: vi.fn(),
    dispose: vi.fn(),
    respondToPermission: vi.fn(),
    waitForResponseComplete: vi.fn(),
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// createGeminiBackend — return shape
// ===========================================================================

describe('createGeminiBackend — return shape', () => {
  it('returns a backend, model, and modelSource', () => {
    const result = createGeminiBackend({ cwd: '/project', model: 'gemini-2.5-flash' });

    expect(result).toHaveProperty('backend');
    expect(result).toHaveProperty('model');
    expect(result).toHaveProperty('modelSource');
  });

  it('backend implements the AgentBackend interface', () => {
    const { backend } = createGeminiBackend({ cwd: '/project' });

    expect(typeof backend.startSession).toBe('function');
    expect(typeof backend.sendPrompt).toBe('function');
    expect(typeof backend.cancel).toBe('function');
    expect(typeof backend.onMessage).toBe('function');
    expect(typeof backend.offMessage).toBe('function');
    expect(typeof backend.dispose).toBe('function');
  });

  it('does NOT spawn a subprocess at factory creation time', () => {
    createGeminiBackend({ cwd: '/project' });
    // AcpBackend constructor is called but spawn happens inside startSession
    expect(MockAcpBackend).toHaveBeenCalledOnce();
  });
});

// ===========================================================================
// createGeminiBackend — model resolution
// ===========================================================================

describe('createGeminiBackend — model resolution', () => {
  it('passes explicit model option to determineGeminiModel', () => {
    createGeminiBackend({ cwd: '/project', model: 'gemini-2.5-flash' });

    expect(mockDetermineModel).toHaveBeenCalledWith('gemini-2.5-flash', expect.anything());
  });

  it('returns the model resolved by determineGeminiModel', () => {
    mockDetermineModel.mockReturnValue('gemini-2.5-pro');
    const { model } = createGeminiBackend({ cwd: '/project' });

    expect(model).toBe('gemini-2.5-pro');
  });

  it('returns the modelSource from getGeminiModelSource', () => {
    mockGetModelSource.mockReturnValue('env-var');
    const { modelSource } = createGeminiBackend({ cwd: '/project' });

    expect(modelSource).toBe('env-var');
  });
});

// ===========================================================================
// createGeminiBackend — apiKey resolution priority
// ===========================================================================

describe('createGeminiBackend — apiKey resolution', () => {
  it('prefers cloudToken over all other API key sources', () => {
    mockReadConfig.mockReturnValue({ token: 'local-token', model: null, googleCloudProject: null, googleCloudProjectEmail: null });

    createGeminiBackend({ cwd: '/project', cloudToken: 'cloud-token-xyz' });

    const [opts] = MockAcpBackend.mock.calls[0];
    // GEMINI_API_KEY in the spawned env must be the cloud token
    expect(opts.env.GEMINI_API_KEY).toBe('cloud-token-xyz');
  });

  it('falls back to localConfig.token when cloudToken is absent', () => {
    mockReadConfig.mockReturnValue({ token: 'stored-token', model: null, googleCloudProject: null, googleCloudProjectEmail: null });

    createGeminiBackend({ cwd: '/project' });

    const [opts] = MockAcpBackend.mock.calls[0];
    expect(opts.env.GEMINI_API_KEY).toBe('stored-token');
  });

  it('falls back to explicit apiKey option as last resort', () => {
    // No cloudToken, no localConfig token, no env var
    createGeminiBackend({ cwd: '/project', apiKey: 'explicit-key' });

    const [opts] = MockAcpBackend.mock.calls[0];
    expect(opts.env.GEMINI_API_KEY).toBe('explicit-key');
  });

  it('does NOT set GEMINI_API_KEY when no key source is available', () => {
    const origGeminiKey = process.env.GEMINI_API_KEY;
    const origGoogleKey = process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;

    createGeminiBackend({ cwd: '/project' });

    const [opts] = MockAcpBackend.mock.calls[0];
    expect(opts.env.GEMINI_API_KEY).toBeUndefined();

    // Restore
    if (origGeminiKey !== undefined) process.env.GEMINI_API_KEY = origGeminiKey;
    if (origGoogleKey !== undefined) process.env.GOOGLE_API_KEY = origGoogleKey;
  });
});

// ===========================================================================
// createGeminiBackend — AcpBackend options
// ===========================================================================

describe('createGeminiBackend — AcpBackend options', () => {
  it('passes cwd to AcpBackend', () => {
    createGeminiBackend({ cwd: '/my/workspace' });

    const [opts] = MockAcpBackend.mock.calls[0];
    expect(opts.cwd).toBe('/my/workspace');
  });

  it('sets agentName to "gemini"', () => {
    createGeminiBackend({ cwd: '/project' });

    const [opts] = MockAcpBackend.mock.calls[0];
    expect(opts.agentName).toBe('gemini');
  });

  it('passes --experimental-acp as the only CLI arg', () => {
    createGeminiBackend({ cwd: '/project' });

    const [opts] = MockAcpBackend.mock.calls[0];
    expect(opts.args).toEqual(['--experimental-acp']);
  });

  it('forwards mcpServers option to AcpBackend', () => {
    createGeminiBackend({
      cwd: '/project',
      mcpServers: { myServer: { command: 'python', args: ['-m', 'srv'] } },
    });

    const [opts] = MockAcpBackend.mock.calls[0];
    expect(opts.mcpServers).toHaveProperty('myServer');
  });

  it('forwards permissionHandler to AcpBackend', () => {
    const handler = vi.fn();
    createGeminiBackend({ cwd: '/project', permissionHandler: handler });

    const [opts] = MockAcpBackend.mock.calls[0];
    expect(opts.permissionHandler).toBe(handler);
  });

  it('sets GOOGLE_CLOUD_PROJECT when localConfig provides googleCloudProject', () => {
    mockReadConfig.mockReturnValue({
      token: null,
      model: null,
      googleCloudProject: 'my-project-123',
      googleCloudProjectEmail: null,
    });

    createGeminiBackend({ cwd: '/project' });

    const [opts] = MockAcpBackend.mock.calls[0];
    expect(opts.env.GOOGLE_CLOUD_PROJECT).toBe('my-project-123');
  });

  it('skips GOOGLE_CLOUD_PROJECT when stored email does not match currentUserEmail', () => {
    mockReadConfig.mockReturnValue({
      token: null,
      model: null,
      googleCloudProject: 'other-project',
      googleCloudProjectEmail: 'other@example.com',
    });

    createGeminiBackend({ cwd: '/project', currentUserEmail: 'me@example.com' });

    const [opts] = MockAcpBackend.mock.calls[0];
    expect(opts.env.GOOGLE_CLOUD_PROJECT).toBeUndefined();
  });
});

// ===========================================================================
// createGeminiBackend — hasChangeTitleInstruction heuristic
// ===========================================================================

describe('createGeminiBackend — hasChangeTitleInstruction', () => {
  function getHeuristic(): (prompt: string) => boolean {
    createGeminiBackend({ cwd: '/project' });
    const [opts] = MockAcpBackend.mock.calls[0];
    return opts.hasChangeTitleInstruction;
  }

  it('returns true for prompts containing "change_title"', () => {
    expect(getHeuristic()('Please change_title to Foo')).toBe(true);
  });

  it('returns true for prompts containing "change title" (with space)', () => {
    expect(getHeuristic()('Change title to Bar')).toBe(true);
  });

  it('returns true for prompts containing "set title"', () => {
    expect(getHeuristic()('Set title = Baz')).toBe(true);
  });

  it('returns true for prompts containing the MCP tool name', () => {
    expect(getHeuristic()('Use mcp__happy__change_title tool')).toBe(true);
  });

  it('returns false for unrelated prompts', () => {
    expect(getHeuristic()('Fix the login bug')).toBe(false);
  });
});

// ===========================================================================
// registerGeminiAgent
// ===========================================================================

describe('registerGeminiAgent', () => {
  it('registers "gemini" in the global agent registry', () => {
    registerGeminiAgent();

    expect(agentRegistry.has('gemini')).toBe(true);
  });

  it('registry can create a Gemini backend after registration', () => {
    registerGeminiAgent();

    const backend = agentRegistry.create('gemini', { cwd: '/project' });
    expect(backend).toBeDefined();
    expect(typeof backend.startSession).toBe('function');
  });
});
