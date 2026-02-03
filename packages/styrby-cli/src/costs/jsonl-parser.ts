/**
 * JSONL Cost Parser
 *
 * Parses Claude Code session JSONL files to extract token usage and costs.
 * Claude Code stores session transcripts in ~/.claude/projects/.../[session-id].jsonl
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';

/**
 * Model pricing per 1M tokens (USD)
 */
export const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }> = {
  // Claude models (Anthropic)
  'claude-opus-4-5-20251101': { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 },
  'claude-sonnet-4-20250514': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-3-5-sonnet-20241022': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-3-5-haiku-20241022': { input: 0.80, output: 4.00, cacheRead: 0.08, cacheWrite: 1.00 },
  'claude-3-opus-20240229': { input: 15.00, output: 75.00 },
  // OpenAI models (Codex)
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4-turbo': { input: 10.00, output: 30.00 },
  'o1-preview': { input: 15.00, output: 60.00 },
  'o1-mini': { input: 3.00, output: 12.00 },
  // Google models (Gemini)
  'gemini-2.0-flash': { input: 0.10, output: 0.40 },
  'gemini-1.5-pro': { input: 1.25, output: 5.00 },
  'gemini-1.5-flash': { input: 0.075, output: 0.30 },
};

/**
 * Token usage from a single API call
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  model: string;
  timestamp: Date;
}

/**
 * Aggregated cost data
 */
export interface CostSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalCostUsd: number;
  byModel: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
  }>;
  sessionCount: number;
  firstTimestamp?: Date;
  lastTimestamp?: Date;
}

/**
 * Calculate cost for token usage
 */
export function calculateCost(usage: TokenUsage): number {
  const pricing = MODEL_PRICING[usage.model];
  if (!pricing) {
    // Default pricing if model unknown
    return ((usage.inputTokens * 3) + (usage.outputTokens * 15)) / 1_000_000;
  }

  const inputCost = (usage.inputTokens * pricing.input) / 1_000_000;
  const outputCost = (usage.outputTokens * pricing.output) / 1_000_000;
  const cacheReadCost = pricing.cacheRead
    ? (usage.cacheReadTokens * pricing.cacheRead) / 1_000_000
    : 0;
  const cacheWriteCost = pricing.cacheWrite
    ? (usage.cacheWriteTokens * pricing.cacheWrite) / 1_000_000
    : 0;

  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

/**
 * Parse a single JSONL line for token usage
 */
function parseJsonlLine(line: string): TokenUsage | null {
  try {
    const data = JSON.parse(line);

    // Claude Code JSONL format has usage in the message
    if (data.type === 'assistant' && data.message?.usage) {
      const usage = data.message.usage;
      return {
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
        cacheReadTokens: usage.cache_read_input_tokens || usage.cache_creation_input_tokens || 0,
        cacheWriteTokens: usage.cache_write_input_tokens || 0,
        model: data.message.model || 'unknown',
        timestamp: new Date(data.timestamp || Date.now()),
      };
    }

    // Also check for cost_info field (some JSONL formats)
    if (data.cost_info) {
      return {
        inputTokens: data.cost_info.input_tokens || 0,
        outputTokens: data.cost_info.output_tokens || 0,
        cacheReadTokens: data.cost_info.cache_read_tokens || 0,
        cacheWriteTokens: data.cost_info.cache_write_tokens || 0,
        model: data.cost_info.model || 'unknown',
        timestamp: new Date(data.timestamp || Date.now()),
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Parse a JSONL file and extract all token usage
 */
export async function parseJsonlFile(filePath: string): Promise<TokenUsage[]> {
  const usages: TokenUsage[] = [];

  if (!fs.existsSync(filePath)) {
    return usages;
  }

  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (line.trim()) {
      const usage = parseJsonlLine(line);
      if (usage) {
        usages.push(usage);
      }
    }
  }

  return usages;
}

/**
 * Find all Claude Code session files
 */
export function findSessionFiles(): string[] {
  const claudeDir = path.join(os.homedir(), '.claude');
  const projectsDir = path.join(claudeDir, 'projects');
  const files: string[] = [];

  if (!fs.existsSync(projectsDir)) {
    return files;
  }

  // Recursively find all .jsonl files
  function walkDir(dir: string): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          files.push(fullPath);
        }
      }
    } catch {
      // Ignore permission errors
    }
  }

  walkDir(projectsDir);
  return files;
}

/**
 * Parse all session files and aggregate costs
 */
export async function aggregateCosts(files?: string[]): Promise<CostSummary> {
  const sessionFiles = files || findSessionFiles();

  const summary: CostSummary = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalCostUsd: 0,
    byModel: {},
    sessionCount: sessionFiles.length,
  };

  for (const file of sessionFiles) {
    const usages = await parseJsonlFile(file);

    for (const usage of usages) {
      // Update timestamps
      if (!summary.firstTimestamp || usage.timestamp < summary.firstTimestamp) {
        summary.firstTimestamp = usage.timestamp;
      }
      if (!summary.lastTimestamp || usage.timestamp > summary.lastTimestamp) {
        summary.lastTimestamp = usage.timestamp;
      }

      // Update totals
      summary.totalInputTokens += usage.inputTokens;
      summary.totalOutputTokens += usage.outputTokens;
      summary.totalCacheReadTokens += usage.cacheReadTokens;
      summary.totalCacheWriteTokens += usage.cacheWriteTokens;

      const cost = calculateCost(usage);
      summary.totalCostUsd += cost;

      // Update by model
      if (!summary.byModel[usage.model]) {
        summary.byModel[usage.model] = {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
        };
      }
      const modelSummary = summary.byModel[usage.model];
      modelSummary.inputTokens += usage.inputTokens;
      modelSummary.outputTokens += usage.outputTokens;
      modelSummary.cacheReadTokens += usage.cacheReadTokens;
      modelSummary.cacheWriteTokens += usage.cacheWriteTokens;
      modelSummary.costUsd += cost;
    }
  }

  return summary;
}

/**
 * Get costs for a specific date range
 */
export async function getCostsForDateRange(
  startDate: Date,
  endDate: Date,
  files?: string[]
): Promise<CostSummary> {
  const sessionFiles = files || findSessionFiles();

  const summary: CostSummary = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalCostUsd: 0,
    byModel: {},
    sessionCount: 0,
  };

  for (const file of sessionFiles) {
    const usages = await parseJsonlFile(file);
    let hasUsageInRange = false;

    for (const usage of usages) {
      if (usage.timestamp >= startDate && usage.timestamp <= endDate) {
        hasUsageInRange = true;

        // Update timestamps
        if (!summary.firstTimestamp || usage.timestamp < summary.firstTimestamp) {
          summary.firstTimestamp = usage.timestamp;
        }
        if (!summary.lastTimestamp || usage.timestamp > summary.lastTimestamp) {
          summary.lastTimestamp = usage.timestamp;
        }

        // Update totals
        summary.totalInputTokens += usage.inputTokens;
        summary.totalOutputTokens += usage.outputTokens;
        summary.totalCacheReadTokens += usage.cacheReadTokens;
        summary.totalCacheWriteTokens += usage.cacheWriteTokens;

        const cost = calculateCost(usage);
        summary.totalCostUsd += cost;

        // Update by model
        if (!summary.byModel[usage.model]) {
          summary.byModel[usage.model] = {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0,
          };
        }
        const modelSummary = summary.byModel[usage.model];
        modelSummary.inputTokens += usage.inputTokens;
        modelSummary.outputTokens += usage.outputTokens;
        modelSummary.cacheReadTokens += usage.cacheReadTokens;
        modelSummary.cacheWriteTokens += usage.cacheWriteTokens;
        modelSummary.costUsd += cost;
      }
    }

    if (hasUsageInRange) {
      summary.sessionCount++;
    }
  }

  return summary;
}

/**
 * Get today's costs
 */
export async function getTodayCosts(): Promise<CostSummary> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return getCostsForDateRange(today, tomorrow);
}

/**
 * Get this month's costs
 */
export async function getMonthCosts(): Promise<CostSummary> {
  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const firstOfNextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  return getCostsForDateRange(firstOfMonth, firstOfNextMonth);
}
