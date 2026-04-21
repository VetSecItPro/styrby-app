/**
 * Gemini Per-Turn Prompt Send + Error Handling
 *
 * Wraps the inner try/catch around `sendPromptWithRetry` for a single turn.
 * Responsibilities:
 *   1. Inject conversation history context if model just changed
 *   2. Log + dispatch the prompt with retry semantics
 *   3. On error, format with `formatGeminiError` and surface to UI + mobile
 *
 * WHY split out: this was 50 lines of mixed concerns inside the main loop.
 * Extracting it leaves the orchestrator with a single `await sendTurnPrompt(...)`
 * call plus its own resetForNewPrompt + finalize bookends.
 */

import { logger } from '@/ui/logger';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentBackend } from '@/agent';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { ConversationHistory } from '@/gemini/utils/conversationHistory';

import { sendPromptWithRetry } from '@/gemini/promptRetryLoop';
import { formatGeminiError } from '@/gemini/utils/errorFormatter';

export interface SendTurnPromptArgs {
  session: ApiSessionClient;
  backend: AgentBackend;
  acpSessionId: string;
  /** Original message text from the queue (already includes system prompt + change_title). */
  baseMessage: string;
  /** When true, prepend `conversationHistory.getContextForNewSession()` to the prompt. */
  injectHistoryContext: boolean;
  conversationHistory: ConversationHistory;
  messageBuffer: MessageBuffer;
  /** Used by error formatter for "model not found" messages. */
  getDisplayedModel: () => string | undefined;
}

/**
 * Send the per-turn prompt with retry, surface errors, and return when done.
 *
 * Never throws — caller's `finally` block runs regardless. Errors are
 * formatted into UI + mobile messages internally.
 */
export async function sendTurnPrompt(args: SendTurnPromptArgs): Promise<void> {
  const {
    session, backend, acpSessionId, baseMessage,
    injectHistoryContext, conversationHistory, messageBuffer, getDisplayedModel,
  } = args;

  // Inject conversation history context if model was just changed.
  // WHY: don't clear history afterward — keep accumulating for future model changes.
  let promptToSend = baseMessage;
  if (injectHistoryContext && conversationHistory.hasHistory()) {
    const historyContext = conversationHistory.getContextForNewSession();
    promptToSend = historyContext + promptToSend;
    logger.debug(`[gemini] Injected conversation history context (${historyContext.length} chars)`);
  }

  logger.debug(`[gemini] Sending prompt to Gemini (length: ${promptToSend.length}): ${promptToSend.substring(0, 100)}...`);
  logger.debug(`[gemini] Full prompt: ${promptToSend}`);

  try {
    await sendPromptWithRetry({
      backend,
      acpSessionId,
      prompt: promptToSend,
      onQuotaError: ({ quotaResetSuffix }) => {
        const quotaMsg = `Gemini quota exceeded.${quotaResetSuffix} Try using a different model (gemini-2.5-flash-lite) or wait for quota reset.`;
        messageBuffer.addMessage(quotaMsg, 'status');
        session.sendAgentMessage('gemini', { type: 'message', message: quotaMsg });
      },
      onRetryAttempt: ({ attempt, max }) => {
        messageBuffer.addMessage(`Gemini returned empty response, retrying (${attempt}/${max})...`, 'status');
      },
    });
  } catch (error) {
    logger.debug('[gemini] Error in gemini session:', error);
    const formatted = formatGeminiError(error, { displayedModel: getDisplayedModel() });

    if (formatted.kind === 'abort') {
      messageBuffer.addMessage(formatted.message, 'status');
      session.sendSessionEvent({ type: 'message', message: formatted.message });
    } else {
      messageBuffer.addMessage(formatted.message, 'status');
      session.sendAgentMessage('gemini', {
        type: 'message',
        message: formatted.message,
      });
    }
  }
}
