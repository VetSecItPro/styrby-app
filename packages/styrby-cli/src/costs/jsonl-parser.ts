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
import type { AgentType } from 'styrby-shared';
// WHY: Import from the dedicated ./pricing subpath, NOT the barrel export.
// litellm-pricing uses Node.js builtins (node:path, node:os) that break
// webpack in the web package if re-exported from styrby-shared's barrel.
import { getModelPriceSync, getModelPrice, type ModelPrice } from '@styrby/shared/pricing';

/**
 * Legacy static pricing map — kept for backward compatibility only.
 *
 * @deprecated Use `getModelPriceSync()` or `getModelPrice()` from `styrby-shared`
 * instead. Those functions draw from LiteLLM's live dataset with a multi-tier
 * fallback chain, so pricing stays accurate as providers change their rates.
 *
 * This map is retained so that any external code that imports `MODEL_PRICING`
 * directly still compiles without changes. It will NOT be updated when prices
 * change — use the dynamic functions instead.
 *
 * Prices are USD per 1M tokens (historical Styrby format).
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

// Re-export the dynamic pricing types so dependents can migrate to them
export type { ModelPrice };
export { getModelPrice, getModelPriceSync };

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
 * Returns model pricing using the dynamic LiteLLM pricing module.
 *
 * Uses `getModelPriceSync()` from the shared pricing module, which draws from
 * a 1-hour in-memory cache populated by `getModelPrice()` (async). On the
 * very first call (cold cache), it falls back to the built-in static map.
 *
 * WHY: `calculateCost()` is called in a tight synchronous loop while parsing
 * JSONL files. We cannot await here. The async `getModelPrice()` is called
 * during session start to warm the cache, so sync lookups are accurate for
 * any session that was started with the CLI connected.
 *
 * @param model - Model identifier from token usage
 * @returns Pricing in the legacy per-1M-tokens format for backward compatibility
 */
function getModelPricingForModel(model: string): { input: number; output: number; cacheRead?: number; cacheWrite?: number } | undefined {
  // Check for env-var override first (keeps urgent-override escape hatch)
  const envOverride = process.env.STYRBY_MODEL_PRICING_JSON;
  if (envOverride) {
    try {
      const overrides = JSON.parse(envOverride) as Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }>;
      if (overrides[model]) return overrides[model];
    } catch {
      // Invalid JSON in env var — continue to dynamic lookup
    }
  }

  // Use the dynamic LiteLLM pricing module (sync, uses in-memory cache)
  const price = getModelPriceSync(model);

  // Convert from per-1k (ModelPrice format) back to per-1M (legacy format)
  // WHY: calculateCost() and calculateInputCost() use per-1M arithmetic. We
  // keep that math untouched to avoid introducing conversion bugs; instead we
  // adapt the data here at the boundary.
  const per1M: { input: number; output: number; cacheRead?: number; cacheWrite?: number } = {
    input: price.inputPer1k * 1000,
    output: price.outputPer1k * 1000,
  };

  if (price.cachePer1k !== undefined) {
    per1M.cacheRead = price.cachePer1k * 1000;
  }
  if (price.cacheWritePer1k !== undefined) {
    per1M.cacheWrite = price.cacheWritePer1k * 1000;
  }

  return per1M;
}

/**
 * Determines the agent type that uses a given model.
 *
 * WHY: Budget alerts can be scoped to a specific agent (e.g., "only track
 * Claude spending"). Model names encode which agent produced the cost:
 * - Claude models start with "claude-" (Anthropic)
 * - OpenAI/Codex models start with "gpt-", "o1-", or "o3-"
 * - Gemini models start with "gemini-"
 *
 * @param model - Model name from token usage (e.g., 'claude-sonnet-4-20250514')
 * @returns The agent type, or null if the model can't be mapped
 */
export function getAgentTypeForModel(model: string): AgentType | null {
  const lower = model.toLowerCase();

  if (lower.startsWith('claude-')) return 'claude';
  if (lower.startsWith('gpt-') || lower.startsWith('o1-') || lower.startsWith('o3-')) return 'codex';
  if (lower.startsWith('gemini-')) return 'gemini';

  return null;
}

/**
 * Calculate cost for token usage.
 *
 * Uses the LiteLLM dynamic pricing module via `getModelPricingForModel()`.
 * The pricing cache is populated asynchronously; until it is warm, the
 * built-in static fallback map is used so this function never blocks.
 *
 * @param usage - Token usage record from a parsed JSONL event
 * @returns Total cost in USD
 */
export function calculateCost(usage: TokenUsage): number {
  const pricing = getModelPricingForModel(usage.model);
  if (!pricing) {
    // getModelPricingForModel() always returns a value; this branch is
    // unreachable in practice but TypeScript needs the guard.
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
 * Calculate input-only cost for a token usage record.
 *
 * WHY (H-002b): Used for pre-reserving cost before the AI agent responds.
 * At request time, the CLI knows the exact input token count and model, so
 * the input cost is precise. Output cost is unknown until the agent finishes.
 * This function returns only the input portion (input + cache costs, no output).
 *
 * @param usage - Token usage with input token counts populated
 * @returns Input-only cost in USD
 */
export function calculateInputCost(usage: TokenUsage): number {
  const pricing = getModelPricingForModel(usage.model);
  if (!pricing) {
    // getModelPricingForModel() always returns a value; this branch is
    // unreachable in practice but TypeScript needs the guard.
    return (usage.inputTokens * 3) / 1_000_000;
  }

  const inputCost = (usage.inputTokens * pricing.input) / 1_000_000;
  const cacheReadCost = pricing.cacheRead
    ? (usage.cacheReadTokens * pricing.cacheRead) / 1_000_000
    : 0;
  const cacheWriteCost = pricing.cacheWrite
    ? (usage.cacheWriteTokens * pricing.cacheWrite) / 1_000_000
    : 0;

  return inputCost + cacheReadCost + cacheWriteCost;
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
        cacheReadTokens: usage.cache_read_input_tokens || 0,
        cacheWriteTokens: usage.cache_creation_input_tokens || 0,
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
 * Parse a JSONL file and extract all token usage.
 *
 * When `STYRBY_NATIVE_PARSER=true` is set in the environment and the
 * `@styrby/native` Rust module is compiled and available for the current
 * platform, this function delegates to the SIMD-accelerated Rust batch
 * parser (`parseJsonlFileBatch`). On all other paths it falls back to the
 * pure-JS readline parser.
 *
 * WHY: The Rust parser targets >500 MB/s on multi-core hardware vs ~100 MB/s
 * for the JS readline parser. For large session files (>10 MB) this cuts
 * parse time from hundreds of milliseconds to tens of milliseconds. The
 * feature flag keeps the default path safe: the JS parser always works, even
 * when the native module hasn't been compiled or is on an unsupported platform.
 *
 * @param filePath - Absolute or relative path to the `.jsonl` session file
 * @returns Array of `TokenUsage` records extracted from the file
 */
export async function parseJsonlFile(filePath: string): Promise<TokenUsage[]> {
  // WHY: We only attempt the native parser when explicitly opted in via the
  // env var. Defaulting to JS keeps CI green without requiring a Rust toolchain.
  if (process.env.STYRBY_NATIVE_PARSER === 'true') {
    try {
      // WHY: We use a computed module specifier via `Function` to prevent
      // TypeScript from statically resolving `@styrby/native`. The native
      // package is an optional peer — it may not be installed in all
      // environments (e.g., CI without a Rust toolchain). A static `import()`
      // would cause `tsc --noEmit` to fail with TS2307 if the package isn't
      // present, blocking typecheck for the entire CLI. Using an indirection
      // keeps the import fully dynamic at runtime while satisfying TypeScript.
      const specifier = '@styrby/native';
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const native = await (new Function('s', 'return import(s)'))(specifier) as {
        isNativeLoaded: boolean;
        parseJsonlFileBatch: (path: string) => Promise<Array<{
          input_tokens: number;
          output_tokens: number;
          cache_read_tokens: number;
          cache_write_tokens: number;
          model: string;
          timestamp: string;
        }>>;
      };
      if (native.isNativeLoaded) {
        const rawRecords = await native.parseJsonlFileBatch(filePath);
        // Adapt NativeTokenUsage (snake_case, string timestamp) to TokenUsage
        // (camelCase, Date timestamp) for drop-in compatibility with callers.
        return rawRecords.map((r) => ({
          inputTokens: r.input_tokens,
          outputTokens: r.output_tokens,
          cacheReadTokens: r.cache_read_tokens,
          cacheWriteTokens: r.cache_write_tokens,
          model: r.model,
          timestamp: new Date(r.timestamp),
        }));
      }
    } catch {
      // Native module unavailable or failed to load — fall through to JS parser.
      // No-op: the JS parser below is the guaranteed fallback path.
    }
  }

  // --- Pure-JS readline parser (default path) ---
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
 * Get costs for a specific date range, optionally filtered by agent type.
 *
 * @param startDate - Start of the date range (inclusive)
 * @param endDate - End of the date range (inclusive)
 * @param files - Optional list of JSONL files to parse (defaults to all session files)
 * @param agentType - Optional agent type filter. When provided, only costs from
 *                    models belonging to that agent are included. When omitted,
 *                    costs from all agents are aggregated (existing behavior).
 * @returns Aggregated cost summary for the date range
 */
export async function getCostsForDateRange(
  startDate: Date,
  endDate: Date,
  files?: string[],
  agentType?: AgentType
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
        // Skip this usage if agent type filter is active and doesn't match
        if (agentType && getAgentTypeForModel(usage.model) !== agentType) {
          continue;
        }

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
