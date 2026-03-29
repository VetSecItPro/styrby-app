/**
 * Styrby Shared
 *
 * Shared types, constants, and utilities used across
 * styrby-cli, styrby-mobile, and styrby-web packages.
 */

// Re-export types
export * from './types.js';
export * from './types/context-templates.js';
export * from './constants.js';

// Re-export relay module
export * from './relay/index.js';

// Re-export encryption module
export * from './encryption.js';

// Re-export design system
export * from './design/index.js';

// Re-export error attribution (namespaced to avoid conflicts)
export * as errors from './errors/index.js';

// Re-export utilities
export * from './utils/index.js';

// WHY: The full pricing module is NOT re-exported from the barrel.
// litellm-pricing.ts uses Node.js builtins (node:path, node:os, node:fs, node:crypto)
// which break webpack/Next.js client bundles. Import directly from
// '@styrby/shared/pricing' or 'styrby-shared/src/pricing' in CLI code only.
//
// The static-pricing subset IS safe for all environments and is re-exported here.
export type { ModelProvider, ModelPricingEntry } from './pricing/static-pricing.js';
export { MODEL_PRICING_TABLE, PROVIDER_DISPLAY_NAMES, STATIC_PRICING_LAST_VERIFIED } from './pricing/static-pricing.js';
