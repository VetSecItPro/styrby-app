/**
 * Static AI Model Pricing Reference
 *
 * A lightweight, browser/React Native-safe pricing table for UI display.
 * Unlike the LiteLLM dynamic pricing module, this file has zero dependencies
 * and no Node.js builtins — it is safe to import in any environment including
 * Expo/React Native and Next.js client bundles.
 *
 * ============================================================================
 * UPDATE THIS FILE WHEN AI PROVIDER PRICING CHANGES.
 * Check each provider's pricing page and update the prices and LAST_VERIFIED.
 *
 * - Anthropic: https://www.anthropic.com/pricing
 * - OpenAI:    https://openai.com/pricing
 * - Google:    https://ai.google.dev/pricing
 * ============================================================================
 *
 * WHY this file exists separately from litellm-pricing.ts:
 * litellm-pricing.ts uses Node.js builtins (node:fs, node:os, node:path,
 * node:crypto) which break webpack/Metro bundlers in client-side code.
 * This static module is the UI-safe counterpart — it provides the same
 * reference data without any runtime fetching or filesystem access.
 * Both styrby-mobile and styrby-web import from here so pricing data is
 * defined in one place only.
 *
 * @module pricing/static-pricing
 */

// ============================================================================
// Types
// ============================================================================

/**
 * AI provider identifier used for grouping models in the pricing table.
 *
 * Used by the cost dashboard to render provider section headers, filter
 * the pricing reference table, and apply provider-level display formatting.
 * Maps 1:1 with the three providers Styrby currently supports.
 */
export type ModelProvider = 'anthropic' | 'openai' | 'google';

/**
 * Pricing entry for a single AI model shown in the reference pricing table.
 *
 * Used by the cost dashboard in both styrby-web and styrby-mobile to display
 * a human-readable pricing reference. This is a UI display type only — it is
 * NOT used for actual cost calculations (which use `ModelPrice` from
 * litellm-pricing.ts with per-1k precision).
 *
 * Prices are in USD per 1 million tokens as published by each provider.
 *
 * WHY per-1M instead of per-1k: Provider pricing pages quote per-million,
 * so keeping the same unit makes it easy to cross-reference with official
 * docs and detect when this table needs updating.
 */
export interface ModelPricingEntry {
  /** Display name of the model (e.g. 'Claude 3.5 Sonnet') */
  name: string;
  /** AI provider */
  provider: ModelProvider;
  /** Cost per 1M input tokens in USD */
  inputPer1M: number;
  /** Cost per 1M output tokens in USD */
  outputPer1M: number;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Date when pricing data was last verified against provider websites.
 * Update this whenever you confirm prices are still accurate.
 */
export const STATIC_PRICING_LAST_VERIFIED = '2026-02-05';

/**
 * Provider display names for table section headers.
 *
 * @example
 * PROVIDER_DISPLAY_NAMES['anthropic']; // => 'Anthropic'
 */
export const PROVIDER_DISPLAY_NAMES: Record<ModelProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
};

/**
 * Static model pricing data for the reference table.
 *
 * WHY static: This is a reference table that matches what the CLI uses to
 * calculate costs. It is not fetched from the database — updates happen here
 * when provider pricing changes, and the single source of truth ensures
 * mobile and web always show the same prices.
 *
 * Last verified: 2026-02-05
 * Sources: anthropic.com/pricing, openai.com/pricing, ai.google.dev/pricing
 */
export const MODEL_PRICING_TABLE: ModelPricingEntry[] = [
  // ── Anthropic ──────────────────────────────────────────────────────────────
  {
    name: 'Claude 3.5 Sonnet',
    provider: 'anthropic',
    inputPer1M: 3.0,
    outputPer1M: 15.0,
  },
  {
    name: 'Claude 3.5 Haiku',
    provider: 'anthropic',
    inputPer1M: 0.8,
    outputPer1M: 4.0,
  },
  {
    name: 'Claude 3 Opus',
    provider: 'anthropic',
    inputPer1M: 15.0,
    outputPer1M: 75.0,
  },

  // ── OpenAI ─────────────────────────────────────────────────────────────────
  {
    name: 'GPT-4o',
    provider: 'openai',
    inputPer1M: 2.5,
    outputPer1M: 10.0,
  },
  {
    name: 'o1',
    provider: 'openai',
    inputPer1M: 15.0,
    outputPer1M: 60.0,
  },

  // ── Google ─────────────────────────────────────────────────────────────────
  {
    name: 'Gemini 1.5 Pro',
    provider: 'google',
    inputPer1M: 1.25,
    outputPer1M: 5.0,
  },
  {
    name: 'Gemini 1.5 Flash',
    provider: 'google',
    inputPer1M: 0.075,
    outputPer1M: 0.3,
  },
];
