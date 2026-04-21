/**
 * Gemini Inbound User Message Router
 *
 * Builds the `onUserMessage` callback that `runGemini` registers on the
 * session. The callback's job is to:
 *   1. Resolve permission mode (validate + persist)
 *   2. Resolve model (handle keep / change / reset / noop semantics)
 *   3. Inject system prompt + change_title instruction on the FIRST message
 *   4. Push the resulting prompt + GeminiMode onto the message queue
 *   5. Record the original user message into ConversationHistory
 *
 * WHY split out: this was ~80 lines of branching inside `runGemini.ts`
 * that mixed pure decisions (handled by `modeResolver` / `promptBuilder`)
 * with side effects (queue.push, UI banner, debug logs). Extracting the
 * coordinator lets the orchestrator stay focused on lifecycle.
 */

import { logger } from '@/ui/logger';
import type { PermissionMode } from '@/api/types';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { MessageQueue2 } from '@/utils/MessageQueue2';
import type { GeminiMode } from '@/gemini/types';
import type { ConversationHistory } from '@/gemini/utils/conversationHistory';

import { resolvePermissionMode, resolveModel } from '@/gemini/utils/modeResolver';
import { buildFirstMessagePrompt } from '@/gemini/utils/promptBuilder';

/**
 * Mutable state and side-effect callbacks the router needs from the
 * orchestrator. Mirrors the closure variables `runGemini` previously
 * captured directly.
 */
export interface UserMessageRouterDeps {
  messageQueue: MessageQueue2<GeminiMode>;
  messageBuffer: MessageBuffer;
  conversationHistory: ConversationHistory;
  /** Refresh the live permission handler when mode changes. */
  updatePermissionMode: (mode: PermissionMode) => void;
  /** Refresh the displayed model in the UI; pass `saveToConfig=true` for user-initiated changes. */
  updateDisplayedModel: (model: string | undefined, saveToConfig?: boolean) => void;
  /** Read/write current session-wide permission mode override. */
  getCurrentPermissionMode: () => PermissionMode | undefined;
  setCurrentPermissionMode: (mode: PermissionMode | undefined) => void;
  /** Read/write current session-wide model override. */
  getCurrentModel: () => string | undefined;
  setCurrentModel: (model: string | undefined) => void;
  /** Read/write the "have we sent the first message?" flag. */
  getIsFirstMessage: () => boolean;
  setIsFirstMessage: (v: boolean) => void;
}

/**
 * The structural type of an incoming user message we read from. We avoid
 * importing the full `ApiSessionClient` types here so this module stays
 * easy to test with a fixture.
 */
export interface IncomingUserMessage {
  content: { text: string };
  meta?: {
    permissionMode?: string;
    model?: string | null;
    appendSystemPrompt?: string;
  };
}

/**
 * Build the handler function to pass to `session.onUserMessage(...)`.
 *
 * Behavior is identical to the pre-refactor inline handler in `runGemini.ts`.
 */
export function buildUserMessageRouter(deps: UserMessageRouterDeps) {
  const {
    messageQueue,
    messageBuffer,
    conversationHistory,
    updatePermissionMode,
    updateDisplayedModel,
    getCurrentPermissionMode,
    setCurrentPermissionMode,
    getCurrentModel,
    setCurrentModel,
    getIsFirstMessage,
    setIsFirstMessage,
  } = deps;

  return function onUserMessage(message: IncomingUserMessage): void {
    // 1) Permission mode resolution (validate)
    const permResolution = resolvePermissionMode(
      message.meta,
      getCurrentPermissionMode(),
    );
    if (message.meta?.permissionMode && permResolution.invalid) {
      logger.debug(`[Gemini] Invalid permission mode received: ${message.meta.permissionMode}`);
    }
    if (permResolution.didChange && !permResolution.invalid && message.meta?.permissionMode) {
      setCurrentPermissionMode(permResolution.newCurrent);
      updatePermissionMode(permResolution.forMessage);
      logger.debug(`[Gemini] Permission mode updated from user message to: ${permResolution.newCurrent}`);
    } else if (!message.meta?.permissionMode) {
      logger.debug(`[Gemini] User message received with no permission mode override, using current: ${getCurrentPermissionMode() ?? 'default (effective)'}`);
    }
    if (getCurrentPermissionMode() === undefined) {
      // Initialize permission mode on first message ever
      setCurrentPermissionMode('default');
      updatePermissionMode('default');
    }
    const messagePermissionMode = permResolution.forMessage;

    // 2) Model resolution
    const modelAction = resolveModel(message.meta, getCurrentModel());
    let messageModel = getCurrentModel();
    switch (modelAction.kind) {
      case 'reset':
        // WHY: Don't update displayed model — backend picks env/config/default.
        messageModel = undefined;
        setCurrentModel(undefined);
        break;
      case 'change':
        messageModel = modelAction.forMessage;
        setCurrentModel(modelAction.newCurrent);
        // Save to config so it persists, refresh UI, announce change.
        updateDisplayedModel(modelAction.forMessage, true);
        messageBuffer.addMessage(`Model changed to: ${modelAction.forMessage}`, 'system');
        logger.debug(`[Gemini] Model changed from ${modelAction.previous} to ${modelAction.forMessage}`);
        break;
      case 'noop':
      case 'keep':
        // Keep current — nothing to do.
        messageModel = modelAction.forMessage;
        break;
    }

    // 3) Build prompt (system prompt + change_title only on first message)
    const originalUserMessage = message.content.text;
    let fullPrompt = originalUserMessage;
    if (getIsFirstMessage() && message.meta?.appendSystemPrompt) {
      fullPrompt = buildFirstMessagePrompt({
        userMessage: originalUserMessage,
        appendSystemPrompt: message.meta.appendSystemPrompt,
      });
      setIsFirstMessage(false);
    }

    // 4) Push onto queue
    const mode: GeminiMode = {
      permissionMode: messagePermissionMode || 'default',
      model: messageModel,
      originalUserMessage, // store original separately for UI display
    };
    messageQueue.push(fullPrompt, mode);

    // 5) Record into ConversationHistory for context preservation across model changes
    conversationHistory.addUserMessage(originalUserMessage);
  };
}
