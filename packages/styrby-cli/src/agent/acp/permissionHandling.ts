/**
 * Permission-request handling for the ACP backend.
 *
 * WHY: The ACP `requestPermission` RPC is fired by the agent every time it
 * wants to invoke a tool (read file, run shell, edit file, etc.). The logic
 * to (a) figure out the real tool name, (b) round-trip a decision through
 * the user's permission handler, and (c) emit lifecycle events for the UI
 * is non-trivial — pulling it out of `AcpBackend.startSession` keeps that
 * method readable and lets us unit-test the permission flow in isolation.
 */

import { randomUUID } from 'node:crypto';
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import { logger } from '@/ui/logger';
import type { AgentMessage } from '../core';
import type { TransportHandler, ToolNameContext } from '../transport';
import type {
  AcpPermissionHandler,
  ExtendedRequestPermissionRequest,
} from './acpTypes';

/**
 * State + collaborators required by {@link createPermissionHandler}.
 *
 * The factory is pure with respect to this object — it never mutates the
 * input — so callers can pass a stable bag of getters/setters bound to the
 * AcpBackend instance.
 */
export interface PermissionHandlerDeps {
  /** Transport handler used to resolve fuzzy tool names. */
  transport: TransportHandler;
  /** Optional user-supplied permission handler (mobile dialog, CLI prompt, …). */
  permissionHandler?: AcpPermissionHandler;
  /** Read the "did the most recent prompt include a change_title instruction" flag. */
  getRecentPromptHadChangeTitle: () => boolean;
  /** Read the running tool-call counter for context tracking. */
  getToolCallCountSincePrompt: () => number;
  /** Increment the tool-call counter (called once per permission request). */
  incrementToolCallCount: () => void;
  /** Emit an AgentMessage to all listeners. */
  emit: (msg: AgentMessage) => void;
}

/**
 * Build the ACP `requestPermission` callback bound to an AcpBackend instance.
 *
 * @param deps - State + collaborators; see {@link PermissionHandlerDeps}.
 * @returns A function matching the SDK's `Client.requestPermission` signature.
 */
export function createPermissionHandler(
  deps: PermissionHandlerDeps
): (params: RequestPermissionRequest) => Promise<RequestPermissionResponse> {
  return async (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
    const extendedParams = params as ExtendedRequestPermissionRequest;
    const toolCall = extendedParams.toolCall;
    let toolName =
      toolCall?.kind || toolCall?.toolName || extendedParams.kind || 'Unknown tool';

    // WHY: Use toolCallId as the SINGLE source of truth for the permission ID.
    // Mobile app sends back this exact ID when the user taps approve/deny;
    // diverging IDs here means we can never correlate the response.
    const toolCallId = toolCall?.id || randomUUID();
    const permissionId = toolCallId;

    // Extract input/arguments from the various shapes agents use BEFORE we
    // attempt to refine the tool name (some transports use input to detect it).
    let input: Record<string, unknown> = {};
    if (toolCall) {
      input = toolCall.input || toolCall.arguments || toolCall.content || {};
    } else {
      input = extendedParams.input || extendedParams.arguments || extendedParams.content || {};
    }

    // If the SDK gave us a generic name like "other" or "Unknown tool", let
    // the transport try to recover the real one from input + context.
    const ctx: ToolNameContext = {
      recentPromptHadChangeTitle: deps.getRecentPromptHadChangeTitle(),
      toolCallCountSincePrompt: deps.getToolCallCountSincePrompt(),
    };
    const originalName =
      toolCall?.kind || toolCall?.toolName || extendedParams.kind || 'Unknown tool';
    toolName = deps.transport.determineToolName?.(toolName, toolCallId, input, ctx) ?? toolName;

    if (toolName !== originalName) {
      logger.debug(
        `[AcpBackend] Detected tool name: ${toolName} from toolCallId: ${toolCallId}`
      );
    }

    deps.incrementToolCallCount();

    const options = extendedParams.options || [];

    logger.debug(
      `[AcpBackend] Permission request: tool=${toolName}, toolCallId=${toolCallId}, input=`,
      JSON.stringify(input)
    );
    logger.debug(
      `[AcpBackend] Permission request params structure:`,
      JSON.stringify(
        {
          hasToolCall: !!toolCall,
          toolCallKind: toolCall?.kind,
          toolCallId: toolCall?.id,
          paramsKind: extendedParams.kind,
          paramsKeys: Object.keys(params),
        },
        null,
        2
      )
    );

    // Always emit so UI / mobile can display the pending request.
    deps.emit({
      type: 'permission-request',
      id: permissionId,
      reason: toolName,
      payload: {
        ...params,
        permissionId,
        toolCallId,
        toolName,
        input,
        options: options.map((opt) => ({
          id: opt.optionId,
          name: opt.name,
          kind: opt.kind,
        })),
      },
    });

    if (deps.permissionHandler) {
      try {
        const result = await deps.permissionHandler.handleToolCall(toolCallId, toolName, input);
        const optionId = mapDecisionToOptionId(result.decision, options);

        // WHY: Emit tool-result with permissionId so the UI's pending-permission
        // timer can be cleared. The follow-up `tool_call_update` carries a
        // different ID and would not close the dialog on its own.
        const approved =
          result.decision === 'approved' || result.decision === 'approved_for_session';
        deps.emit({
          type: 'tool-result',
          toolName,
          result: {
            status: approved ? 'approved' : 'denied',
            decision: result.decision,
          },
          callId: permissionId,
        });

        return { outcome: { outcome: 'selected', optionId } };
      } catch (error) {
        logger.debug('[AcpBackend] Error in permission handler:', error);
        // Fail closed: if the user-supplied handler throws, deny rather than
        // accidentally approving a destructive tool call.
        return { outcome: { outcome: 'selected', optionId: 'cancel' } };
      }
    }

    // No handler configured → auto-approve once. We deliberately prefer
    // 'proceed_once' over 'proceed_always' so an unattended CLI never grants
    // session-scoped approval implicitly.
    const proceedOnceOption = options.find(
      (opt) =>
        opt.optionId === 'proceed_once' ||
        (typeof opt.name === 'string' && opt.name.toLowerCase().includes('once'))
    );
    const defaultOptionId =
      proceedOnceOption?.optionId ||
      (options.length > 0 && options[0].optionId ? options[0].optionId : 'proceed_once');
    return { outcome: { outcome: 'selected', optionId: defaultOptionId } };
  };
}

/**
 * Map a {@link AcpPermissionHandler} decision to an ACP `optionId` chosen
 * from the request's option list.
 *
 * Pure helper — exported for unit testing.
 *
 * @param decision - The decision returned by the user-supplied permission handler.
 * @param options  - The options array from the original permission request.
 * @returns The selected `optionId` string. Defaults to `'cancel'` for safety.
 */
export function mapDecisionToOptionId(
  decision: 'approved' | 'approved_for_session' | 'denied' | 'abort',
  options: Array<{ optionId?: string; name?: string; kind?: string }>
): string {
  if (decision === 'approved' || decision === 'approved_for_session') {
    const proceedOnceOption = options.find(
      (opt) => opt.optionId === 'proceed_once' || opt.name?.toLowerCase().includes('once')
    );
    const proceedAlwaysOption = options.find(
      (opt) => opt.optionId === 'proceed_always' || opt.name?.toLowerCase().includes('always')
    );

    if (decision === 'approved_for_session' && proceedAlwaysOption) {
      return proceedAlwaysOption.optionId || 'proceed_always';
    }
    if (proceedOnceOption) {
      return proceedOnceOption.optionId || 'proceed_once';
    }
    if (options.length > 0) {
      return options[0].optionId || 'proceed_once';
    }
    return 'proceed_once';
  }

  // denied or abort → look for a cancel option, else literal 'cancel'.
  const cancelOption = options.find(
    (opt) => opt.optionId === 'cancel' || opt.name?.toLowerCase().includes('cancel')
  );
  return cancelOption?.optionId || 'cancel';
}
