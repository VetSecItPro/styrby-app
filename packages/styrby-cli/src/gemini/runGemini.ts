/**
 * Gemini CLI Entry Point — orchestrator for `runGemini`.
 *
 * This file owns: session bootstrap, the main turn loop, and final cleanup.
 * Cohesive concerns are extracted to sibling modules (see imports below).
 * Public API is unchanged: `export async function runGemini(...)`.
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { logger } from '@/ui/logger';
import { type Credentials } from '@/persistence';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { projectPath } from '@/projectPath';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import type { ApiSessionClient } from '@/api/apiSession';

import type { AgentBackend } from '@/agent';
import { GeminiPermissionHandler } from '@/gemini/utils/permissionHandler';
import { GeminiReasoningProcessor } from '@/gemini/utils/reasoningProcessor';
import { GeminiDiffProcessor } from '@/gemini/utils/diffProcessor';
import type { GeminiMode } from '@/gemini/types';
import type { PermissionMode } from '@/api/types';
import { ConversationHistory } from '@/gemini/utils/conversationHistory';

import { promptContainsChangeTitle } from '@/gemini/utils/promptBuilder';
import { attachGeminiMessageHandler } from '@/gemini/messageHandler';
import { bootstrapGeminiSession } from '@/gemini/bootstrap';
import { setupGeminiInkUI } from '@/gemini/inkSetup';
import { sendTurnPrompt } from '@/gemini/sendTurnPrompt';
import { buildUserMessageRouter } from '@/gemini/userMessageRouter';
import { finalizeGeminiTurn } from '@/gemini/turnFinalize';
import { buildKillSessionHandler, finalCleanupGemini } from '@/gemini/lifecycle';
import { prepareTurnBackend } from '@/gemini/turnPrep';
import { createDisplayedModelTracker } from '@/gemini/displayedModelTracker';
import { createGeminiTurnState } from '@/gemini/turnState';
import { buildAbortHandler } from '@/gemini/abortHandler';

// Re-export extracted helpers so existing callers (and any future ones) can
// import them via the canonical `@/gemini/runGemini` path used pre-refactor.
export { decodeEmailFromIdToken } from '@/gemini/utils/idTokenEmail';
export { formatGeminiError, classifyPromptError } from '@/gemini/utils/errorFormatter';
export { resolvePermissionMode, resolveModel } from '@/gemini/utils/modeResolver';
export { buildFinalTurnMessage } from '@/gemini/utils/finalMessageBuilder';
export { buildFirstMessagePrompt, promptContainsChangeTitle } from '@/gemini/utils/promptBuilder';
export { attachGeminiMessageHandler } from '@/gemini/messageHandler';

/**
 * Main entry point for the gemini command with ink UI.
 */
export async function runGemini(opts: {
  credentials: Credentials;
  startedBy?: 'daemon' | 'terminal';
}): Promise<void> {
  // Live session reference (may be hot-swapped by offline reconnection).
  let session: ApiSessionClient;
  // Permission handler declared here so it can be updated in onSessionSwap
  // callback (assigned later after Happy server setup).
  let permissionHandler: GeminiPermissionHandler;

  // Session swap synchronization to prevent race conditions during message
  // processing.
  let isProcessingMessage = false;
  let pendingSessionSwap: ApiSessionClient | null = null;

  /** Apply a pending session swap. Called between message processing cycles. */
  const applyPendingSessionSwap = () => {
    if (pendingSessionSwap) {
      logger.debug('[gemini] Applying pending session swap');
      session = pendingSessionSwap;
      if (permissionHandler) {
        permissionHandler.updateSession(pendingSessionSwap);
      }
      pendingSessionSwap = null;
    }
  };

  const { api, cloudToken, currentUserEmail, initialSession, reconnectionHandle } =
    await bootstrapGeminiSession({
      credentials: opts.credentials,
      startedBy: opts.startedBy,
      onSessionSwap: (newSession) => {
        // If processing, queue swap for between-cycles application.
        if (isProcessingMessage) {
          logger.debug('[gemini] Session swap requested during message processing - queueing');
          pendingSessionSwap = newSession;
        } else {
          session = newSession;
          if (permissionHandler) {
            permissionHandler.updateSession(newSession);
          }
        }
      },
    });
  session = initialSession;

  const messageQueue = new MessageQueue2<GeminiMode>((mode) => hashObject({
    permissionMode: mode.permissionMode,
    model: mode.model,
  }));

  // Conversation history for context preservation across model changes
  const conversationHistory = new ConversationHistory({ maxMessages: 20, maxCharacters: 50000 });

  // Track current overrides to apply per message
  let currentPermissionMode: PermissionMode | undefined;
  let currentModel: string | undefined;

  // Track if this is the first message to include system prompt only once
  let isFirstMessage = true;

  session.onUserMessage(buildUserMessageRouter({
    messageQueue,
    messageBuffer,
    conversationHistory,
    updatePermissionMode: (mode) => updatePermissionMode(mode),
    updateDisplayedModel: (model, save) => updateDisplayedModel(model, save),
    getCurrentPermissionMode: () => currentPermissionMode,
    setCurrentPermissionMode: (m) => { currentPermissionMode = m; },
    getCurrentModel: () => currentModel,
    setCurrentModel: (m) => { currentModel = m; },
    getIsFirstMessage: () => isFirstMessage,
    setIsFirstMessage: (v) => { isFirstMessage = v; },
  }));

  // Per-turn mutable state container (accumulator, thinking flag, etc).
  // Created early so keep-alive ticks can read its `thinking()` flag.
  const turnState = createGeminiTurnState();

  session.keepAlive(turnState.thinking(), 'remote');
  const keepAliveInterval = setInterval(() => {
    session.keepAlive(turnState.thinking(), 'remote');
  }, 2000);

  const sendReady = () => {
    session.sendSessionEvent({ type: 'ready' });
    try {
      api.push().sendToAllDevices(
        "It's ready!",
        'Gemini is waiting for your command',
        { sessionId: session.sessionId }
      );
    } catch (pushError) {
      logger.debug('[Gemini] Failed to send ready push', pushError);
    }
  };

  /**
   * Check if we can emit ready event. Returns true when emitted.
   */
  const emitReadyIfIdle = (): boolean => {
    if (shouldExit) return false;
    if (turnState.thinking()) return false;
    if (turnState.isResponseInProgress()) return false;
    if (messageQueue.size() > 0) return false;
    sendReady();
    return true;
  };

  //
  // Abort handling
  //

  let abortController = new AbortController();
  let shouldExit = false;
  let geminiBackend: AgentBackend | null = null;
  let acpSessionId: string | null = null;
  let wasSessionCreated = false;

  // Reasoning + diff processors are created up-front so the abort/kill
  // handlers can reference them. They emit messages via the live session.
  permissionHandler = new GeminiPermissionHandler(session);
  const reasoningProcessor = new GeminiReasoningProcessor((msg) => {
    session.sendAgentMessage('gemini', msg);
  });
  const diffProcessor = new GeminiDiffProcessor((msg) => {
    session.sendAgentMessage('gemini', msg);
  });

  const handleAbort = buildAbortHandler({
    getSession: () => session,
    getBackend: () => geminiBackend,
    getAcpSessionId: () => acpSessionId,
    getAbortController: () => abortController,
    setAbortController: (ac) => { abortController = ac; },
    reasoningProcessor,
    diffProcessor,
    messageQueue,
  });

  const handleKillSession = buildKillSessionHandler({
    getSession: () => session,
    getBackend: () => geminiBackend,
    stopHappyServer: () => happyServer.stop(),
    handleAbort,
  });

  session.rpcHandlerManager.registerHandler('abort', handleAbort);
  registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

  //
  // Initialize Ink UI
  //

  const messageBuffer = new MessageBuffer();

  // Track displayed model (env -> local config -> default). The tracker
  // gets `hasTTY` lazily because Ink isn't set up yet.
  const modelTracker = createDisplayedModelTracker({
    messageBuffer,
    getHasTTY: () => hasTTY,
  });
  const updateDisplayedModel = (model: string | undefined, saveToConfig: boolean = false) =>
    modelTracker.update(model, saveToConfig);

  const { hasTTY, inkInstance } = setupGeminiInkUI({
    messageBuffer,
    getDisplayedModel: () => modelTracker.get(),
    onExit: async () => {
      shouldExit = true;
      await handleAbort();
    },
  });

  //
  // Start Happy MCP server and create Gemini backend
  //

  const happyServer = await startHappyServer(session);
  const bridgeCommand = join(projectPath(), 'bin', 'happy-mcp.mjs');
  const mcpServers = {
    happy: {
      command: bridgeCommand,
      args: ['--url', happyServer.url],
    },
  };

  /** Update permission handler when permission mode changes. */
  const updatePermissionMode = (mode: PermissionMode) => {
    permissionHandler.setPermissionMode(mode);
  };


  /**
   * Set up message handler for Gemini backend.
   * Called when backend is created or recreated.
   */
  function setupGeminiMessageHandler(backend: AgentBackend): void {
    attachGeminiMessageHandler(backend, {
      getSession: () => session,
      messageBuffer,
      reasoningProcessor,
      diffProcessor,
      state: turnState.handlerState,
    });
  }

  // Note: Backend will be created dynamically in the main loop based on
  // model from first message. This allows us to support model changes by
  // recreating the backend.

  let first = true;

  try {
    let currentModeHash: string | null = null;
    let pending: { message: string; mode: GeminiMode; isolate: boolean; hash: string } | null = null;

    while (!shouldExit) {
      let message: { message: string; mode: GeminiMode; isolate: boolean; hash: string } | null = pending;
      pending = null;

      if (!message) {
        logger.debug('[gemini] Main loop: waiting for messages from queue...');
        const waitSignal = abortController.signal;
        const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
        if (!batch) {
          if (waitSignal.aborted && !shouldExit) {
            logger.debug('[gemini] Main loop: wait aborted, continuing...');
            continue;
          }
          logger.debug('[gemini] Main loop: no batch received, breaking...');
          break;
        }
        logger.debug(`[gemini] Main loop: received message from queue (length: ${batch.message.length})`);
        message = batch;
      }

      if (!message) {
        break;
      }

      // Prepare backend + ACP session for this turn (handles mode change + first turn)
      const prep = await prepareTurnBackend(
        {
          mcpServers,
          permissionHandler,
          reasoningProcessor,
          conversationHistory,
          messageBuffer,
          cloudToken,
          currentUserEmail,
          setupGeminiMessageHandler,
          updateDisplayedModel,
          updatePermissionMode,
        },
        {
          message,
          backend: geminiBackend,
          acpSessionId,
          currentModeHash,
          wasSessionCreated,
          isFirstTurn: first,
        },
      );
      geminiBackend = prep.backend;
      acpSessionId = prep.acpSessionId;
      wasSessionCreated = prep.wasSessionCreated;
      currentModeHash = prep.newModeHash;
      first = prep.isFirstTurn;
      const injectHistoryContext = prep.injectHistoryContext;

      // Show only the original user message in UI (not the system-prompt-laced full prompt)
      const userMessageToShow = message.mode?.originalUserMessage || message.message;
      messageBuffer.addMessage(userMessageToShow, 'user');

      // Mark that we're processing a message to synchronize session swaps
      isProcessingMessage = true;

      try {
        turnState.resetForNewPrompt();
        // WHY: Pre-refactor code computed `pendingChangeTitle` here for symmetry
        // with Codex even though it was never read downstream. Preserved as a
        // call to keep behavior parity (and so future code can plumb it through).
        promptContainsChangeTitle(message.message);

        await sendTurnPrompt({
          session,
          backend: geminiBackend,
          acpSessionId,
          baseMessage: message.message,
          injectHistoryContext,
          conversationHistory,
          messageBuffer,
          getDisplayedModel: () => modelTracker.get(),
        });

        if (first) {
          first = false;
        }
      } finally {
        const { sentFinalMessage } = finalizeGeminiTurn({
          session,
          permissionHandler,
          reasoningProcessor,
          diffProcessor,
          conversationHistory,
          accumulatedResponse: turnState.accumulatedResponse(),
        });
        if (sentFinalMessage) {
          turnState.clearAccumulatedAfterFlush();
        }

        turnState.resetAfterTurn();
        session.keepAlive(turnState.thinking(), 'remote');

        emitReadyIfIdle();

        // Message processing complete - safe to apply any pending session swap
        isProcessingMessage = false;
        applyPendingSessionSwap();

        logger.debug(`[gemini] Main loop: turn completed, continuing to next iteration (queue size: ${messageQueue.size()})`);
      }
    }

  } finally {
    await finalCleanupGemini({
      reconnectionHandle,
      session,
      backend: geminiBackend,
      stopHappyServer: () => happyServer.stop(),
      keepAliveInterval,
      hasTTY,
      inkInstance,
      messageBuffer,
    });
  }
}
