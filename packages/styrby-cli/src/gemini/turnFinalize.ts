/**
 * Gemini Turn Finalization
 *
 * Encapsulates the side-effects that run in the main loop's `finally` block
 * after each user turn completes (regardless of success or thrown error):
 *   1. Reset permission/reasoning/diff processors
 *   2. Build + send the per-turn final assistant message to mobile
 *   3. Send `task_complete` event
 *   4. Clear keepalive thinking flag
 *
 * WHY split out: the finally block was 50 lines mixing many independent
 * effects, and `buildFinalTurnMessage` already had its own pure helper —
 * pairing it with this orchestrator keeps the run loop focused.
 */

import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import type { ApiSessionClient } from '@/api/apiSession';
import type { GeminiPermissionHandler } from '@/gemini/utils/permissionHandler';
import type { GeminiReasoningProcessor } from '@/gemini/utils/reasoningProcessor';
import type { GeminiDiffProcessor } from '@/gemini/utils/diffProcessor';
import type { ConversationHistory } from '@/gemini/utils/conversationHistory';
import { buildFinalTurnMessage } from '@/gemini/utils/finalMessageBuilder';

export interface FinalizeTurnArgs {
  session: ApiSessionClient;
  permissionHandler: GeminiPermissionHandler;
  reasoningProcessor: GeminiReasoningProcessor;
  diffProcessor: GeminiDiffProcessor;
  conversationHistory: ConversationHistory;
  /** The text accumulated by the message handler over the turn. */
  accumulatedResponse: string;
}

export interface FinalizeTurnResult {
  /** True when we sent a per-turn message to mobile (caller should clear accumulator). */
  sentFinalMessage: boolean;
}

/**
 * Run all per-turn cleanup + final-message dispatch.
 *
 * Behavior matches the pre-refactor inline finally block exactly. The
 * caller is still responsible for clearing accumulator state vars,
 * resetting per-turn flags (hadToolCallInTurn, etc), `keepAlive`, and
 * `emitReadyIfIdle`. We keep those in the orchestrator since they touch
 * its loop-private state.
 */
export function finalizeGeminiTurn(args: FinalizeTurnArgs): FinalizeTurnResult {
  const {
    session,
    permissionHandler,
    reasoningProcessor,
    diffProcessor,
    conversationHistory,
    accumulatedResponse,
  } = args;

  // Reset per-turn processors
  permissionHandler.reset();
  reasoningProcessor.abort();
  diffProcessor.reset();

  // Send accumulated response to mobile app ONLY when turn is complete.
  // WHY: prevents fragmentation from Gemini's chunked streaming responses.
  const built = buildFinalTurnMessage(accumulatedResponse);
  let sentFinalMessage = false;
  if (built) {
    conversationHistory.addAssistantMessage(built.historyText);
    if (built.options.length > 0) {
      logger.debug(`[gemini] Found ${built.options.length} options in response:`, built.options);
    } else if (built.incompleteOptions) {
      logger.debug('[gemini] Warning: Incomplete options block detected');
    }
    logger.debug(`[gemini] Sending complete message to mobile (length: ${built.payload.message.length}): ${built.payload.message.substring(0, 100)}...`);
    session.sendAgentMessage('gemini', built.payload);
    sentFinalMessage = true;
  }

  // Send task_complete ONCE at end of turn (not on every idle).
  session.sendAgentMessage('gemini', {
    type: 'task_complete',
    id: randomUUID(),
  });

  return { sentFinalMessage };
}
