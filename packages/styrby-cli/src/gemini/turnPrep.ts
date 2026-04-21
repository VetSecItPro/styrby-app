/**
 * Gemini Per-Turn Backend / Session Preparation
 *
 * Handles two cases that both run before each turn's `sendPrompt`:
 *   1. **Mode change**: previous message used a different permission mode
 *      or model => dispose backend, recreate with new model, start a fresh
 *      ACP session (preserving conversation history if any).
 *   2. **First message** (no backend yet) => create the backend lazily,
 *      then start the ACP session.
 *
 * WHY split out: this was 90 lines of branching at the top of each loop
 * iteration. Both branches share the same backend-create-then-start-session
 * shape; isolating them into a single helper documents the model-change
 * contract in one place.
 */

import { logger } from '@/ui/logger';
import type { AgentBackend } from '@/agent';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { GeminiPermissionHandler } from '@/gemini/utils/permissionHandler';
import type { GeminiReasoningProcessor } from '@/gemini/utils/reasoningProcessor';
import type { ConversationHistory } from '@/gemini/utils/conversationHistory';
import type { PermissionMode } from '@/api/types';
import type { GeminiMode } from '@/gemini/types';

import { createBackendForMessage } from '@/gemini/backendFactory';

export interface TurnPrepDeps {
  mcpServers: Record<string, { command: string; args: string[] }>;
  permissionHandler: GeminiPermissionHandler;
  reasoningProcessor: GeminiReasoningProcessor;
  conversationHistory: ConversationHistory;
  messageBuffer: MessageBuffer;
  cloudToken?: string;
  currentUserEmail?: string;
  /** Wire the message handler onto the new backend. */
  setupGeminiMessageHandler: (backend: AgentBackend) => void;
  /** Update displayed model in UI (don't save to config). */
  updateDisplayedModel: (model: string | undefined, saveToConfig?: boolean) => void;
  updatePermissionMode: (mode: PermissionMode) => void;
}

export interface TurnPrepInput {
  message: { mode: GeminiMode; hash: string };
  /** Existing backend or null if not created yet. */
  backend: AgentBackend | null;
  /** Existing ACP session id or null. */
  acpSessionId: string | null;
  /** Hash of the current session-wide mode (for change detection). */
  currentModeHash: string | null;
  wasSessionCreated: boolean;
  /** True if this is the first turn of the run. */
  isFirstTurn: boolean;
}

export interface TurnPrepResult {
  backend: AgentBackend;
  acpSessionId: string;
  /** True if we restarted the session due to mode change. */
  modeChanged: boolean;
  /** True if conversation history should be injected into this turn's prompt. */
  injectHistoryContext: boolean;
  /** New session-wide mode hash (== message.hash). */
  newModeHash: string;
  wasSessionCreated: true;
  /** New value of "first turn" flag (false unless we made no changes). */
  isFirstTurn: boolean;
}

/**
 * Prepare the Gemini backend + ACP session for the next turn.
 *
 * Returns the (possibly new) backend, ACP session id, and metadata flags
 * the orchestrator needs (modeChanged, injectHistoryContext, etc).
 */
export async function prepareTurnBackend(
  deps: TurnPrepDeps,
  input: TurnPrepInput,
): Promise<TurnPrepResult> {
  const {
    mcpServers, permissionHandler, reasoningProcessor, conversationHistory,
    messageBuffer, cloudToken, currentUserEmail,
    setupGeminiMessageHandler, updateDisplayedModel, updatePermissionMode,
  } = deps;
  const { message } = input;

  let backend = input.backend;
  let acpSessionId = input.acpSessionId;
  let injectHistoryContext = false;
  let modeChanged = false;
  let isFirstTurn = input.isFirstTurn;
  let wasSessionCreated = input.wasSessionCreated;

  // 1) Mode change branch (Codex-parity): restart Gemini session
  if (input.wasSessionCreated && input.currentModeHash && message.hash !== input.currentModeHash) {
    modeChanged = true;
    logger.debug('[Gemini] Mode changed – restarting Gemini session');
    messageBuffer.addMessage('═'.repeat(40), 'status');

    if (conversationHistory.hasHistory()) {
      messageBuffer.addMessage(
        `Switching model (preserving ${conversationHistory.size()} messages of context)...`,
        'status',
      );
      injectHistoryContext = true;
      logger.debug(`[Gemini] Will inject conversation history: ${conversationHistory.getSummary()}`);
    } else {
      messageBuffer.addMessage('Starting new Gemini session (mode changed)...', 'status');
    }

    permissionHandler.reset();
    reasoningProcessor.abort();

    if (backend) {
      await backend.dispose();
      backend = null;
    }

    const result = createBackendForMessage({
      mcpServers, permissionHandler, cloudToken, currentUserEmail,
      messageModel: message.mode?.model,
    });
    backend = result.backend;
    setupGeminiMessageHandler(backend);

    const actualModel = result.model;
    logger.debug(`[gemini] Model change - messageModel=${message.mode?.model}, actualModel=${actualModel} (from ${result.modelSource})`);
    conversationHistory.setCurrentModel(actualModel);

    logger.debug('[gemini] Starting new ACP session with model:', actualModel);
    const { sessionId } = await backend.startSession();
    acpSessionId = sessionId;
    logger.debug(`[gemini] New ACP session started: ${acpSessionId}`);

    // Update displayed model (don't save - this is backend init).
    logger.debug(`[gemini] Calling updateDisplayedModel with: ${actualModel}`);
    updateDisplayedModel(actualModel, false);
    updatePermissionMode(message.mode.permissionMode);

    wasSessionCreated = true;
    isFirstTurn = false;
  }

  // 2) First-turn branch: create backend lazily
  if (isFirstTurn || !wasSessionCreated) {
    if (!backend) {
      const result = createBackendForMessage({
        mcpServers, permissionHandler, cloudToken, currentUserEmail,
        messageModel: message.mode?.model,
      });
      backend = result.backend;
      setupGeminiMessageHandler(backend);

      const actualModel = result.model;
      logger.debug(`[gemini] Backend created, model will be: ${actualModel} (from ${result.modelSource})`);
      logger.debug(`[gemini] Calling updateDisplayedModel with: ${actualModel}`);
      updateDisplayedModel(actualModel, false);
      conversationHistory.setCurrentModel(actualModel);
    }

    if (!acpSessionId) {
      logger.debug('[gemini] Starting ACP session...');
      updatePermissionMode(message.mode.permissionMode);
      const { sessionId } = await backend.startSession();
      acpSessionId = sessionId;
      logger.debug(`[gemini] ACP session started: ${acpSessionId}`);
      wasSessionCreated = true;
    }
  }

  if (!acpSessionId || !backend) {
    throw new Error('ACP session not started');
  }

  return {
    backend,
    acpSessionId,
    modeChanged,
    injectHistoryContext,
    newModeHash: message.hash,
    wasSessionCreated: true,
    isFirstTurn,
  };
}
