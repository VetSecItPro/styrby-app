/**
 * Gemini Session Lifecycle Helpers
 *
 * Two helpers that used to be inline closures inside `runGemini`:
 *   - `buildKillSessionHandler` — the RPC handler for "kill session" that
 *     archives the session, stops servers, disposes the backend, and exits.
 *   - `finalCleanupGemini`     — the outer-finally cleanup block that
 *     cancels offline reconnection, closes the session, and tears down Ink.
 *
 * WHY split out: each is ~30 lines of pure-effect orchestration with no
 * loop-private state, so both lift cleanly.
 */

import { logger } from '@/ui/logger';
import { stopCaffeinate } from '@/utils/caffeinate';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentBackend } from '@/agent';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { render } from 'ink';
import { teardownGeminiInkUI } from '@/gemini/inkSetup';

export interface KillSessionDeps {
  /** Live session reference. */
  getSession: () => ApiSessionClient | undefined;
  /** Live backend reference (may be null before first message). */
  getBackend: () => AgentBackend | null;
  /** Stop the bundled Happy MCP server. */
  stopHappyServer: () => void;
  /** Run the abort sequence first (cancel current task etc). */
  handleAbort: () => Promise<void>;
}

/**
 * Build the RPC handler invoked when the mobile app requests "kill session".
 *
 * Behavior is identical to the pre-refactor inline handler in `runGemini`.
 * On any unexpected throw it exits with code 1; on success exits with 0.
 */
export function buildKillSessionHandler(deps: KillSessionDeps): () => Promise<void> {
  const { getSession, getBackend, stopHappyServer, handleAbort } = deps;
  return async function handleKillSession(): Promise<void> {
    logger.debug('[Gemini] Kill session requested - terminating process');
    await handleAbort();
    logger.debug('[Gemini] Abort completed, proceeding with termination');

    try {
      const session = getSession();
      if (session) {
        session.updateMetadata((currentMetadata) => ({
          ...currentMetadata,
          lifecycleState: 'archived',
          lifecycleStateSince: Date.now(),
          archivedBy: 'cli',
          archiveReason: 'User terminated',
        }));

        session.sendSessionDeath();
        await session.flush();
        await session.close();
      }

      stopCaffeinate();
      stopHappyServer();

      const backend = getBackend();
      if (backend) {
        await backend.dispose();
      }

      logger.debug('[Gemini] Session termination complete, exiting');
      process.exit(0);
    } catch (error) {
      logger.debug('[Gemini] Error during session termination:', error);
      process.exit(1);
    }
  };
}

export interface FinalCleanupArgs {
  reconnectionHandle: { cancel: () => void } | undefined;
  session: ApiSessionClient;
  backend: AgentBackend | null;
  stopHappyServer: () => void;
  keepAliveInterval: ReturnType<typeof setInterval>;
  hasTTY: boolean;
  inkInstance: ReturnType<typeof render> | null;
  messageBuffer: MessageBuffer;
}

/**
 * Run the full outer-finally cleanup sequence for `runGemini`.
 *
 * Best-effort: any error during one step is logged and the next step still
 * runs (matches the pre-refactor try/catch granularity).
 */
export async function finalCleanupGemini(args: FinalCleanupArgs): Promise<void> {
  const {
    reconnectionHandle,
    session,
    backend,
    stopHappyServer,
    keepAliveInterval,
    hasTTY,
    inkInstance,
    messageBuffer,
  } = args;
  logger.debug('[gemini]: Final cleanup start');

  if (reconnectionHandle) {
    logger.debug('[gemini]: Cancelling offline reconnection');
    reconnectionHandle.cancel();
  }

  try {
    session.sendSessionDeath();
    await session.flush();
    await session.close();
  } catch (e) {
    logger.debug('[gemini]: Error while closing session', e);
  }

  if (backend) {
    await backend.dispose();
  }

  stopHappyServer();

  clearInterval(keepAliveInterval);
  teardownGeminiInkUI({ hasTTY, inkInstance, messageBuffer });

  logger.debug('[gemini]: Final cleanup completed');
}
