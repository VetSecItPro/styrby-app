/**
 * Multi-Agent Orchestrator
 *
 * Manages spawning N concurrent agent sessions tied to a single
 * agent_session_group record. Each agent runs in its own AgentBackend +
 * ApiSessionManager instance so a crash in one does not affect others.
 *
 * Responsibilities:
 *   - Create the agent_session_groups row in Supabase
 *   - Spawn one AgentBackend + one ApiSessionManager per requested agent
 *   - Set up a colored terminal output mux (each agent gets a unique prefix)
 *   - Update active_agent_session_id via the focus API when the focused
 *     session is stopped or reassigned
 *   - On SIGINT / SIGTERM: gracefully kill ALL N sessions (process group
 *     pattern — no orphans)
 *   - Expose stop() for programmatic shutdown (used in tests and handler)
 *
 * WHY per-agent isolation:
 *   Sharing a single ApiSessionManager across N agents would mean a single
 *   relayMessageHandler would fan-out to all agents indiscriminately.
 *   Instead, each agent gets its own relay subscription keyed to its own
 *   session_id, so mobile messages route correctly.
 *
 * WHY process group + exit handler for orphan cleanup:
 *   If the CLI process is killed mid-multi (SIGKILL, OOM) the agent processes
 *   become orphans consuming CPU and tokens. We use process.on('exit') to
 *   synchronously send SIGTERM to all tracked PIDs before the Node process
 *   exits. This is best-effort (won't catch SIGKILL) but handles all normal
 *   shutdown paths including Ctrl+C, SIGTERM, and unhandled exceptions.
 *
 * @module agent/multiAgentOrchestrator
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { StyrbyApi } from '@/api/api';
import type { StyrbyApiClient } from '@/api/styrbyApiClient';
import { StyrbyApiError } from '@/api/styrbyApiClient';
import type { AgentId } from '@/agent/core/AgentBackend';
import { ApiSessionManager } from '@/api/apiSession';
import { logger } from '@/ui/logger';

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for spawning a multi-agent group.
 */
export interface MultiAgentConfig {
  /**
   * Authenticated StyrbyApiClient for /api/v1/* calls.
   *
   * H41 Phase 4-step3: every Postgres operation owned by this file (group
   * create, session attach, focus update, audit log) flows through /api/v1
   * via this client. Direct supabase usage in those paths is gone.
   */
  httpClient: StyrbyApiClient;
  /**
   * Authenticated Supabase client.
   *
   * Still required for the downstream ApiSessionManager.startManagedSession
   * call, which Phase 4 deliberately leaves unchanged (its swap is tracked
   * separately). When that swap lands this field can be deleted.
   */
  supabase: SupabaseClient;
  /** Connected StyrbyApi relay instance */
  api: StyrbyApi;
  /** Agent IDs to spawn (e.g. ['claude', 'codex', 'gemini']) */
  agentIds: AgentId[];
  /** Working directory for all agents */
  projectPath: string;
  /** Authenticated user ID */
  userId: string;
  /** Machine ID */
  machineId: string;
  /** Initial prompt to send to all agents after start */
  prompt?: string;
  /** Human-readable group name (defaults to prompt truncated to 60 chars) */
  groupName?: string;
  /**
   * If true, validate configuration but do not actually spawn agents.
   * Used by --dry-run tests to verify arg parsing without side effects.
   */
  dryRun?: boolean;
}

/**
 * A single spawned agent within the group.
 */
export interface SpawnedAgent {
  /** Agent type (e.g. 'claude') */
  agentId: AgentId;
  /** Supabase session ID */
  sessionId: string;
  /** The ApiSessionManager managing this agent's session */
  manager: ApiSessionManager;
  /** Chalk color applied to this agent's terminal prefix */
  color: string;
  /** Stop this individual agent's session */
  stop: () => Promise<void>;
}

/**
 * The running multi-agent group handle returned by start().
 */
export interface MultiAgentGroup {
  /** Supabase group ID */
  groupId: string;
  /** All spawned agents */
  agents: SpawnedAgent[];
  /** Stop all agents and mark the group complete */
  stop: () => Promise<void>;
  /**
   * Focus a specific session in the group.
   * Updates active_agent_session_id in Supabase.
   *
   * @param sessionId - Session to focus
   */
  focus: (sessionId: string) => Promise<void>;
}

// ============================================================================
// Terminal color palette — one per agent slot (cycles if > 6 agents)
// ============================================================================

/**
 * ANSI color codes for agent output prefixes.
 * WHY raw ANSI: avoids chalk import in the orchestrator layer, which keeps
 * this module testable without terminal dependencies.
 */
const AGENT_COLORS = [
  '\x1b[36m', // cyan   — slot 0
  '\x1b[33m', // yellow — slot 1
  '\x1b[35m', // magenta — slot 2
  '\x1b[32m', // green  — slot 3
  '\x1b[34m', // blue   — slot 4
  '\x1b[31m', // red    — slot 5
];
const RESET = '\x1b[0m';

// Maximum agents per group enforced at the orchestrator level.
// WHY: Supabase Realtime has channel limits. 6 concurrent agent sessions
// per group is a reasonable upper bound for Phase 3.1; raise in 3.x.
const MAX_AGENTS_PER_GROUP = 6;

// ============================================================================
// Orphan-process registry
// ============================================================================

/**
 * PIDs of agent child processes started by this orchestrator.
 * Used by the process.on('exit') handler to SIGTERM orphans.
 *
 * WHY module-level set: the exit handler must be registered once and must
 * close over a stable reference. A new Set per orchestrator instance would
 * not be reachable from the exit handler registered at module load time.
 */
const _trackedPids = new Set<number>();

// Register exit handler once at module load.
// WHY synchronous SIGTERM: process.on('exit') callbacks must be synchronous.
// We can only send signals here, not await async cleanup.
process.on('exit', () => {
  for (const pid of _trackedPids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // PID may already be dead — ignore
    }
  }
});

// ============================================================================
// MultiAgentOrchestrator class
// ============================================================================

/**
 * Orchestrates N concurrent agent sessions as a logical group.
 *
 * @example
 * ```typescript
 * const orchestrator = new MultiAgentOrchestrator();
 * const group = await orchestrator.start({
 *   supabase,
 *   api,
 *   agentIds: ['claude', 'codex', 'gemini'],
 *   projectPath: '/my/project',
 *   userId,
 *   machineId,
 *   prompt: 'refactor auth middleware',
 * });
 *
 * // All agents are running and streaming to the terminal
 * // Press Ctrl+C or call group.stop() to kill all
 * await group.stop();
 * ```
 */
export class MultiAgentOrchestrator {
  /**
   * Start a multi-agent group.
   *
   * Steps:
   * 1. Validate agentIds (no duplicates, within MAX_AGENTS_PER_GROUP)
   * 2. If dryRun, return early with a dry-run group (no Supabase/agent writes)
   * 3. Create agent_session_groups row in Supabase
   * 4. For each agent: create AgentBackend + ApiSessionManager, start session
   * 5. Send initial prompt to all agents if provided
   * 6. Set active_agent_session_id to the first running session
   * 7. Return MultiAgentGroup handle
   *
   * @param config - Multi-agent configuration
   * @returns MultiAgentGroup handle for managing the running group
   * @throws {Error} If agentIds are invalid, exceed limit, or session creation fails
   */
  async start(config: MultiAgentConfig): Promise<MultiAgentGroup> {
    const {
      httpClient,
      supabase,
      api,
      agentIds,
      projectPath,
      userId,
      machineId,
      prompt,
      groupName,
      dryRun = false,
    } = config;

    // ── Validate ─────────────────────────────────────────────────────────────
    if (agentIds.length === 0) {
      throw new Error('At least one agent must be specified');
    }
    if (agentIds.length > MAX_AGENTS_PER_GROUP) {
      throw new Error(
        `Maximum ${MAX_AGENTS_PER_GROUP} concurrent agents per group (requested: ${agentIds.length})`
      );
    }
    const uniqueIds = new Set(agentIds);
    if (uniqueIds.size !== agentIds.length) {
      throw new Error('Duplicate agent IDs are not allowed in a single group');
    }

    // ── Dry run ───────────────────────────────────────────────────────────────
    if (dryRun) {
      logger.info('[dry-run] MultiAgentOrchestrator: config validated', {
        agentIds,
        projectPath,
        prompt: prompt?.slice(0, 60),
      });
      return this._buildDryRunGroup(agentIds);
    }

    // ── 1. Derive group name ──────────────────────────────────────────────────
    const resolvedGroupName =
      groupName ||
      (prompt ? `${prompt.slice(0, 60)}${prompt.length > 60 ? '...' : ''}` : 'Multi-agent group');

    // ── 2. Create agent_session_groups row via /api/v1 ───────────────────────
    // WHY server-generated id: POST /api/v1/sessions/groups returns its own
    // group_id. We accept that ID rather than client-minting a UUID — keeps
    // the create call idempotency-key safe and avoids ID-collision risk.
    let groupId: string;
    try {
      const created = await httpClient.createSessionGroup({ name: resolvedGroupName });
      groupId = created.group_id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      throw new Error(`Failed to create session group: ${msg}`);
    }

    logger.info('Session group created', { groupId, agentCount: agentIds.length });

    // Write audit log entry for group creation.
    // WHY non-fatal: audit log failure must not block the agent sessions.
    await httpClient
      .writeAuditEvent({
        action: 'session_group_created',
        resource_type: 'agent_session_group',
        resource_id: groupId,
        metadata: {
          group_id: groupId,
          agent_ids: agentIds,
          project_path: projectPath,
          group_name: resolvedGroupName,
        },
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : 'unknown';
        logger.debug('Failed to write session_group_created audit log', { error: msg });
      });

    // ── 3. Spawn agents ───────────────────────────────────────────────────────
    const { initializeAgents, agentRegistry } = await import('@/agent/index');
    initializeAgents();

    const spawnedAgents: SpawnedAgent[] = [];

    for (let i = 0; i < agentIds.length; i++) {
      const agentId = agentIds[i];
      const color = AGENT_COLORS[i % AGENT_COLORS.length];

      if (!agentRegistry.has(agentId)) {
        // Clean up already-spawned agents before throwing
        for (const spawned of spawnedAgents) {
          await spawned.stop().catch(() => {});
        }
        // WHY catch+ignore: rollback is best-effort; the throw below is the
        // primary signal. A failed delete here just leaves an orphaned group
        // row that gets pruned by background cleanup or the next /multi run.
        await httpClient.deleteSessionGroup(groupId).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : 'unknown';
          logger.debug('Failed to roll back session group', { groupId, error: msg });
        });
        throw new Error(
          `Agent "${agentId}" is not available. Install with: styrby install ${agentId}`
        );
      }

      const agentBackend = agentRegistry.create(agentId, { cwd: projectPath });

      // Track PID for orphan cleanup if the backend exposes it
      const backendAsAny = agentBackend as unknown as { pid?: number };
      if (typeof backendAsAny.pid === 'number') {
        _trackedPids.add(backendAsAny.pid);
      }

      // Tap agent output and prefix with colored agent label
      const prefix = `${color}[${agentId}]${RESET} `;
      agentBackend.onMessage((msg) => {
        if (msg.type === 'model-output') {
          const text = msg.textDelta ?? msg.fullText ?? '';
          if (text) {
            process.stdout.write(`${prefix}${text}`);
          }
        } else if (msg.type === 'status') {
          if (msg.status === 'error' && msg.detail) {
            process.stderr.write(`${prefix}ERROR: ${msg.detail}\n`);
          }
        }
      });

      const manager = new ApiSessionManager();
      const activeSession = await manager.startManagedSession({
        supabase,
        api,
        agent: agentBackend,
        // WHY cast: AgentId includes 'claude-acp' and 'codex-acp' which are
        // internal aliases. ManagedSessionConfig expects SharedAgentType which
        // only covers the 11 user-facing agent names. The 'multi' command's
        // VALID_AGENT_IDS list already restricts to user-facing agents, so
        // the cast is safe at this call site.
        agentType: agentId as import('styrby-shared').AgentType,
        userId,
        machineId,
        projectPath,
      });

      // Link the session to its group via PATCH /api/v1/sessions/[id].
      // WHY non-fatal debug-log: a failed link doesn't break the running
      // session. The mobile UI can still address the session directly; only
      // the multi-agent group view loses one of its members. We surface the
      // error in debug logs for forensics rather than aborting the spawn loop.
      await httpClient
        .updateSession(activeSession.sessionId, { session_group_id: groupId })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : 'unknown';
          logger.debug('Failed to set session_group_id on session', {
            sessionId: activeSession.sessionId,
            error: msg,
          });
        });

      // Send initial prompt to this agent if provided
      if (prompt) {
        try {
          await agentBackend.sendPrompt(activeSession.sessionId, prompt);
        } catch (error) {
          logger.debug('Failed to send initial prompt to agent', {
            agentId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      spawnedAgents.push({
        agentId,
        sessionId: activeSession.sessionId,
        manager,
        color,
        stop: () => activeSession.stop(),
      });

      logger.info(`Agent spawned in group`, {
        agentId,
        sessionId: activeSession.sessionId,
        groupId,
      });
    }

    // ── 4. Set initial focus to first agent ───────────────────────────────────
    if (spawnedAgents.length > 0) {
      await httpClient
        .setSessionGroupFocus(groupId, spawnedAgents[0].sessionId)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : 'unknown';
          logger.debug('Failed to set initial active_agent_session_id', { error: msg });
        });
    }

    // ── 5. Build group handle ─────────────────────────────────────────────────
    let stopped = false;

    const group: MultiAgentGroup = {
      groupId,
      agents: spawnedAgents,

      /**
       * Stop all agents in the group. Idempotent — safe to call multiple times.
       *
       * WHY parallel stop: agent cleanup is independent per-agent. Running them
       * sequentially would add latency proportional to N agents. We fire all
       * stops concurrently and await all, tolerating individual stop failures.
       */
      stop: async () => {
        if (stopped) return;
        stopped = true;

        logger.info('Stopping all agents in group', { groupId, count: spawnedAgents.length });

        await Promise.allSettled(spawnedAgents.map((a) => a.stop()));

        // Clean up tracked PIDs
        for (const a of spawnedAgents) {
          const backendAsAny = a as unknown as { pid?: number };
          if (typeof backendAsAny.pid === 'number') {
            _trackedPids.delete(backendAsAny.pid);
          }
        }

        logger.info('All agents stopped', { groupId });
      },

      /**
       * Focus a specific session (mobile tap handler).
       * Updates active_agent_session_id in the group record.
       *
       * @param sessionId - The session to focus
       * @throws {Error} If sessionId does not belong to this group
       */
      focus: async (sessionId: string) => {
        const belongs = spawnedAgents.some((a) => a.sessionId === sessionId);
        if (!belongs) {
          throw new Error(
            `Session ${sessionId} does not belong to group ${groupId}`
          );
        }

        // WHY throw on focus error: the focus method is the public contract
        // for switching active agents; the caller (e.g. mobile tap handler)
        // needs to know if the change took effect. Unlike the initial-focus
        // call above (which is best-effort), this is user-driven and must
        // surface failure.
        try {
          await httpClient.setSessionGroupFocus(groupId, sessionId);
        } catch (err) {
          const msg =
            err instanceof StyrbyApiError ? err.message : err instanceof Error ? err.message : 'unknown';
          throw new Error(`Failed to update focus: ${msg}`);
        }

        // Write audit log for focus change. Best-effort; the focus operation
        // already succeeded — losing the audit entry is an observability gap,
        // not a correctness one.
        await httpClient
          .writeAuditEvent({
            action: 'session_group_focus_changed',
            resource_type: 'agent_session_group',
            resource_id: groupId,
            metadata: {
              group_id: groupId,
              focused_session_id: sessionId,
            },
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : 'unknown';
            logger.debug('Failed to write session_group_focus_changed audit log', { error: msg });
          });

        logger.info('Group focus updated', { groupId, sessionId });
      },
    };

    return group;
  }

  /**
   * Build a no-op group for --dry-run mode.
   * Returns immediately without touching Supabase or agent processes.
   *
   * @param agentIds - Agent IDs that would have been spawned
   * @returns A MultiAgentGroup where all operations are no-ops
   */
  private _buildDryRunGroup(agentIds: AgentId[]): MultiAgentGroup {
    const dryRunAgents: SpawnedAgent[] = agentIds.map((id, i) => ({
      agentId: id,
      sessionId: `dry-run-${id}-${i}`,
      manager: new ApiSessionManager(),
      color: AGENT_COLORS[i % AGENT_COLORS.length],
      stop: async () => {},
    }));

    return {
      groupId: 'dry-run-group',
      agents: dryRunAgents,
      stop: async () => {},
      focus: async () => {},
    };
  }
}

/**
 * Singleton orchestrator for use by the CLI handler.
 * Tests should instantiate their own MultiAgentOrchestrator to avoid
 * state bleed between test cases.
 */
export const multiAgentOrchestrator = new MultiAgentOrchestrator();
