/**
 * Session-update dispatcher for the ACP backend.
 *
 * WHY: The ACP `sessionUpdate` RPC is fired for every chunk, tool call,
 * thought, plan, and thinking event the agent emits. AcpBackend itself only
 * needs to know "given this notification, route it to the right per-type
 * handler and let me know if any state escapes back". Pulling the dispatch
 * out of the class keeps `AcpBackend` under the orchestrator LOC budget and
 * makes the routing trivially testable.
 */

import type { SessionNotification } from '@agentclientprotocol/sdk';
import { logger } from '@/ui/logger';
import {
  type SessionUpdate,
  type HandlerContext,
  handleAgentMessageChunk,
  handleAgentThoughtChunk,
  handleToolCallUpdate,
  handleToolCall,
  handleLegacyMessageChunk,
  handlePlanUpdate,
  handleThinkingUpdate,
  handleGeminiUsageMetadata,
} from './sessionUpdateHandlers';
import type { ExtendedSessionNotification } from './acpTypes';

/** Update-type strings the dispatcher knows how to handle as primary cases. */
const HANDLED_TYPES = [
  'agent_message_chunk',
  'tool_call_update',
  'agent_thought_chunk',
  'tool_call',
] as const;

/**
 * Result returned to the caller after dispatch.
 *
 * Currently only `tool_call_update` produces escaping state (the running
 * tool-call counter), so we surface that explicitly so the AcpBackend
 * instance can keep its mirror in sync.
 */
export interface DispatchResult {
  /** New value for `toolCallCountSincePrompt`, if the handler changed it. */
  toolCallCountSincePrompt?: number;
}

/**
 * Route a single ACP `sessionUpdate` notification to its per-type handler.
 *
 * @param params - The raw SDK notification.
 * @param ctx    - Handler context bound to the AcpBackend instance.
 * @returns Any state the caller needs to mirror back onto its instance.
 */
export function dispatchSessionUpdate(
  params: SessionNotification,
  ctx: HandlerContext
): DispatchResult {
  const notification = params as ExtendedSessionNotification;
  const update = notification.update;

  if (!update) {
    logger.debug('[AcpBackend] Received session update without update field:', params);
    return {};
  }

  const sessionUpdateType = update.sessionUpdate;

  // WHY: agent_message_chunk fires hundreds of times per response — logging
  // each chunk floods the debug log and makes post-mortems unreadable.
  if (sessionUpdateType !== 'agent_message_chunk') {
    logger.debug(
      `[AcpBackend] Received session update: ${sessionUpdateType}`,
      JSON.stringify(
        {
          sessionUpdate: sessionUpdateType,
          toolCallId: update.toolCallId,
          status: update.status,
          kind: update.kind,
          hasContent: !!update.content,
          hasLocations: !!update.locations,
        },
        null,
        2
      )
    );
  }

  if (sessionUpdateType === 'agent_message_chunk') {
    handleAgentMessageChunk(update as SessionUpdate, ctx);
    return {};
  }

  if (sessionUpdateType === 'tool_call_update') {
    const result = handleToolCallUpdate(update as SessionUpdate, ctx);
    return { toolCallCountSincePrompt: result.toolCallCountSincePrompt };
  }

  if (sessionUpdateType === 'agent_thought_chunk') {
    handleAgentThoughtChunk(update as SessionUpdate, ctx);
    return {};
  }

  if (sessionUpdateType === 'tool_call') {
    handleToolCall(update as SessionUpdate, ctx);
    return {};
  }

  // WHY: Cast to string first — the ACP SDK discriminated union only models the
  // standard update types. Gemini CLI extends the protocol with non-standard names
  // ('usage_metadata', 'turn_complete', 'response_complete') that TypeScript
  // would flag as impossible comparisons on the narrowed `sessionUpdateType` type.
  const updateTypeStr = sessionUpdateType as string;

  // WHY: Gemini CLI emits usage metadata in dedicated session update types
  // AND sometimes as a top-level `usageMetadata` field on any update type.
  // We check both paths so we never miss a usage event regardless of CLI version.
  if (
    updateTypeStr === 'usage_metadata' ||
    updateTypeStr === 'turn_complete' ||
    updateTypeStr === 'response_complete'
  ) {
    handleGeminiUsageMetadata(update as SessionUpdate, ctx);
    return {};
  }

  // Legacy / auxiliary update types — these handlers are no-ops if the
  // corresponding fields aren't present, so calling all three is safe.
  handleLegacyMessageChunk(update as SessionUpdate, ctx);
  handlePlanUpdate(update as SessionUpdate, ctx);
  handleThinkingUpdate(update as SessionUpdate, ctx);

  // Always probe for usageMetadata on any update type — Gemini may embed it
  // alongside other update types (e.g., 'agent_message_chunk').
  handleGeminiUsageMetadata(update as SessionUpdate, ctx);

  if (
    updateTypeStr &&
    !(HANDLED_TYPES as readonly string[]).includes(updateTypeStr) &&
    !update.messageChunk &&
    !update.plan &&
    !update.thinking
  ) {
    logger.debug(
      `[AcpBackend] Unhandled session update type: ${updateTypeStr}`,
      JSON.stringify(update, null, 2)
    );
  }

  return {};
}
