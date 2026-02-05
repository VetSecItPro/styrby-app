/**
 * Cost Extractor
 *
 * Extracts token usage and cost information from different AI coding agents.
 * Supports multiple extraction strategies:
 *
 * - **Claude Code**: Hook events + JSONL file watching
 * - **Codex**: File watching in ~/.codex/sessions/
 * - **Gemini**: Parse /stats command output or OTel
 * - **OpenCode**: Parse stats command output
 *
 * @module costs/cost-extractor
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';
import type { AgentType } from '@/auth/agent-credentials';
import { calculateCost, MODEL_PRICING, type TokenUsage } from './jsonl-parser.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for the cost extractor
 */
export interface CostExtractorConfig {
  /** Agent type to extract costs from */
  agentType: AgentType;
  /** Session ID for tracking */
  sessionId: string;
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Extracted cost record ready for reporting
 */
export interface CostRecord {
  /** Session ID */
  sessionId: string;
  /** Agent type */
  agentType: AgentType;
  /** Model identifier */
  model: string;
  /** Input tokens consumed */
  inputTokens: number;
  /** Output tokens generated */
  outputTokens: number;
  /** Tokens read from cache (reduced cost) */
  cacheReadTokens: number;
  /** Tokens written to cache */
  cacheWriteTokens: number;
  /** Calculated cost in USD */
  costUsd: number;
  /** When this usage occurred */
  timestamp: Date;
}

/**
 * Cumulative session cost summary
 */
export interface SessionCostSummary {
  /** Session ID */
  sessionId: string;
  /** Agent type */
  agentType: AgentType;
  /** Total input tokens */
  totalInputTokens: number;
  /** Total output tokens */
  totalOutputTokens: number;
  /** Total cache read tokens */
  totalCacheReadTokens: number;
  /** Total cache write tokens */
  totalCacheWriteTokens: number;
  /** Total cost in USD */
  totalCostUsd: number;
  /** Number of API calls */
  recordCount: number;
  /** Breakdown by model */
  byModel: Record<string, {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }>;
}

/**
 * Events emitted by the cost extractor
 */
export interface CostExtractorEvents {
  /** New cost record extracted */
  cost: CostRecord;
  /** Error during extraction */
  error: { message: string; error?: Error };
}

// ============================================================================
// Agent-Specific Parsers
// ============================================================================

/**
 * Parse Claude Code streaming output for usage data.
 *
 * Claude Code emits JSON objects with usage stats in assistant messages.
 * This parser looks for usage patterns in the output buffer.
 *
 * @param output - Raw output from Claude Code
 * @returns Token usage if found, null otherwise
 */
export function parseClaudeOutput(output: string): TokenUsage | null {
  // Claude Code JSONL format has assistant messages with usage
  // Look for patterns like: "usage": { "input_tokens": 123, ...}
  const usageRegex = /"usage"\s*:\s*\{[^}]+\}/g;
  const modelRegex = /"model"\s*:\s*"([^"]+)"/;

  const matches = output.match(usageRegex);
  if (!matches || matches.length === 0) {
    return null;
  }

  // Get the last usage block (most recent)
  const lastUsage = matches[matches.length - 1];

  try {
    // Extract the usage object by wrapping in braces to make valid JSON
    const usageJson = lastUsage.replace(/"usage"\s*:\s*/, '');
    const usage = JSON.parse(usageJson);

    // Extract model from the same context
    const modelMatch = output.match(modelRegex);
    const model = modelMatch ? modelMatch[1] : 'claude-sonnet-4-20250514';

    return {
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      cacheReadTokens: usage.cache_read_input_tokens || usage.cache_creation_input_tokens || 0,
      cacheWriteTokens: usage.cache_write_input_tokens || 0,
      model,
      timestamp: new Date(),
    };
  } catch {
    return null;
  }
}

/**
 * Parse Codex streaming output for usage data.
 *
 * Codex logs token usage in its session files and also displays
 * status information that can be parsed.
 *
 * @param output - Raw output from Codex
 * @returns Token usage if found, null otherwise
 */
export function parseCodexOutput(output: string): TokenUsage | null {
  // Codex status output format varies, look for common patterns
  // Example: "Tokens: 1234 in, 567 out"
  // Or: "Usage: input=1234, output=567"
  const tokensRegex1 = /Tokens:\s*(\d+)\s*in[^\d]*(\d+)\s*out/i;
  const tokensRegex2 = /input[_\s]*tokens?[:\s=]+(\d+)[^\d]*output[_\s]*tokens?[:\s=]+(\d+)/i;
  const modelRegex = /model[:\s=]+["']?([^"'\s,]+)["']?/i;

  let inputTokens = 0;
  let outputTokens = 0;

  const match1 = output.match(tokensRegex1);
  if (match1) {
    inputTokens = parseInt(match1[1], 10);
    outputTokens = parseInt(match1[2], 10);
  } else {
    const match2 = output.match(tokensRegex2);
    if (match2) {
      inputTokens = parseInt(match2[1], 10);
      outputTokens = parseInt(match2[2], 10);
    } else {
      return null;
    }
  }

  const modelMatch = output.match(modelRegex);
  const model = modelMatch ? modelMatch[1] : 'gpt-4o';

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: 0, // Codex doesn't have cache tokens
    cacheWriteTokens: 0,
    model,
    timestamp: new Date(),
  };
}

/**
 * Parse Gemini CLI /stats command output.
 *
 * Gemini's /stats command outputs token usage in a formatted display.
 *
 * @param output - Raw output from Gemini CLI
 * @returns Token usage if found, null otherwise
 */
export function parseGeminiOutput(output: string): TokenUsage | null {
  // Gemini stats format:
  // "Input tokens: 1,234"
  // "Output tokens: 567"
  // "Model: gemini-2.0-flash"
  const inputRegex = /input\s*tokens?[:\s]+([0-9,]+)/i;
  const outputRegex = /output\s*tokens?[:\s]+([0-9,]+)/i;
  const modelRegex = /model[:\s]+["']?([^"'\s\n]+)["']?/i;

  const inputMatch = output.match(inputRegex);
  const outputMatch = output.match(outputRegex);

  if (!inputMatch && !outputMatch) {
    return null;
  }

  const inputTokens = inputMatch ? parseInt(inputMatch[1].replace(/,/g, ''), 10) : 0;
  const outputTokens = outputMatch ? parseInt(outputMatch[1].replace(/,/g, ''), 10) : 0;
  const modelMatch = output.match(modelRegex);
  const model = modelMatch ? modelMatch[1] : 'gemini-2.0-flash';

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    model,
    timestamp: new Date(),
  };
}

/**
 * Parse OpenCode stats command output.
 *
 * OpenCode's stats command shows token usage and cost statistics.
 *
 * @param output - Raw output from OpenCode
 * @returns Token usage if found, null otherwise
 */
export function parseOpenCodeOutput(output: string): TokenUsage | null {
  // OpenCode stats format varies by provider
  // Look for common patterns: tokens, cost, model
  const tokensRegex = /tokens?[:\s]+(\d+)\s*(?:input|in)[^\d]*(\d+)\s*(?:output|out)/i;
  const altTokensRegex = /(?:input|in)[:\s]+(\d+)[^\d]*(?:output|out)[:\s]+(\d+)/i;
  const modelRegex = /(?:model|using)[:\s]+["']?([^"'\s\n]+)["']?/i;

  let inputTokens = 0;
  let outputTokens = 0;

  const match1 = output.match(tokensRegex);
  if (match1) {
    inputTokens = parseInt(match1[1], 10);
    outputTokens = parseInt(match1[2], 10);
  } else {
    const match2 = output.match(altTokensRegex);
    if (match2) {
      inputTokens = parseInt(match2[1], 10);
      outputTokens = parseInt(match2[2], 10);
    } else {
      return null;
    }
  }

  const modelMatch = output.match(modelRegex);
  // OpenCode supports many providers, default to Claude if unknown
  const model = modelMatch ? modelMatch[1] : 'claude-sonnet-4-20250514';

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    model,
    timestamp: new Date(),
  };
}

// ============================================================================
// Cost Extractor Class
// ============================================================================

/**
 * Cost Extractor
 *
 * Extracts and tracks token usage from agent output in real-time.
 * Maintains a running total for the session and emits cost events
 * that can be forwarded to Supabase.
 */
export class CostExtractor extends EventEmitter {
  private config: CostExtractorConfig;
  private records: CostRecord[] = [];
  private lastProcessedLength = 0;
  private parseFunction: (output: string) => TokenUsage | null;

  constructor(config: CostExtractorConfig) {
    super();
    this.config = config;

    // Select the appropriate parser based on agent type
    this.parseFunction = this.getParserForAgent(config.agentType);
  }

  /**
   * Get the appropriate parser function for the agent type.
   *
   * @param agentType - The type of agent
   * @returns Parser function for the agent
   */
  private getParserForAgent(agentType: AgentType): (output: string) => TokenUsage | null {
    switch (agentType) {
      case 'claude':
        return parseClaudeOutput;
      case 'codex':
        return parseCodexOutput;
      case 'gemini':
        return parseGeminiOutput;
      case 'opencode':
        return parseOpenCodeOutput;
      default:
        // Fallback to Claude parser for unknown agents
        return parseClaudeOutput;
    }
  }

  /**
   * Process agent output and extract cost data.
   *
   * Call this method with the cumulative output buffer.
   * The extractor will process only new content since the last call.
   *
   * @param output - Cumulative output from the agent
   * @returns Cost record if new usage found, null otherwise
   */
  processOutput(output: string): CostRecord | null {
    // Only process new content
    const newContent = output.slice(this.lastProcessedLength);
    if (!newContent || newContent.length === 0) {
      return null;
    }

    this.lastProcessedLength = output.length;

    const usage = this.parseFunction(newContent);
    if (!usage) {
      return null;
    }

    // Skip if we already have this exact record (de-duplication)
    const isDuplicate = this.records.some(
      r =>
        r.inputTokens === usage.inputTokens &&
        r.outputTokens === usage.outputTokens &&
        r.model === usage.model &&
        Math.abs(r.timestamp.getTime() - usage.timestamp.getTime()) < 1000
    );

    if (isDuplicate) {
      return null;
    }

    const costUsd = calculateCost(usage);

    const record: CostRecord = {
      sessionId: this.config.sessionId,
      agentType: this.config.agentType,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      costUsd,
      timestamp: usage.timestamp,
    };

    this.records.push(record);
    this.emit('cost', record);
    this.log('Extracted cost:', record);

    return record;
  }

  /**
   * Manually add a cost record (for hook-based extraction).
   *
   * @param usage - Token usage data
   * @returns The created cost record
   */
  addUsage(usage: TokenUsage): CostRecord {
    const costUsd = calculateCost(usage);

    const record: CostRecord = {
      sessionId: this.config.sessionId,
      agentType: this.config.agentType,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      costUsd,
      timestamp: usage.timestamp,
    };

    this.records.push(record);
    this.emit('cost', record);
    this.log('Added cost:', record);

    return record;
  }

  /**
   * Get all extracted records.
   *
   * @returns Array of cost records
   */
  getRecords(): CostRecord[] {
    return [...this.records];
  }

  /**
   * Get the session cost summary.
   *
   * @returns Aggregated cost summary
   */
  getSummary(): SessionCostSummary {
    const summary: SessionCostSummary = {
      sessionId: this.config.sessionId,
      agentType: this.config.agentType,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      totalCostUsd: 0,
      recordCount: this.records.length,
      byModel: {},
    };

    for (const record of this.records) {
      summary.totalInputTokens += record.inputTokens;
      summary.totalOutputTokens += record.outputTokens;
      summary.totalCacheReadTokens += record.cacheReadTokens;
      summary.totalCacheWriteTokens += record.cacheWriteTokens;
      summary.totalCostUsd += record.costUsd;

      if (!summary.byModel[record.model]) {
        summary.byModel[record.model] = {
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
        };
      }

      summary.byModel[record.model].inputTokens += record.inputTokens;
      summary.byModel[record.model].outputTokens += record.outputTokens;
      summary.byModel[record.model].costUsd += record.costUsd;
    }

    return summary;
  }

  /**
   * Reset the extractor state.
   */
  reset(): void {
    this.records = [];
    this.lastProcessedLength = 0;
    this.log('Extractor reset');
  }

  /**
   * Debug logging.
   */
  private log(message: string, data?: unknown): void {
    if (this.config.debug) {
      console.log(`[CostExtractor:${this.config.agentType}]`, message, data || '');
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a cost extractor for the specified agent type.
 *
 * @param config - Extractor configuration
 * @returns Configured cost extractor
 *
 * @example
 * const extractor = createCostExtractor({
 *   agentType: 'claude',
 *   sessionId: 'session-123',
 *   debug: true,
 * });
 *
 * extractor.on('cost', (record) => {
 *   console.log('New cost:', record.costUsd);
 * });
 *
 * // Process agent output
 * extractor.processOutput(agentOutput);
 */
export function createCostExtractor(config: CostExtractorConfig): CostExtractor {
  return new CostExtractor(config);
}

// ============================================================================
// Exports
// ============================================================================

export default {
  CostExtractor,
  createCostExtractor,
  parseClaudeOutput,
  parseCodexOutput,
  parseGeminiOutput,
  parseOpenCodeOutput,
};
