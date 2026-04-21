/**
 * Gemini Abort Handler Factory
 *
 * Builds the `handleAbort` function used by both the RPC abort handler and
 * the kill-session sequence. Centralises the abort effects:
 *   - Send `turn_aborted` to mobile
 *   - Reset reasoning + diff processors
 *   - Abort the current AbortController and reset to a fresh one
 *   - Drain the message queue
 *   - Cancel the active ACP session if any
 *
 * WHY split out: this was ~30 lines of pure orchestration that's invoked
 * from two places (RPC handler + kill session). Promoting to a factory
 * keeps the single-responsibility shape clean.
 */

import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentBackend } from '@/agent';
import type { MessageQueue2 } from '@/utils/MessageQueue2';
import type { GeminiReasoningProcessor } from '@/gemini/utils/reasoningProcessor';
import type { GeminiDiffProcessor } from '@/gemini/utils/diffProcessor';
import type { GeminiMode } from '@/gemini/types';

export interface AbortHandlerDeps {
  getSession: () => ApiSessionClient;
  getBackend: () => AgentBackend | null;
  getAcpSessionId: () => string | null;
  getAbortController: () => AbortController;
  setAbortController: (ac: AbortController) => void;
  reasoningProcessor: GeminiReasoningProcessor;
  diffProcessor: GeminiDiffProcessor;
  messageQueue: MessageQueue2<GeminiMode>;
}

/**
 * Build the `handleAbort` async function used by RPC + kill flows.
 *
 * Behavior is identical to the pre-refactor inline `handleAbort`.
 */
export function buildAbortHandler(deps: AbortHandlerDeps): () => Promise<void> {
  const {
    getSession, getBackend, getAcpSessionId,
    getAbortController, setAbortController,
    reasoningProcessor, diffProcessor, messageQueue,
  } = deps;

  return async function handleAbort(): Promise<void> {
    logger.debug('[Gemini] Abort requested - stopping current task');

    // Send turn_aborted to mobile (Codex parity).
    getSession().sendAgentMessage('gemini', {
      type: 'turn_aborted',
      id: randomUUID(),
    });

    reasoningProcessor.abort();
    diffProcessor.reset();

    try {
      getAbortController().abort();
      messageQueue.reset();
      const backend = getBackend();
      const acpId = getAcpSessionId();
      if (backend && acpId) {
        await backend.cancel(acpId);
      }
      logger.debug('[Gemini] Abort completed - session remains active');
    } catch (error) {
      logger.debug('[Gemini] Error during abort:', error);
    } finally {
      setAbortController(new AbortController());
    }
  };
}
