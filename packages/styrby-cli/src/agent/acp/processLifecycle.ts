/**
 * Process lifecycle helpers for the ACP backend.
 *
 * WHY: Spawning the agent subprocess, wiring stderr/error/exit listeners, and
 * driving the ACP `initialize` + `newSession` RPCs are mechanically distinct
 * concerns from the per-message routing AcpBackend does at runtime. Keeping
 * them out of the main class file makes startSession readable and lets us
 * exercise the spawn/teardown contracts in focused tests.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { buildSafeEnv } from '@/utils/safeEnv';
import {
  ClientSideConnection,
  type InitializeRequest,
  type NewSessionRequest,
} from '@agentclientprotocol/sdk';
import { logger } from '@/ui/logger';
import type { AgentMessage, McpServerConfig } from '../core';
import type { TransportHandler, StderrContext } from '../transport';
import { RETRY_CONFIG, withRetry, withTimeout } from './retryHelper';
import packageJson from '../../../package.json';

/** Options accepted by {@link spawnAgentProcess}. */
export interface SpawnAgentOptions {
  /** Binary or shim used to launch the agent. */
  command: string;
  /** Argument vector passed to the binary. */
  args?: string[];
  /** Working directory for the spawned process. */
  cwd: string;
  /** Caller-supplied environment merged into the safe baseline. */
  env?: Record<string, string>;
}

/**
 * Spawn the ACP agent subprocess with a hardened environment.
 *
 * SECURITY: On Windows we route through `cmd.exe /c` to support `.cmd` shims
 * + PATH resolution. Every argument is passed as its OWN array element so
 * shell metacharacters (`;`, `&`, `|`) inside a value can never inject extra
 * commands. The environment is built via `buildSafeEnv` to prevent secret
 * leakage to the agent.
 *
 * @param options - Spawn configuration; see {@link SpawnAgentOptions}.
 * @returns The spawned `ChildProcess`. Throws if any stdio pipe is missing.
 */
export function spawnAgentProcess(options: SpawnAgentOptions): ChildProcess {
  const args = options.args || [];
  const safeEnv = buildSafeEnv(options.env);

  let proc: ChildProcess;
  if (process.platform === 'win32') {
    proc = spawn('cmd.exe', ['/c', options.command, ...args], {
      cwd: options.cwd,
      env: safeEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } else {
    proc = spawn(options.command, args, {
      cwd: options.cwd,
      env: safeEnv,
      // 'pipe' for all stdio so stdout/stderr never leak to the parent TTY.
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  if (!proc.stdin || !proc.stdout || !proc.stderr) {
    throw new Error('Failed to create stdio pipes');
  }

  return proc;
}

/** Collaborators required by {@link attachProcessListeners}. */
export interface ProcessListenerDeps {
  /** Transport handler — used for stderr classification + custom emits. */
  transport: TransportHandler;
  /** Read the live set of in-flight tool call IDs. */
  getActiveToolCalls: () => Set<string>;
  /** Whether the backend has been disposed (suppresses stop-emit on shutdown). */
  isDisposed: () => boolean;
  /** Emit an AgentMessage to listeners. */
  emit: (msg: AgentMessage) => void;
}

/**
 * Wire stderr / error / exit listeners on a spawned agent process.
 *
 * @param proc - The agent subprocess.
 * @param deps - Collaborators; see {@link ProcessListenerDeps}.
 */
export function attachProcessListeners(proc: ChildProcess, deps: ProcessListenerDeps): void {
  proc.stderr!.on('data', (data: Buffer) => {
    const text = data.toString();
    if (!text.trim()) return;

    // WHY: Some tool kinds count as "investigations" (e.g. read-only file
    // inspection); we change log tagging during them so post-mortems can
    // distinguish noisy debug output from genuine errors.
    const activeToolCalls = deps.getActiveToolCalls();
    const hasActiveInvestigation = deps.transport.isInvestigationTool
      ? Array.from(activeToolCalls).some((id) => deps.transport.isInvestigationTool!(id))
      : false;

    const context: StderrContext = {
      activeToolCalls,
      hasActiveInvestigation,
    };

    if (hasActiveInvestigation) {
      logger.debug(`[AcpBackend] 🔍 Agent stderr (during investigation): ${text.trim()}`);
    } else {
      logger.debug(`[AcpBackend] Agent stderr: ${text.trim()}`);
    }

    if (deps.transport.handleStderr) {
      const result = deps.transport.handleStderr(text, context);
      if (result.message) {
        deps.emit(result.message);
      }
    }
  });

  proc.on('error', (err) => {
    logger.debug(`[AcpBackend] Process error:`, err);
    deps.emit({ type: 'status', status: 'error', detail: err.message });
  });

  proc.on('exit', (code, signal) => {
    if (!deps.isDisposed() && code !== 0 && code !== null) {
      logger.debug(`[AcpBackend] Process exited with code ${code}, signal ${signal}`);
      deps.emit({ type: 'status', status: 'stopped', detail: `Exit code: ${code}` });
    }
  });
}

/**
 * Run the ACP `initialize` RPC with retry + timeout.
 *
 * @param connection - The active ClientSideConnection.
 * @param transport  - Used for the timeout budget + agent name.
 */
export async function initializeAcpConnection(
  connection: ClientSideConnection,
  transport: TransportHandler
): Promise<void> {
  const initRequest: InitializeRequest = {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
    },
    clientInfo: {
      name: 'happy-cli',
      version: packageJson.version,
    },
  };

  const initTimeout = transport.getInitTimeout();
  logger.debug(`[AcpBackend] Initializing connection (timeout: ${initTimeout}ms)...`);

  await withRetry(
    () =>
      withTimeout(
        () => connection.initialize(initRequest),
        initTimeout,
        `Initialize timeout after ${initTimeout}ms - ${transport.agentName} did not respond`
      ),
    {
      operationName: 'Initialize',
      maxAttempts: RETRY_CONFIG.maxAttempts,
      baseDelayMs: RETRY_CONFIG.baseDelayMs,
      maxDelayMs: RETRY_CONFIG.maxDelayMs,
    }
  );
  logger.debug(`[AcpBackend] Initialize completed`);
}

/**
 * Run the ACP `newSession` RPC with retry + timeout.
 *
 * @param connection - The initialized ClientSideConnection.
 * @param transport  - Used for the timeout budget + agent name.
 * @param cwd        - Working directory of the new session.
 * @param mcpServers - Optional map of MCP servers to expose to the agent.
 * @returns The session ID returned by the agent.
 */
export async function createAcpSession(
  connection: ClientSideConnection,
  transport: TransportHandler,
  cwd: string,
  mcpServers?: Record<string, McpServerConfig>
): Promise<string> {
  const initTimeout = transport.getInitTimeout();
  const mcpServerList = mcpServers
    ? Object.entries(mcpServers).map(([name, config]) => ({
        name,
        command: config.command,
        args: config.args || [],
        env: config.env
          ? Object.entries(config.env).map(([envName, envValue]) => ({
              name: envName,
              value: envValue,
            }))
          : [],
      }))
    : [];

  const newSessionRequest: NewSessionRequest = {
    cwd,
    mcpServers: mcpServerList as unknown as NewSessionRequest['mcpServers'],
  };

  logger.debug(`[AcpBackend] Creating new session...`);

  const sessionResponse = await withRetry(
    () =>
      withTimeout(
        () => connection.newSession(newSessionRequest),
        initTimeout,
        `New session timeout after ${initTimeout}ms - ${transport.agentName} did not respond`
      ),
    {
      operationName: 'NewSession',
      maxAttempts: RETRY_CONFIG.maxAttempts,
      baseDelayMs: RETRY_CONFIG.baseDelayMs,
      maxDelayMs: RETRY_CONFIG.maxDelayMs,
    }
  );
  logger.debug(`[AcpBackend] Session created: ${sessionResponse.sessionId}`);
  return sessionResponse.sessionId;
}
