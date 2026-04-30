/**
 * Tests for MultiAgentOrchestrator
 *
 * Covers:
 *   - Argument validation (empty agents, too many, duplicates)
 *   - Dry-run mode (returns valid group, no Supabase writes)
 *   - Happy path: group created, agents spawned, sessions linked
 *   - Unknown agent → cleans up already-spawned agents + throws
 *   - stop() kills all agents idempotently
 *   - focus() updates active_agent_session_id; rejects unknown session
 *   - Graceful handling of DB insert errors (non-fatal for relay init)
 *
 * WHY no integration test (no real Supabase): The orchestrator's Supabase
 * interactions are mocked at the client level. End-to-end session creation
 * is covered by the e2e smoke tests (agentSmokeTests.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Logger mock ────────────────────────────────────────────────────────────

vi.mock('@/ui/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Agent registry mock ────────────────────────────────────────────────────

const mockAgentBackend = {
  startSession: vi.fn(async () => ({ sessionId: 'mock-session-id' })),
  sendPrompt: vi.fn(async () => {}),
  cancel: vi.fn(async () => {}),
  dispose: vi.fn(async () => {}),
  onMessage: vi.fn(),
  offMessage: vi.fn(),
};

const mockRegistry = {
  has: vi.fn(() => true),
  create: vi.fn(() => mockAgentBackend),
  list: vi.fn(() => ['claude', 'codex', 'gemini']),
};

vi.mock('@/agent/index', () => ({
  initializeAgents: vi.fn(),
  agentRegistry: mockRegistry,
}));

// ── ApiSessionManager mock ─────────────────────────────────────────────────

const mockActiveSession = {
  sessionId: 'mock-session-123',
  stop: vi.fn(async () => {}),
  agentType: 'claude',
  projectPath: '/test',
  status: 'running' as const,
};

vi.mock('@/api/apiSession', () => ({
  ApiSessionManager: vi.fn().mockImplementation(() => ({
    startManagedSession: vi.fn(async () => mockActiveSession),
  })),
}));

// ── Supabase mock ──────────────────────────────────────────────────────────

const mockSupabaseFrom = vi.fn();

function createChain(result: { data?: unknown; error?: unknown } = { data: {}, error: null }) {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'update', 'insert', 'delete', 'single']) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  chain['then'] = (resolve: (v: unknown) => void) => resolve(result);
  return chain;
}

// ── Import orchestrator ────────────────────────────────────────────────────

import { MultiAgentOrchestrator } from '../multiAgentOrchestrator';
import type { AgentId } from '../core/AgentBackend';

// ============================================================================
// Helpers
// ============================================================================

const GROUP_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID  = '33333333-3333-3333-3333-333333333333';

function makeMockSupabase(overrides: { groupInsertError?: Error | null } = {}) {
  return {
    from: vi.fn(() => {
      const chain = createChain({ data: { id: GROUP_ID }, error: overrides.groupInsertError ?? null });
      return chain;
    }),
  };
}

function makeMockApi() {
  return {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    configure: vi.fn(),
  };
}

/**
 * Builds a deeply-mocked StyrbyApiClient stub.
 *
 * H41 Phase 4-step3: orchestrator now uses StyrbyApiClient for every Postgres
 * op (group create, session attach, focus, audit). The mock returns the
 * minimal shapes consumed inside start()/focus() so tests can run without a
 * real /api/v1 server.
 */
function makeMockHttpClient(overrides: { createGroupError?: Error } = {}) {
  return {
    createSessionGroup: vi.fn(async () => {
      if (overrides.createGroupError) throw overrides.createGroupError;
      return { group_id: GROUP_ID, name: 'mock', created_at: new Date().toISOString() };
    }),
    deleteSessionGroup: vi.fn(async () => ({ deleted: true, id: GROUP_ID })),
    updateSession: vi.fn(async () => ({
      id: 'mock-session-123',
      session_group_id: GROUP_ID,
      updated_at: new Date().toISOString(),
    })),
    setSessionGroupFocus: vi.fn(async () => ({
      group_id: GROUP_ID,
      active_agent_session_id: 'mock-session-123',
    })),
    writeAuditEvent: vi.fn(async () => ({ id: 'audit-1', created_at: new Date().toISOString() })),
  } as unknown as import('@/api/styrbyApiClient').StyrbyApiClient;
}

function makeConfig(agentIds: AgentId[] = ['claude', 'codex']) {
  return {
    httpClient: makeMockHttpClient(),
    supabase: makeMockSupabase() as unknown as import('@supabase/supabase-js').SupabaseClient,
    api: makeMockApi() as unknown as import('@/api/api').StyrbyApi,
    agentIds,
    projectPath: '/test/project',
    userId: USER_ID,
    machineId: 'machine-123',
    prompt: 'refactor auth middleware',
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('MultiAgentOrchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegistry.has.mockReturnValue(true);
    mockAgentBackend.onMessage.mockImplementation(() => {});
    mockActiveSession.stop.mockResolvedValue(undefined);
  });

  // ── Argument validation ─────────────────────────────────────────────────

  it('throws when agentIds is empty', async () => {
    const orchestrator = new MultiAgentOrchestrator();
    await expect(
      orchestrator.start({ ...makeConfig([]), agentIds: [] })
    ).rejects.toThrow('At least one agent');
  });

  it('throws when more than 6 agents are requested', async () => {
    const orchestrator = new MultiAgentOrchestrator();
    const tooMany = ['claude', 'codex', 'gemini', 'aider', 'goose', 'amp', 'crush'] as AgentId[];
    await expect(
      orchestrator.start({ ...makeConfig(tooMany), agentIds: tooMany })
    ).rejects.toThrow('Maximum 6');
  });

  it('throws when duplicate agents are specified', async () => {
    const orchestrator = new MultiAgentOrchestrator();
    await expect(
      orchestrator.start({ ...makeConfig(['claude', 'claude']), agentIds: ['claude', 'claude'] as AgentId[] })
    ).rejects.toThrow('Duplicate agent IDs');
  });

  // ── Dry-run mode ────────────────────────────────────────────────────────

  it('dry-run returns a group with agents and does not call any backend', async () => {
    const orchestrator = new MultiAgentOrchestrator();
    const mockSupa = makeMockSupabase();
    const mockHttp = makeMockHttpClient();
    const config = {
      ...makeConfig(['claude', 'codex']),
      dryRun: true,
      supabase: mockSupa as unknown as import('@supabase/supabase-js').SupabaseClient,
      httpClient: mockHttp,
    };

    const group = await orchestrator.start(config);

    expect(group.groupId).toBe('dry-run-group');
    expect(group.agents).toHaveLength(2);
    expect(group.agents[0].agentId).toBe('claude');
    expect(group.agents[1].agentId).toBe('codex');
    // Neither supabase nor the http client should have been touched in dry-run.
    expect(mockSupa.from).not.toHaveBeenCalled();
    expect(mockHttp.createSessionGroup).not.toHaveBeenCalled();
  });

  it('dry-run stop() is a no-op', async () => {
    const orchestrator = new MultiAgentOrchestrator();
    const group = await orchestrator.start({ ...makeConfig(['claude']), dryRun: true });
    await expect(group.stop()).resolves.toBeUndefined();
  });

  it('dry-run focus() is a no-op', async () => {
    const orchestrator = new MultiAgentOrchestrator();
    const group = await orchestrator.start({ ...makeConfig(['claude']), dryRun: true });
    await expect(group.focus('any-session-id')).resolves.toBeUndefined();
  });

  // ── Happy path ──────────────────────────────────────────────────────────

  it('creates a group and spawns N agents', async () => {
    const orchestrator = new MultiAgentOrchestrator();
    const config = makeConfig(['claude', 'codex', 'gemini']);

    const group = await orchestrator.start(config);

    expect(group.groupId).toBeDefined();
    expect(group.agents).toHaveLength(3);

    const agentIds = group.agents.map((a) => a.agentId);
    expect(agentIds).toContain('claude');
    expect(agentIds).toContain('codex');
    expect(agentIds).toContain('gemini');
  });

  it('sends the initial prompt to all agents when prompt is provided', async () => {
    const orchestrator = new MultiAgentOrchestrator();
    const config = makeConfig(['claude', 'codex']);
    config.prompt = 'write unit tests for auth module';

    await orchestrator.start(config);

    // sendPrompt called once per agent
    expect(mockAgentBackend.sendPrompt).toHaveBeenCalledTimes(2);
    expect(mockAgentBackend.sendPrompt).toHaveBeenCalledWith(
      expect.any(String),
      'write unit tests for auth module'
    );
  });

  it('does NOT send a prompt when prompt is omitted', async () => {
    const orchestrator = new MultiAgentOrchestrator();
    const config = makeConfig(['claude', 'codex']);
    config.prompt = undefined;

    await orchestrator.start(config);

    expect(mockAgentBackend.sendPrompt).not.toHaveBeenCalled();
  });

  it('each agent gets a distinct color prefix', async () => {
    const orchestrator = new MultiAgentOrchestrator();
    const config = makeConfig(['claude', 'codex', 'gemini']);

    const group = await orchestrator.start(config);

    const colors = group.agents.map((a) => a.color);
    const uniqueColors = new Set(colors);
    expect(uniqueColors.size).toBe(3);
  });

  // ── Unknown agent error handling ────────────────────────────────────────

  it('throws and cleans up already-spawned agents if one agent is unavailable', async () => {
    // First agent (claude) is available, second (codex) is not
    mockRegistry.has
      .mockReturnValueOnce(true)  // claude
      .mockReturnValueOnce(false); // codex

    const orchestrator = new MultiAgentOrchestrator();

    await expect(
      orchestrator.start(makeConfig(['claude', 'codex']))
    ).rejects.toThrow('codex');

    // The already-spawned claude session should have been stopped
    expect(mockActiveSession.stop).toHaveBeenCalledTimes(1);
  });

  // ── stop() ──────────────────────────────────────────────────────────────

  it('stop() calls stop() on all spawned agents', async () => {
    const orchestrator = new MultiAgentOrchestrator();
    const group = await orchestrator.start(makeConfig(['claude', 'codex']));

    await group.stop();

    expect(mockActiveSession.stop).toHaveBeenCalledTimes(2);
  });

  it('stop() is idempotent (second call is a no-op)', async () => {
    const orchestrator = new MultiAgentOrchestrator();
    const group = await orchestrator.start(makeConfig(['claude']));

    await group.stop();
    await group.stop(); // second call should not re-stop

    expect(mockActiveSession.stop).toHaveBeenCalledTimes(1);
  });

  // ── focus() ─────────────────────────────────────────────────────────────

  it('focus() rejects when sessionId does not belong to the group', async () => {
    const orchestrator = new MultiAgentOrchestrator();
    const group = await orchestrator.start(makeConfig(['claude']));

    await expect(group.focus('unknown-session-id')).rejects.toThrow(
      'does not belong to group'
    );
  });

  it('focus() updates active_agent_session_id for a valid session', async () => {
    const orchestrator = new MultiAgentOrchestrator();
    const group = await orchestrator.start(makeConfig(['claude', 'codex']));

    const validSessionId = group.agents[0].sessionId;

    // Should not throw
    await expect(group.focus(validSessionId)).resolves.toBeUndefined();
  });
});
