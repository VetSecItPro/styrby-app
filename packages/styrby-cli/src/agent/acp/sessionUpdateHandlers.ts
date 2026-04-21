/**
 * Session Update Handlers for ACP Backend
 *
 * This module contains handlers for different types of ACP session updates.
 * Each handler is responsible for processing a specific update type and
 * emitting appropriate AgentMessages.
 *
 * Extracted from AcpBackend to improve maintainability and testability.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentMessage } from '../core';
import type { TransportHandler } from '../transport';
import { logger } from '@/ui/logger';
import type { CostReport } from '@styrby/shared/cost';

/**
 * Default timeout for idle detection after message chunks (ms)
 * Used when transport handler doesn't provide getIdleTimeout()
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 500;

/**
 * Default timeout for tool calls if transport doesn't specify (ms)
 */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 120_000;

/**
 * Extended session update structure with all possible fields
 */
export interface SessionUpdate {
  sessionUpdate?: string;
  toolCallId?: string;
  status?: string;
  kind?: string | unknown;
  content?: {
    text?: string;
    error?: string | { message?: string };
    [key: string]: unknown;
  } | string | unknown;
  locations?: unknown[];
  messageChunk?: {
    textDelta?: string;
  };
  plan?: unknown;
  thinking?: unknown;
  [key: string]: unknown;
}

/**
 * Context for session update handlers
 */
export interface HandlerContext {
  /** Transport handler for agent-specific behavior */
  transport: TransportHandler;
  /** Set of active tool call IDs */
  activeToolCalls: Set<string>;
  /** Map of tool call ID to start time */
  toolCallStartTimes: Map<string, number>;
  /** Map of tool call ID to timeout handle */
  toolCallTimeouts: Map<string, NodeJS.Timeout>;
  /** Map of tool call ID to tool name */
  toolCallIdToNameMap: Map<string, string>;
  /** Current idle timeout handle */
  idleTimeout: NodeJS.Timeout | null;
  /** Tool call counter since last prompt */
  toolCallCountSincePrompt: number;
  /** Emit function to send agent messages */
  emit: (msg: AgentMessage) => void;
  /** Emit idle status helper */
  emitIdleStatus: () => void;
  /** Clear idle timeout helper */
  clearIdleTimeout: () => void;
  /** Set idle timeout helper */
  setIdleTimeout: (callback: () => void, ms: number) => void;
}

/**
 * Result of handling a session update
 */
export interface HandlerResult {
  /** Whether the update was handled */
  handled: boolean;
  /** Updated tool call counter */
  toolCallCountSincePrompt?: number;
}

/**
 * Parse args from update content (can be array or object)
 */
export function parseArgsFromContent(content: unknown): Record<string, unknown> {
  if (Array.isArray(content)) {
    return { items: content };
  }
  if (content && typeof content === 'object' && content !== null) {
    return content as Record<string, unknown>;
  }
  return {};
}

/**
 * Extract error detail from update content
 */
export function extractErrorDetail(content: unknown): string | undefined {
  if (!content) return undefined;

  if (typeof content === 'string') {
    return content;
  }

  if (typeof content === 'object' && content !== null && !Array.isArray(content)) {
    const obj = content as Record<string, unknown>;

    if (obj.error) {
      const error = obj.error;
      if (typeof error === 'string') return error;
      if (error && typeof error === 'object' && 'message' in error) {
        const errObj = error as { message?: unknown };
        if (typeof errObj.message === 'string') return errObj.message;
      }
      return JSON.stringify(error);
    }

    if (typeof obj.message === 'string') return obj.message;

    const status = typeof obj.status === 'string' ? obj.status : undefined;
    const reason = typeof obj.reason === 'string' ? obj.reason : undefined;
    return status || reason || JSON.stringify(obj).substring(0, 500);
  }

  return undefined;
}

/**
 * Format duration for logging
 */
export function formatDuration(startTime: number | undefined): string {
  if (!startTime) return 'unknown';
  const duration = Date.now() - startTime;
  return `${(duration / 1000).toFixed(2)}s`;
}

/**
 * Format duration in minutes for logging
 */
export function formatDurationMinutes(startTime: number | undefined): string {
  if (!startTime) return 'unknown';
  const duration = Date.now() - startTime;
  return (duration / 1000 / 60).toFixed(2);
}

/**
 * Handle agent_message_chunk update (text output from model)
 */
export function handleAgentMessageChunk(
  update: SessionUpdate,
  ctx: HandlerContext
): HandlerResult {
  const content = update.content;

  if (!content || typeof content !== 'object' || !('text' in content)) {
    return { handled: false };
  }

  const text = (content as { text?: string }).text;
  if (typeof text !== 'string') {
    return { handled: false };
  }

  // Filter out "thinking" messages (start with **...**)
  const isThinking = /^\*\*[^*]+\*\*\n/.test(text);

  if (isThinking) {
    ctx.emit({
      type: 'event',
      name: 'thinking',
      payload: { text },
    });
  } else {
    logger.debug(`[AcpBackend] Received message chunk (length: ${text.length}): ${text.substring(0, 50)}...`);
    ctx.emit({
      type: 'model-output',
      textDelta: text,
    });

    // Reset idle timeout - more chunks are coming
    ctx.clearIdleTimeout();

    // Set timeout to emit 'idle' after a short delay when no more chunks arrive
    const idleTimeoutMs = ctx.transport.getIdleTimeout?.() ?? DEFAULT_IDLE_TIMEOUT_MS;
    ctx.setIdleTimeout(() => {
      if (ctx.activeToolCalls.size === 0) {
        logger.debug('[AcpBackend] No more chunks received, emitting idle status');
        ctx.emitIdleStatus();
      } else {
        logger.debug(`[AcpBackend] Delaying idle status - ${ctx.activeToolCalls.size} active tool calls`);
      }
    }, idleTimeoutMs);
  }

  return { handled: true };
}

/**
 * Handle agent_thought_chunk update (Gemini's thinking/reasoning)
 */
export function handleAgentThoughtChunk(
  update: SessionUpdate,
  ctx: HandlerContext
): HandlerResult {
  const content = update.content;

  if (!content || typeof content !== 'object' || !('text' in content)) {
    return { handled: false };
  }

  const text = (content as { text?: string }).text;
  if (typeof text !== 'string') {
    return { handled: false };
  }

  // Log thinking chunks when tool calls are active
  if (ctx.activeToolCalls.size > 0) {
    const activeToolCallsList = Array.from(ctx.activeToolCalls);
    logger.debug(`[AcpBackend] 💭 Thinking chunk received (${text.length} chars) during active tool calls: ${activeToolCallsList.join(', ')}`);
  }

  ctx.emit({
    type: 'event',
    name: 'thinking',
    payload: { text },
  });

  return { handled: true };
}

/**
 * Start tracking a new tool call
 */
export function startToolCall(
  toolCallId: string,
  toolKind: string | unknown,
  update: SessionUpdate,
  ctx: HandlerContext,
  source: 'tool_call' | 'tool_call_update'
): void {
  const startTime = Date.now();
  const toolKindStr = typeof toolKind === 'string' ? toolKind : undefined;
  const isInvestigation = ctx.transport.isInvestigationTool?.(toolCallId, toolKindStr) ?? false;

  // Extract real tool name from toolCallId
  const extractedName = ctx.transport.extractToolNameFromId?.(toolCallId);
  const realToolName = extractedName ?? (toolKindStr || 'unknown');

  // Store mapping for permission requests
  ctx.toolCallIdToNameMap.set(toolCallId, realToolName);

  ctx.activeToolCalls.add(toolCallId);
  ctx.toolCallStartTimes.set(toolCallId, startTime);

  logger.debug(`[AcpBackend] ⏱️ Set startTime for ${toolCallId} at ${new Date(startTime).toISOString()} (from ${source})`);
  logger.debug(`[AcpBackend] 🔧 Tool call START: ${toolCallId} (${toolKind} -> ${realToolName})${isInvestigation ? ' [INVESTIGATION TOOL]' : ''}`);

  if (isInvestigation) {
    logger.debug(`[AcpBackend] 🔍 Investigation tool detected - extended timeout (10min) will be used`);
  }

  // Set timeout for tool call completion
  const timeoutMs = ctx.transport.getToolCallTimeout?.(toolCallId, toolKindStr) ?? DEFAULT_TOOL_CALL_TIMEOUT_MS;

  if (!ctx.toolCallTimeouts.has(toolCallId)) {
    const timeout = setTimeout(() => {
      const duration = formatDuration(ctx.toolCallStartTimes.get(toolCallId));
      logger.debug(`[AcpBackend] ⏱️ Tool call TIMEOUT (from ${source}): ${toolCallId} (${toolKind}) after ${(timeoutMs / 1000).toFixed(0)}s - Duration: ${duration}, removing from active set`);

      ctx.activeToolCalls.delete(toolCallId);
      ctx.toolCallStartTimes.delete(toolCallId);
      ctx.toolCallTimeouts.delete(toolCallId);

      if (ctx.activeToolCalls.size === 0) {
        logger.debug('[AcpBackend] No more active tool calls after timeout, emitting idle status');
        ctx.emitIdleStatus();
      }
    }, timeoutMs);

    ctx.toolCallTimeouts.set(toolCallId, timeout);
    logger.debug(`[AcpBackend] ⏱️ Set timeout for ${toolCallId}: ${(timeoutMs / 1000).toFixed(0)}s${isInvestigation ? ' (investigation tool)' : ''}`);
  } else {
    logger.debug(`[AcpBackend] Timeout already set for ${toolCallId}, skipping`);
  }

  // Clear idle timeout - tool call is starting
  ctx.clearIdleTimeout();

  // Emit running status
  ctx.emit({ type: 'status', status: 'running' });

  // Parse args and emit tool-call event
  const args = parseArgsFromContent(update.content);

  // Extract locations if present
  if (update.locations && Array.isArray(update.locations)) {
    args.locations = update.locations;
  }

  // Log investigation tool objective
  if (isInvestigation && args.objective) {
    logger.debug(`[AcpBackend] 🔍 Investigation tool objective: ${String(args.objective).substring(0, 100)}...`);
  }

  ctx.emit({
    type: 'tool-call',
    toolName: toolKindStr || 'unknown',
    args,
    callId: toolCallId,
  });
}

/**
 * Complete a tool call successfully
 */
export function completeToolCall(
  toolCallId: string,
  toolKind: string | unknown,
  content: unknown,
  ctx: HandlerContext
): void {
  const startTime = ctx.toolCallStartTimes.get(toolCallId);
  const duration = formatDuration(startTime);
  const toolKindStr = typeof toolKind === 'string' ? toolKind : 'unknown';

  ctx.activeToolCalls.delete(toolCallId);
  ctx.toolCallStartTimes.delete(toolCallId);

  const timeout = ctx.toolCallTimeouts.get(toolCallId);
  if (timeout) {
    clearTimeout(timeout);
    ctx.toolCallTimeouts.delete(toolCallId);
  }

  logger.debug(`[AcpBackend] ✅ Tool call COMPLETED: ${toolCallId} (${toolKindStr}) - Duration: ${duration}. Active tool calls: ${ctx.activeToolCalls.size}`);

  ctx.emit({
    type: 'tool-result',
    toolName: toolKindStr,
    result: content,
    callId: toolCallId,
  });

  // If no more active tool calls, emit idle
  if (ctx.activeToolCalls.size === 0) {
    ctx.clearIdleTimeout();
    logger.debug('[AcpBackend] All tool calls completed, emitting idle status');
    ctx.emitIdleStatus();
  }
}

/**
 * Fail a tool call
 */
export function failToolCall(
  toolCallId: string,
  status: 'failed' | 'cancelled',
  toolKind: string | unknown,
  content: unknown,
  ctx: HandlerContext
): void {
  const startTime = ctx.toolCallStartTimes.get(toolCallId);
  const duration = startTime ? Date.now() - startTime : null;
  const toolKindStr = typeof toolKind === 'string' ? toolKind : 'unknown';
  const isInvestigation = ctx.transport.isInvestigationTool?.(toolCallId, toolKindStr) ?? false;
  const hadTimeout = ctx.toolCallTimeouts.has(toolCallId);

  // Log detailed timing for investigation tools BEFORE cleanup
  if (isInvestigation) {
    const durationStr = formatDuration(startTime);
    const durationMinutes = formatDurationMinutes(startTime);
    logger.debug(`[AcpBackend] 🔍 Investigation tool ${status.toUpperCase()} after ${durationMinutes} minutes (${durationStr})`);

    // Check for 3-minute timeout pattern (Gemini CLI internal timeout)
    if (duration) {
      const threeMinutes = 3 * 60 * 1000;
      const tolerance = 5000;
      if (Math.abs(duration - threeMinutes) < tolerance) {
        logger.debug(`[AcpBackend] 🔍 ⚠️ Investigation tool failed at ~3 minutes - likely Gemini CLI timeout, not our timeout`);
      }
    }

    logger.debug(`[AcpBackend] 🔍 Investigation tool FAILED - full content:`, JSON.stringify(content, null, 2));
    logger.debug(`[AcpBackend] 🔍 Investigation tool timeout status BEFORE cleanup: ${hadTimeout ? 'timeout was set' : 'no timeout was set'}`);
    logger.debug(`[AcpBackend] 🔍 Investigation tool startTime status BEFORE cleanup: ${startTime ? `set at ${new Date(startTime).toISOString()}` : 'not set'}`);
  }

  // Cleanup
  ctx.activeToolCalls.delete(toolCallId);
  ctx.toolCallStartTimes.delete(toolCallId);

  const timeout = ctx.toolCallTimeouts.get(toolCallId);
  if (timeout) {
    clearTimeout(timeout);
    ctx.toolCallTimeouts.delete(toolCallId);
    logger.debug(`[AcpBackend] Cleared timeout for ${toolCallId} (tool call ${status})`);
  } else {
    logger.debug(`[AcpBackend] No timeout found for ${toolCallId} (tool call ${status}) - timeout may not have been set`);
  }

  const durationStr = formatDuration(startTime);
  logger.debug(`[AcpBackend] ❌ Tool call ${status.toUpperCase()}: ${toolCallId} (${toolKindStr}) - Duration: ${durationStr}. Active tool calls: ${ctx.activeToolCalls.size}`);

  // Extract error detail
  const errorDetail = extractErrorDetail(content);
  if (errorDetail) {
    logger.debug(`[AcpBackend] ❌ Tool call error details: ${errorDetail.substring(0, 500)}`);
  } else {
    logger.debug(`[AcpBackend] ❌ Tool call ${status} but no error details in content`);
  }

  // Emit tool-result with error
  ctx.emit({
    type: 'tool-result',
    toolName: toolKindStr,
    result: errorDetail
      ? { error: errorDetail, status }
      : { error: `Tool call ${status}`, status },
    callId: toolCallId,
  });

  // If no more active tool calls, emit idle
  if (ctx.activeToolCalls.size === 0) {
    ctx.clearIdleTimeout();
    logger.debug('[AcpBackend] All tool calls completed/failed, emitting idle status');
    ctx.emitIdleStatus();
  }
}

/**
 * Handle tool_call_update session update
 */
export function handleToolCallUpdate(
  update: SessionUpdate,
  ctx: HandlerContext
): HandlerResult {
  const status = update.status;
  const toolCallId = update.toolCallId;

  if (!toolCallId) {
    logger.debug('[AcpBackend] Tool call update without toolCallId:', update);
    return { handled: false };
  }

  const toolKind = update.kind || 'unknown';
  let toolCallCountSincePrompt = ctx.toolCallCountSincePrompt;

  if (status === 'in_progress' || status === 'pending') {
    if (!ctx.activeToolCalls.has(toolCallId)) {
      toolCallCountSincePrompt++;
      startToolCall(toolCallId, toolKind, update, ctx, 'tool_call_update');
    } else {
      logger.debug(`[AcpBackend] Tool call ${toolCallId} already tracked, status: ${status}`);
    }
  } else if (status === 'completed') {
    completeToolCall(toolCallId, toolKind, update.content, ctx);
  } else if (status === 'failed' || status === 'cancelled') {
    failToolCall(toolCallId, status, toolKind, update.content, ctx);
  }

  return { handled: true, toolCallCountSincePrompt };
}

/**
 * Handle tool_call session update (direct tool call)
 */
export function handleToolCall(
  update: SessionUpdate,
  ctx: HandlerContext
): HandlerResult {
  const toolCallId = update.toolCallId;
  const status = update.status;

  logger.debug(`[AcpBackend] Received tool_call: toolCallId=${toolCallId}, status=${status}, kind=${update.kind}`);

  // tool_call can come without explicit status, assume 'in_progress' if missing
  const isInProgress = !status || status === 'in_progress' || status === 'pending';

  if (!toolCallId || !isInProgress) {
    logger.debug(`[AcpBackend] Tool call ${toolCallId} not in progress (status: ${status}), skipping`);
    return { handled: false };
  }

  if (ctx.activeToolCalls.has(toolCallId)) {
    logger.debug(`[AcpBackend] Tool call ${toolCallId} already in active set, skipping`);
    return { handled: true };
  }

  startToolCall(toolCallId, update.kind, update, ctx, 'tool_call');
  return { handled: true };
}

/**
 * Handle legacy messageChunk format
 */
export function handleLegacyMessageChunk(
  update: SessionUpdate,
  ctx: HandlerContext
): HandlerResult {
  if (!update.messageChunk) {
    return { handled: false };
  }

  const chunk = update.messageChunk;
  if (chunk.textDelta) {
    ctx.emit({
      type: 'model-output',
      textDelta: chunk.textDelta,
    });
    return { handled: true };
  }

  return { handled: false };
}

/**
 * Handle plan update
 */
export function handlePlanUpdate(
  update: SessionUpdate,
  ctx: HandlerContext
): HandlerResult {
  if (!update.plan) {
    return { handled: false };
  }

  ctx.emit({
    type: 'event',
    name: 'plan',
    payload: update.plan,
  });

  return { handled: true };
}

/**
 * Handle explicit thinking field
 */
export function handleThinkingUpdate(
  update: SessionUpdate,
  ctx: HandlerContext
): HandlerResult {
  if (!update.thinking) {
    return { handled: false };
  }

  ctx.emit({
    type: 'event',
    name: 'thinking',
    payload: update.thinking,
  });

  return { handled: true };
}

// ============================================================================
// Gemini ACP usage wiring (Gap 3 — Phase 1.6.1)
// ============================================================================

/**
 * Gemini usage metadata as emitted via ACP session updates.
 *
 * WHY: Gemini CLI appends usage metadata to the ACP `turn_complete` /
 * `response_complete` session update (or as a standalone
 * `usage_metadata` update). The field names follow the Gemini REST API
 * convention (`promptTokenCount`, `candidatesTokenCount`, etc.) rather
 * than the generic `inputTokens`/`outputTokens` used by other agents.
 *
 * See: https://ai.google.dev/gemini-api/docs/tokens
 */
interface GeminiUsageMetadata {
  /** Tokens in the prompt (input). */
  promptTokenCount?: number;
  /** Tokens in all candidates combined (output). */
  candidatesTokenCount?: number;
  /** Sum of prompt + candidates (informational). */
  totalTokenCount?: number;
  /** Cached input tokens (Gemini implicit context caching). */
  cachedContentTokenCount?: number;
  /** Model name as reported by Gemini (e.g. "gemini-2.5-pro"). */
  model?: string;
}

/**
 * Determine the Gemini billing model from local config and environment.
 *
 * Priority:
 *  1. `config.apiKey` set → `'api-key'` (user-supplied Gemini API key, variable cost).
 *  2. OAuth credentials exist at `~/.gemini/oauth_creds.json` or auth.json → `'subscription'`
 *     (Gemini Code Assist Workspace flat-rate plan).
 *  3. No credentials → `'free'` (Gemini free tier, informational only).
 *
 * WHY: The billing model drives how the cost dashboard interprets `costUsd`. For
 * subscription and free tiers, costUsd must be 0 (schema refinement 1). Detecting
 * OAuth at the handler level avoids importing the full Gemini config module into
 * the ACP layer (which would create a circular dependency with the factory).
 *
 * @param apiKey - The API key resolved by the Gemini factory, or undefined.
 * @returns The billing model for this session.
 */
export function detectGeminiBillingModel(apiKey: string | undefined): 'api-key' | 'subscription' | 'free' {
  if (apiKey) {
    return 'api-key';
  }

  // WHY: Check for OAuth credential files. The Gemini CLI stores OAuth tokens in
  // ~/.gemini/oauth_creds.json (primary) or ~/.gemini/auth.json (legacy). If any
  // of these exist and has an `access_token`, the user is authenticated via OAuth
  // (Google Workspace / Code Assist subscription plan), so cost is 0.
  const oauthPaths = [
    path.join(os.homedir(), '.gemini', 'oauth_creds.json'),
    path.join(os.homedir(), '.gemini', 'auth.json'),
    path.join(os.homedir(), '.config', 'gemini', 'auth.json'),
  ];

  for (const p of oauthPaths) {
    try {
      const raw = fs.readFileSync(p, 'utf-8');
      const cfg = JSON.parse(raw) as Record<string, unknown>;
      if (cfg.access_token || cfg.token) {
        return 'subscription';
      }
    } catch {
      // File absent or unreadable — continue probing.
    }
  }

  return 'free';
}

/**
 * Shape of the HandlerContext extension used by the Gemini usage handler.
 *
 * WHY: The base HandlerContext does not carry the Gemini session ID or resolved
 * API key because those are only needed by the usage handler. We extend the
 * context via an intersection type so existing handlers are unaffected.
 */
export interface GeminiUsageContext extends HandlerContext {
  /** Styrby session ID (UUID). Required for CostReport.sessionId. */
  styrbySssionId?: string;
  /** Resolved Gemini API key (from factory config). Undefined = OAuth or free tier. */
  geminiApiKey?: string;
  /** Resolved Gemini model name (e.g. "gemini-2.5-pro"). */
  geminiModel?: string;
}

/**
 * Handle an ACP session update that carries Gemini usage metadata.
 *
 * Gemini CLI emits a `usageMetadata` field (or standalone `usage_metadata`
 * session update) after a turn completes. This handler extracts token counts,
 * determines the billing model, and emits a `CostReport` via the backend event
 * channel — identical to the pattern used by PR-C factories (Goose, Amp, etc.).
 *
 * Supported update shapes:
 *   - `{ sessionUpdate: 'usage_metadata', usageMetadata: { ... } }`
 *   - `{ sessionUpdate: 'turn_complete', usageMetadata: { ... } }`
 *   - `{ sessionUpdate: 'response_complete', usageMetadata: { ... } }`
 *   - Any update with a top-level `usageMetadata` object (Gemini ACP extension)
 *
 * @param update - Raw ACP session update object.
 * @param ctx    - Handler context (may carry optional Gemini-specific fields).
 * @returns HandlerResult with `handled: true` when usage was extracted.
 */
export function handleGeminiUsageMetadata(
  update: SessionUpdate,
  ctx: HandlerContext
): HandlerResult {
  // WHY: Gemini injects `usageMetadata` at the top-level update object. The
  // SessionUpdate interface allows `[key: string]: unknown` so we can read it
  // without unsafe casting of the entire object.
  const raw = (update as Record<string, unknown>).usageMetadata;

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { handled: false };
  }

  const meta = raw as GeminiUsageMetadata;
  const inputTokens = meta.promptTokenCount ?? 0;
  const outputTokens = meta.candidatesTokenCount ?? 0;
  const cacheReadTokens = meta.cachedContentTokenCount ?? 0;

  // Nothing useful in this payload if all counts are zero.
  if (inputTokens === 0 && outputTokens === 0) {
    return { handled: false };
  }

  const geminiCtx = ctx as GeminiUsageContext;
  const billingModel = detectGeminiBillingModel(geminiCtx.geminiApiKey);

  // WHY: For subscription and free tiers, costUsd must be 0 (CostReport schema
  // refinement 1). For api-key billing we set 0 here as well because Gemini
  // does not report a costUsd in ACP — the cost dashboard derives it from token
  // counts × pricing using the litellm pricing table.
  const costUsd = 0;

  const model = meta.model ?? geminiCtx.geminiModel ?? 'gemini-2.5-pro';

  const costReport: CostReport = {
    sessionId: geminiCtx.styrbySssionId ?? '',
    messageId: null,
    agentType: 'gemini',
    model,
    timestamp: new Date().toISOString(),
    source: 'agent-reported',
    billingModel,
    costUsd,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens: 0,
    // WHY: subscriptionUsage is optional and only populated for subscription billing.
    // Gemini Workspace does not surface quota fraction in the ACP response so we
    // set fractionUsed=null and rawSignal=null.
    ...(billingModel === 'subscription'
      ? { subscriptionUsage: { fractionUsed: null, rawSignal: null } }
      : {}),
    rawAgentPayload: meta as unknown as Record<string, unknown>,
  };

  logger.debug(
    `[AcpBackend] Gemini usage extracted: inputTokens=${inputTokens}, ` +
    `outputTokens=${outputTokens}, billingModel=${billingModel}`
  );

  // Emit legacy token-count (keep for existing consumers).
  ctx.emit({
    type: 'token-count',
    inputTokens,
    outputTokens,
    cacheReadTokens,
    estimatedCostUsd: costUsd,
  } as any);

  // Emit unified CostReport.
  ctx.emit({ type: 'cost-report', report: costReport } as any);

  return { handled: true };
}
