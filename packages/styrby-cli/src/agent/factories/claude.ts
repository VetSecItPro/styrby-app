/**
 * Claude Cost Factory — JSONL-path CostReport emitter
 *
 * This module provides helpers to parse Claude Code JSONL output lines and
 * emit unified {@link CostReport} events. It covers the structured JSONL path
 * only — the brittle regex in `cost-extractor.ts#parseClaudeOutput` is NOT
 * touched here (that is PR-D gap-fix work).
 *
 * Auth-mode detection:
 *   - Reads `~/.claude/auth.json` for a `subscriptionType` field.
 *   - If found and matches Max/Pro → `billingModel: 'subscription'`, `costUsd: 0`.
 *   - If the file is missing or the field is absent → default to `'api-key'`.
 *   - Detection failure is logged at DEBUG level, never a hard error.
 *
 * Usage:
 * ```ts
 * // Detect billing model once at session start
 * const billingModel = detectClaudeBillingModel();
 *
 * // For each JSONL line from Claude Code stdout:
 * const report = parseClaudeJsonlLine(line, sessionId, billingModel);
 * if (report) backend.emit({ type: 'cost-report', report });
 * ```
 *
 * @module factories/claude
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { logger } from '@/ui/logger';
import type { CostReport, BillingModel } from '@styrby/shared/cost';

// ============================================================================
// Auth Mode Detection
// ============================================================================

/**
 * Subscription type strings written by Claude Code to `~/.claude/auth.json`.
 *
 * WHY: Claude Max and Claude Pro are flat-rate plans — costUsd must be 0
 * for subscription sessions. We detect the plan from the auth file so the
 * cost dashboard shows subscription users $0 instead of a phantom API cost.
 */
const CLAUDE_SUBSCRIPTION_TYPES = new Set(['max', 'pro', 'claude_max', 'claude_pro']);

/**
 * Detect the Claude Code billing model by inspecting `~/.claude/auth.json`.
 *
 * WHY: Claude Code writes auth state (including subscription tier) to a
 * local JSON file. Checking it at session start lets us classify cost events
 * without requiring an extra API call.
 *
 * Falls back to `'api-key'` if the file is missing, unreadable, or does not
 * contain a recognisable `subscriptionType` field. This is intentional:
 * missing detection is Phase 1.6.1 PR-D's problem, not PR-C's.
 *
 * @returns `'subscription'` for Claude Max/Pro users; `'api-key'` otherwise.
 */
export function detectClaudeBillingModel(): BillingModel {
  const authJsonPath = path.join(os.homedir(), '.claude', 'auth.json');
  try {
    if (!fs.existsSync(authJsonPath)) {
      logger.debug('[ClaudeFactory] ~/.claude/auth.json not found — defaulting to api-key billing');
      return 'api-key';
    }

    const raw = fs.readFileSync(authJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const subType = (parsed.subscriptionType as string | undefined)?.toLowerCase() ?? '';

    if (CLAUDE_SUBSCRIPTION_TYPES.has(subType)) {
      logger.debug(`[ClaudeFactory] Detected subscription billing model: ${subType}`);
      return 'subscription';
    }

    logger.debug(`[ClaudeFactory] subscriptionType="${subType}" not recognised — defaulting to api-key`);
    return 'api-key';
  } catch (err) {
    logger.debug('[ClaudeFactory] Could not read ~/.claude/auth.json — defaulting to api-key billing', err);
    return 'api-key';
  }
}

// ============================================================================
// JSONL Parser
// ============================================================================

/**
 * Parsed shape of a Claude Code JSONL assistant message.
 *
 * WHY: Claude Code emits JSONL lines where assistant messages include a
 * `message.usage` block with token counts. Typing this explicitly lets TypeScript
 * catch format regressions at compile time.
 */
interface ClaudeJsonlAssistantMessage {
  type: 'assistant';
  timestamp?: string;
  message?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

/**
 * Parse a single Claude Code JSONL output line and return a {@link CostReport}.
 *
 * This is the structured JSONL path — it handles `{ type: "assistant", message.usage }`.
 * The brittle regex (`parseClaudeOutput` in `cost-extractor.ts`) is left untouched.
 *
 * WHY: The structured JSONL path is the preferred extraction method because it
 * directly reads the typed `usage` block rather than regex-scanning raw text.
 * This parser is called per line by the JSONL file-watcher in cost-extractor.ts.
 *
 * @param line - A single JSONL line from Claude Code's streaming output
 * @param sessionId - The Supabase session UUID to attach to the report
 * @param billingModel - Pre-detected billing model for this Claude session
 * @returns A {@link CostReport} if the line contains token usage, or `null` otherwise
 *
 * @example
 * const billing = detectClaudeBillingModel();
 * const report = parseClaudeJsonlLine(line, 'uuid-...', billing);
 * if (report) emitter.emit({ type: 'cost-report', report });
 */
export function parseClaudeJsonlLine(
  line: string,
  sessionId: string,
  billingModel: BillingModel
): CostReport | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) return null;

  let data: ClaudeJsonlAssistantMessage;
  try {
    data = JSON.parse(trimmed) as ClaudeJsonlAssistantMessage;
  } catch {
    return null;
  }

  // Only assistant messages carry usage data
  if (data.type !== 'assistant' || !data.message?.usage) return null;

  const usage = data.message.usage;
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
  const model = data.message.model ?? 'unknown';

  // WHY: Subscription billing (Claude Max/Pro) has zero marginal cost per request.
  // We still store the token counts for usage monitoring but must not report a USD cost.
  const costUsd = billingModel === 'subscription' ? 0 : 0; // USD cost unknown from JSONL alone — set to 0; cost-reporter may enrich via pricing table

  const rawPayload: Record<string, unknown> = {
    type: data.type,
    model,
    usage: usage as unknown as Record<string, unknown>,
  };

  const report: CostReport = {
    sessionId,
    messageId: null,
    agentType: 'claude',
    model,
    timestamp: data.timestamp ?? new Date().toISOString(),
    source: 'agent-reported',
    billingModel,
    costUsd,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    ...(billingModel === 'subscription'
      ? {
          subscriptionUsage: {
            fractionUsed: null, // Claude Code does not expose quota fraction
            rawSignal: null,
          },
        }
      : {}),
    rawAgentPayload: rawPayload,
  };

  return report;
}
