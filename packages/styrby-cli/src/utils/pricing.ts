import { Usage } from '../api/types';

/**
 * Pricing rates per million tokens for different models
 * Source: https://www.anthropic.com/api (approximate as of early 2025)
 */
export const PRICING = {
    // --- Claude 4 & Future Models ---
    'claude-4.5-opus': {
        input: 5.0,
        output: 25.0,
        cache_write: 6.25,
        cache_read: 0.50
    },
    'claude-4.1-opus': {
        input: 15.0,
        output: 75.0,
        cache_write: 18.75,
        cache_read: 1.50
    },
    'claude-4-opus': {
        input: 15.0,
        output: 75.0,
        cache_write: 18.75,
        cache_read: 1.50
    },
    'claude-4.5-sonnet': {
        input: 3.0,
        output: 15.0,
        cache_write: 3.75,
        cache_read: 0.30
    },
    'claude-4-sonnet': {
        input: 3.0,
        output: 15.0,
        cache_write: 3.75,
        cache_read: 0.30
    },
    'claude-4.5-haiku': {
        input: 1.0,
        output: 5.0,
        cache_write: 1.25,
        cache_read: 0.10
    },

    // --- Legacy / Claude 3 ---
    'claude-3-opus-20240229': {
        input: 15.0,
        output: 75.0,
        cache_write: 18.75,
        cache_read: 1.5
    },
    'claude-3-sonnet-20240229': {
        input: 3.0,
        output: 15.0,
        cache_write: 3.75,
        cache_read: 0.3
    },
    'claude-3-5-sonnet-20240620': {
        input: 3.0,
        output: 15.0,
        cache_write: 3.75,
        cache_read: 0.3
    },
    // New Sonnet 3.5 updated model
    'claude-3-5-sonnet-20241022': {
        input: 3.0,
        output: 15.0,
        cache_write: 3.75,
        cache_read: 0.3
    },
    'claude-3-haiku-20240307': {
        input: 0.25,
        output: 1.25,
        cache_write: 0.3125,
        cache_read: 0.025
    },
    'claude-3-5-haiku-20241022': {
        input: 0.8,
        output: 4.0,
        cache_write: 1.0,  // Approx based on 1.25x rule usually or custom
        cache_read: 0.08
    }
} as const;

export type ModelId = keyof typeof PRICING;

// Default to Sonnet 3.5 if unknown
const DEFAULT_MODEL = 'claude-3-5-sonnet-20241022';

/**
 * Calculates the USD cost for an Anthropic API response given token usage.
 *
 * WHY: Anthropic bills input tokens, output tokens, cache-write tokens, and
 * cache-read tokens at different rates depending on the model. Centralising
 * the calculation here means budget-alert and cost-record logic never
 * duplicate pricing arithmetic.
 *
 * Fuzzy model matching is used as a fallback because the Claude API sometimes
 * returns model strings that differ slightly from the canonical IDs in `PRICING`
 * (e.g., version suffixes, aliases). When no match is found the function
 * defaults to `claude-3-5-sonnet-20241022` so callers always receive a
 * non-zero, reasonable estimate rather than silently returning $0.
 *
 * @param usage   - Token usage breakdown from the Anthropic API response.
 *   `input_tokens` and `output_tokens` are required; cache fields default to 0.
 * @param modelId - The model identifier string as returned by the API
 *   (e.g., `'claude-sonnet-4-5'`). Optional — defaults to Sonnet 3.5 when
 *   omitted or unrecognized.
 * @returns An object with three USD cost values (never negative):
 *   - `total`  — full session cost (input + cache + output)
 *   - `input`  — combined input cost (regular input + cache writes + cache reads)
 *   - `output` — output token cost only
 *
 * @example
 * const cost = calculateCost(
 *   { input_tokens: 10_000, output_tokens: 2_000,
 *     cache_creation_input_tokens: 500, cache_read_input_tokens: 8_000 },
 *   'claude-sonnet-4-5'
 * );
 * console.log(`Session cost: $${cost.total.toFixed(4)}`);
 */
export function calculateCost(usage: Usage, modelId?: string): { total: number, input: number, output: number } {
    let pricing = PRICING[modelId as ModelId];

    // Fallback if model not found
    if (!pricing) {
        // Try fuzzy matching for common aliases
        if (modelId?.includes('opus')) {
            if (modelId.includes('4.5')) pricing = PRICING['claude-4.5-opus'];
            else if (modelId.includes('4.1')) pricing = PRICING['claude-4.1-opus'];
            else if (modelId.includes('4')) pricing = PRICING['claude-4-opus'];
            else pricing = PRICING['claude-3-opus-20240229'];
        }
        else if (modelId?.includes('sonnet')) {
            if (modelId.includes('4.5')) pricing = PRICING['claude-4.5-sonnet'];
            else if (modelId.includes('4')) pricing = PRICING['claude-4-sonnet'];
            else pricing = PRICING['claude-3-5-sonnet-20241022'];
        }
        else if (modelId?.includes('haiku')) {
            if (modelId.includes('4.5')) pricing = PRICING['claude-4.5-haiku'];
            else if (modelId.includes('3.5')) pricing = PRICING['claude-3-5-haiku-20241022'];
            else pricing = PRICING['claude-3-haiku-20240307'];
        }
        else pricing = PRICING[DEFAULT_MODEL];
    }

    const inputCost = (usage.input_tokens / 1_000_000) * pricing.input;
    const outputCost = (usage.output_tokens / 1_000_000) * pricing.output;

    // Cache costs
    const cacheWriteCost = ((usage.cache_creation_input_tokens || 0) / 1_000_000) * pricing.cache_write;
    const cacheReadCost = ((usage.cache_read_input_tokens || 0) / 1_000_000) * pricing.cache_read;

    const totalInputCost = inputCost + cacheWriteCost + cacheReadCost;

    return {
        total: totalInputCost + outputCost,
        input: totalInputCost,
        output: outputCost
    };
}
