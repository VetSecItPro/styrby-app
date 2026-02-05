/**
 * AI Model Pricing Reference
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
 * @module lib/model-pricing
 */

/**
 * Date when pricing data was last verified against provider websites.
 * Update this whenever you confirm prices are still accurate.
 */
export const LAST_VERIFIED = '2026-02-05';

/** AI provider identifier. */
export type Provider = 'anthropic' | 'openai' | 'google';

/**
 * Pricing entry for a single model.
 *
 * Prices are in USD per 1 million tokens.
 */
export interface ModelPricingEntry {
  /** Display name of the model */
  name: string;
  /** AI provider */
  provider: Provider;
  /** Cost per 1M input tokens in USD */
  inputPer1M: number;
  /** Cost per 1M output tokens in USD */
  outputPer1M: number;
}

/**
 * Model pricing data grouped by provider.
 *
 * WHY: Centralized here so pricing changes only need to be updated in one
 * place instead of being scattered across UI components.
 */
export const MODEL_PRICING: ModelPricingEntry[] = [
  // ── Anthropic ──────────────────────────────────────────────────────────
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

  // ── OpenAI ─────────────────────────────────────────────────────────────
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

  // ── Google ─────────────────────────────────────────────────────────────
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

/**
 * Provider display names for table section headers.
 */
export const PROVIDER_DISPLAY_NAMES: Record<Provider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
};
