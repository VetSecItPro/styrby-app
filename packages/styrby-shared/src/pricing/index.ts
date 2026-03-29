/**
 * Pricing module exports
 *
 * - litellm-pricing: Dynamic pricing via LiteLLM (Node.js only — CLI use)
 * - static-pricing:  Static reference table (universal — mobile + web safe)
 *
 * WHY two modules:
 * litellm-pricing.ts uses Node.js builtins that break client bundles.
 * Import from 'static-pricing' in any browser/React Native context.
 * Import from 'litellm-pricing' in CLI/server-side Node.js code only.
 */

export * from './litellm-pricing.js';
export * from './static-pricing.js';
