/**
 * Gemini Backend Message Handler Factory
 *
 * The big `switch (msg.type)` block that translates `AgentMessage` events
 * coming OUT of the Gemini ACP backend into:
 *   - terminal UI updates (via `messageBuffer`)
 *   - mobile app messages (via `session.sendAgentMessage`)
 *   - reasoning/diff processor calls
 *   - per-turn state mutations (thinking, accumulator, etc.)
 *
 * WHY split out: this switch is ~340 lines on its own, dwarfing every
 * other concern in `runGemini.ts`. It is also a single cohesive
 * responsibility (translate backend events to outbound effects) so it
 * extracts cleanly behind a deps object. The factory pattern preserves
 * shared mutable state via getters/setters — identical behavior to the
 * pre-refactor closure.
 */

import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentBackend, AgentMessage } from '@/agent';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { GeminiReasoningProcessor } from '@/gemini/utils/reasoningProcessor';
import type { GeminiDiffProcessor } from '@/gemini/utils/diffProcessor';

/**
 * Mutable state shared between the message handler and the main loop.
 * The handler reads + writes these via getters/setters so it sees the same
 * latest values as the rest of `runGemini.ts`.
 */
export interface MessageHandlerState {
  getThinking(): boolean;
  setThinking(v: boolean): void;
  getAccumulatedResponse(): string;
  setAccumulatedResponse(v: string): void;
  getIsResponseInProgress(): boolean;
  setIsResponseInProgress(v: boolean): void;
  setCurrentResponseMessageId(v: string | null): void;
  setHadToolCallInTurn(v: boolean): void;
  setChangeTitleCompleted(v: boolean): void;
  getTaskStartedSent(): boolean;
  setTaskStartedSent(v: boolean): void;
}

export interface MessageHandlerDeps {
  /** Live session reference (may have been swapped via reconnect). */
  getSession: () => ApiSessionClient;
  messageBuffer: MessageBuffer;
  reasoningProcessor: GeminiReasoningProcessor;
  diffProcessor: GeminiDiffProcessor;
  state: MessageHandlerState;
}

/**
 * Wire a backend's `onMessage` to the full Gemini event-translation logic.
 *
 * Behavior is byte-for-byte identical to the pre-refactor inline switch
 * in `runGemini.ts` — only the surrounding closure was extracted.
 *
 * @param backend - The newly-created Gemini ACP backend.
 * @param deps - Live references to session + UI + processors + state.
 */
export function attachGeminiMessageHandler(
  backend: AgentBackend,
  deps: MessageHandlerDeps
): void {
  const { getSession, messageBuffer, reasoningProcessor, diffProcessor, state } = deps;

  backend.onMessage((msg: AgentMessage) => {
    const session = getSession();

    switch (msg.type) {
      case 'model-output':
        if (msg.textDelta) {
          if (!state.getIsResponseInProgress()) {
            // Start of new response - create new assistant message.
            // Remove "Thinking..." message if present (will be replaced).
            messageBuffer.removeLastMessage('system');
            messageBuffer.addMessage(msg.textDelta, 'assistant');
            state.setIsResponseInProgress(true);
            logger.debug(`[gemini] Started new response, first chunk length: ${msg.textDelta.length}`);
          } else {
            messageBuffer.updateLastMessage(msg.textDelta, 'assistant');
            logger.debug(`[gemini] Updated response, chunk length: ${msg.textDelta.length}, total accumulated: ${state.getAccumulatedResponse().length + msg.textDelta.length}`);
          }
          state.setAccumulatedResponse(state.getAccumulatedResponse() + msg.textDelta);
        }
        break;

      case 'status': {
        const statusDetail = msg.detail
          ? (typeof msg.detail === 'object' ? JSON.stringify(msg.detail) : String(msg.detail))
          : '';
        logger.debug(`[gemini] Status changed: ${msg.status}${statusDetail ? ` - ${statusDetail}` : ''}`);

        if (msg.status === 'error') {
          logger.debug(`[gemini] ⚠️ Error status received: ${statusDetail || 'Unknown error'}`);
          session.sendAgentMessage('gemini', {
            type: 'turn_aborted',
            id: randomUUID(),
          });
        }

        if (msg.status === 'running') {
          state.setThinking(true);
          session.keepAlive(true, 'remote');

          // Send task_started ONCE per turn (Gemini may oscillate running<->idle).
          if (!state.getTaskStartedSent()) {
            session.sendAgentMessage('gemini', {
              type: 'task_started',
              id: randomUUID(),
            });
            state.setTaskStartedSent(true);
          }

          messageBuffer.addMessage('Thinking...', 'system');
        } else if (msg.status === 'idle' || msg.status === 'stopped') {
          // WHY: We deliberately do NOT toggle `thinking=false` here.
          // Gemini emits multiple idle events per turn (between chunks).
          // Toggling thinking here would cause UI status to flicker between
          // "working" and "online". `thinking` is only cleared in the
          // turn-completion finally block.
          reasoningProcessor.complete();
        } else if (msg.status === 'error') {
          state.setThinking(false);
          session.keepAlive(false, 'remote');
          state.setAccumulatedResponse('');
          state.setIsResponseInProgress(false);
          state.setCurrentResponseMessageId(null);

          let errorMessage = 'Unknown error';
          if (msg.detail) {
            if (typeof msg.detail === 'object') {
              const detailObj = msg.detail as Record<string, unknown>;
              errorMessage = (detailObj.message as string) ||
                             (detailObj.details as string) ||
                             JSON.stringify(detailObj);
            } else {
              errorMessage = String(msg.detail);
            }
          }

          if (errorMessage.includes('Authentication required')) {
            errorMessage = `Authentication required.\n` +
              `For Google Workspace accounts, run: happy gemini project set <project-id>\n` +
              `Or use a different Google account: happy connect gemini\n` +
              `Guide: https://goo.gle/gemini-cli-auth-docs#workspace-gca`;
          }

          messageBuffer.addMessage(`Error: ${errorMessage}`, 'status');
          session.sendAgentMessage('gemini', {
            type: 'message',
            message: `Error: ${errorMessage}`,
          });
        }
        break;
      }

      case 'tool-call': {
        state.setHadToolCallInTurn(true);

        const toolArgs = msg.args ? JSON.stringify(msg.args).substring(0, 100) : '';
        const isInvestigationTool = msg.toolName === 'codebase_investigator' ||
                                    (typeof msg.toolName === 'string' && msg.toolName.includes('investigator'));

        logger.debug(`[gemini] 🔧 Tool call received: ${msg.toolName} (${msg.callId})${isInvestigationTool ? ' [INVESTIGATION]' : ''}`);
        if (isInvestigationTool && msg.args && typeof msg.args === 'object' && 'objective' in msg.args) {
          logger.debug(`[gemini] 🔍 Investigation objective: ${String(msg.args.objective).substring(0, 150)}...`);
        }

        messageBuffer.addMessage(`Executing: ${msg.toolName}${toolArgs ? ` ${toolArgs}${toolArgs.length >= 100 ? '...' : ''}` : ''}`, 'tool');
        session.sendAgentMessage('gemini', {
          type: 'tool-call',
          name: msg.toolName,
          callId: msg.callId,
          input: msg.args,
          id: randomUUID(),
        });
        break;
      }

      case 'tool-result': {
        if (msg.toolName === 'change_title' ||
            msg.callId?.includes('change_title') ||
            msg.toolName === 'happy__change_title') {
          state.setChangeTitleCompleted(true);
          logger.debug('[gemini] change_title completed');
        }

        const isError = msg.result && typeof msg.result === 'object' && 'error' in msg.result;
        const resultText = typeof msg.result === 'string'
          ? msg.result.substring(0, 200)
          : JSON.stringify(msg.result).substring(0, 200);
        const truncatedResult = resultText + (typeof msg.result === 'string' && msg.result.length > 200 ? '...' : '');

        const resultSize = typeof msg.result === 'string'
          ? msg.result.length
          : JSON.stringify(msg.result).length;

        logger.debug(`[gemini] ${isError ? '❌' : '✅'} Tool result received: ${msg.toolName} (${msg.callId}) - Size: ${resultSize} bytes${isError ? ' [ERROR]' : ''}`);

        if (!isError) {
          diffProcessor.processToolResult(msg.toolName, msg.result, msg.callId);
        }

        if (isError) {
          const errorMsg = (msg.result as any).error || 'Tool call failed';
          logger.debug(`[gemini] ❌ Tool call error: ${errorMsg.substring(0, 300)}`);
          messageBuffer.addMessage(`Error: ${errorMsg}`, 'status');
        } else {
          if (resultSize > 1000) {
            logger.debug(`[gemini] ✅ Large tool result (${resultSize} bytes) - first 200 chars: ${truncatedResult}`);
          }
          messageBuffer.addMessage(`Result: ${truncatedResult}`, 'result');
        }

        session.sendAgentMessage('gemini', {
          type: 'tool-result',
          callId: msg.callId,
          output: msg.result,
          id: randomUUID(),
        });
        break;
      }

      case 'fs-edit':
        messageBuffer.addMessage(`File edit: ${msg.description}`, 'tool');
        diffProcessor.processFsEdit(msg.path || '', msg.description, msg.diff);
        session.sendAgentMessage('gemini', {
          type: 'file-edit',
          description: msg.description,
          diff: msg.diff,
          filePath: msg.path || 'unknown',
          id: randomUUID(),
        });
        break;

      case 'terminal-output':
        messageBuffer.addMessage(msg.data, 'result');
        session.sendAgentMessage('gemini', {
          type: 'terminal-output',
          data: msg.data,
          callId: (msg as any).callId || randomUUID(),
        });
        break;

      case 'permission-request': {
        const payload = (msg as any).payload || {};
        session.sendAgentMessage('gemini', {
          type: 'permission-request',
          permissionId: msg.id,
          toolName: payload.toolName || (msg as any).reason || 'unknown',
          description: (msg as any).reason || payload.toolName || '',
          options: payload,
        });
        break;
      }

      case 'exec-approval-request': {
        const execApprovalMsg = msg as any;
        const callId = execApprovalMsg.call_id || execApprovalMsg.callId || randomUUID();
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { call_id, type, ...inputs } = execApprovalMsg;

        logger.debug(`[gemini] Exec approval request received: ${callId}`);
        messageBuffer.addMessage(`Exec approval requested: ${callId}`, 'tool');

        session.sendAgentMessage('gemini', {
          type: 'tool-call',
          name: 'GeminiBash',
          callId,
          input: inputs,
          id: randomUUID(),
        });
        break;
      }

      case 'patch-apply-begin': {
        const patchBeginMsg = msg as any;
        const patchCallId = patchBeginMsg.call_id || patchBeginMsg.callId || randomUUID();
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { call_id: _pId, type: _pType, auto_approved, changes } = patchBeginMsg;

        const changeCount = changes ? Object.keys(changes).length : 0;
        const filesMsg = changeCount === 1 ? '1 file' : `${changeCount} files`;
        messageBuffer.addMessage(`Modifying ${filesMsg}...`, 'tool');
        logger.debug(`[gemini] Patch apply begin: ${patchCallId}, files: ${changeCount}`);

        session.sendAgentMessage('gemini', {
          type: 'tool-call',
          name: 'GeminiPatch',
          callId: patchCallId,
          input: { auto_approved, changes },
          id: randomUUID(),
        });
        break;
      }

      case 'patch-apply-end': {
        const patchEndMsg = msg as any;
        const patchEndCallId = patchEndMsg.call_id || patchEndMsg.callId || randomUUID();
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { call_id: _peId, type: _peType, stdout, stderr, success } = patchEndMsg;

        if (success) {
          const message = stdout || 'Files modified successfully';
          messageBuffer.addMessage(message.substring(0, 200), 'result');
        } else {
          const errorMsg = stderr || 'Failed to modify files';
          messageBuffer.addMessage(`Error: ${errorMsg.substring(0, 200)}`, 'result');
        }
        logger.debug(`[gemini] Patch apply end: ${patchEndCallId}, success: ${success}`);

        session.sendAgentMessage('gemini', {
          type: 'tool-result',
          callId: patchEndCallId,
          output: { stdout, stderr, success },
          id: randomUUID(),
        });
        break;
      }

      case 'event':
        if (msg.name === 'thinking') {
          const thinkingPayload = msg.payload as { text?: string } | undefined;
          const thinkingText = (thinkingPayload && typeof thinkingPayload === 'object' && 'text' in thinkingPayload)
            ? String(thinkingPayload.text || '')
            : '';
          if (thinkingText) {
            // ReasoningProcessor identifies titled (**Title**) sections and
            // converts them to tool calls.
            reasoningProcessor.processChunk(thinkingText);
            logger.debug(`[gemini] 💭 Thinking chunk received: ${thinkingText.length} chars - Preview: ${thinkingText.substring(0, 100)}...`);

            if (!thinkingText.startsWith('**')) {
              const thinkingPreview = thinkingText.substring(0, 100);
              messageBuffer.updateLastMessage(`[Thinking] ${thinkingPreview}...`, 'system');
            }
            // For titled reasoning, ReasoningProcessor sends tool call but we
            // keep "Thinking..." visible so user sees progress.
          }
          session.sendAgentMessage('gemini', {
            type: 'thinking',
            text: thinkingText,
          });
        }
        break;

      default:
        // Forward token-count and any other unmodelled message types.
        if ((msg as any).type === 'token-count') {
          session.sendAgentMessage('gemini', {
            type: 'token_count',
            ...(msg as any),
            id: randomUUID(),
          });
        }
        break;
    }
  });
}
