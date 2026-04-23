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

// WHY encryption is NOT re-exported from the barrel:
// libsodium-wrappers ships ~700KB of WASM. If `@styrby/shared` re-exports
// encryption, every consumer pulls libsodium into its initial bundle even
// when it only imports unrelated helpers (e.g. contextTemplateFromRow on
// the templates page). Forcing crypto callers to import from the dedicated
// subpath `@styrby/shared/encryption` keeps the WASM out of code that
// doesn't need it - critical for the web's main client chunk staying under
// the 750KB CI bundle-size budget.
//
// To use encryption: `import { encrypt, decrypt, ... } from '@styrby/shared/encryption'`

// Re-export auth helpers (WebAuthn/passkey types + pure helpers)
export * from './auth/index.js';

// Re-export MCP catalog (tool descriptors only — runtime server lives in CLI).
// Safe to barrel: pure data, zero crypto/WASM weight.
export * from './mcp/catalog.js';

// Re-export design system
export * from './design/index.js';

// Re-export error attribution (namespaced to avoid conflicts)
export * as errors from './errors/index.js';

// Re-export utilities
export * from './utils/index.js';

// Phase 0.10 — integration readiness gates.
// Billing tier-logic helpers; ApiError envelope; event registry/dispatcher;
// platform-agnostic Realtime subscription factory.
export * from './billing/index.js';
export * from './api/index.js';
export * from './events/index.js';
export * from './hooks/index.js';

// Phase 1.1 — honest token counting (lazy-loads anthropic/openai tokenizers
// when present, falls back to the words*1.3 heuristic everywhere else).
export * from './tokenizers/index.js';

// Phase 1.6.1 — unified cost report type for real LLM cost surfacing.
// CostReport, CostReportSchema, BillingModel, CostSource, and supporting
// constants are consumed by the CLI reporter and the web/mobile dashboards.
export * from './cost/index.js';

// Phase 2 — Team Tier (0.8.7 + 0.9.2).
// DB-mirror types (interfaces + Zod schemas + runtime constants). These
// are the thin shape-of-table types used by CRUD API code. The policy
// engine in `./team/` owns the canonical names `TeamPolicy` and
// `ApprovalStatus` (richer engine-flavored variants); the DB variants are
// prefixed `Db*` at the source to keep both accessible without collision.
export * from './teams/index.js';
// Tier-check utilities covering all six billing tiers including the team family.
// Both web and mobile consume these so a gating decision can never disagree
// across surfaces (SOC2 CC6.1).
export * from './tiers/index.js';
// Phase 2.1 — team governance runtime helpers (role matrix, approval chain
// evaluator) + the engine-flavored TeamPolicy/ApprovalStatus used by the
// policy engine in CLI, web admin, and mobile push-approval.
export * from './team/index.js';
// Phase 1.6.9 — Data Privacy Control Center.
// Pure TypeScript mirrors of the PL/pgSQL retention functions from migration 025.
// Safe to barrel: zero WASM/Node.js builtins, consumed by web, mobile, and CLI.
// Audit: GDPR Art. 5(1)(e) storage limitation; SOC2 CC7.2
export * from './privacy/index.js';

// WHY: The full pricing module is NOT re-exported from the barrel.
// litellm-pricing.ts uses Node.js builtins (node:path, node:os, node:fs, node:crypto)
// which break webpack/Next.js client bundles. Import directly from
// '@styrby/shared/pricing' or 'styrby-shared/src/pricing' in CLI code only.
//
// The static-pricing subset IS safe for all environments and is re-exported here.
export type { ModelProvider, ModelPricingEntry } from './pricing/static-pricing.js';
export { MODEL_PRICING_TABLE, PROVIDER_DISPLAY_NAMES, STATIC_PRICING_LAST_VERIFIED } from './pricing/static-pricing.js';

// Phase 1.6.11 — Feedback loop.
// NPS calculation utilities (calcNPS, groupNpsByWeek, formatNpsScore) and types.
// Pure TypeScript, zero Node.js builtins — safe for web, mobile, and CLI.
export * from './feedback/index.js';

// Phase 3.3 — Session replay types (runtime scrub engine stays at subpath
// '@styrby/shared/session-replay' for tree-shaking; types re-exported here so
// mobile consumers — which use moduleResolution: "node" and can't follow
// package.json exports subpaths — can import them directly from the root.)
export type * from './session-replay/types.js';

// Phase 3.4 — Cost forecasting (EMA-blend predictions + exhaustion dates).
// Pure integer-cents math, no Zod, no DB calls — safe for web, mobile, and
// the nightly pg_cron predictive-alert job.
// Audit: SOC2 CC7.2 (system monitoring / cost accounting accuracy).
export * from './cost-forecast/index.js';

// Phase 3.5 — Cross-agent context sync types (runtime summarizer stays at
// subpath '@styrby/shared/context-sync' for tree-shaking — it imports the
// scrub engine regex patterns which add bundle weight). Types re-exported here
// so mobile consumers can import them from the root.
// Constants also re-exported: TOKEN_BUDGET_DEFAULT etc. are pure number literals
// with zero bundle weight.
export type {
  ContextFileRef,
  ContextMessage,
  AgentContextMemory,
  SummarizerInput,
  SummarizerInputMessage,
  SummarizerOutput,
  ContextShowOptions,
  ContextSyncOptions,
  ContextExportOptions,
  ContextImportOptions,
  ContextInjectionPayload,
} from './context-sync/types.js';
export {
  CONTEXT_MESSAGE_LIMIT,
  TOKEN_BUDGET_DEFAULT,
  TOKEN_BUDGET_MAX,
  TOKEN_BUDGET_MIN,
  MESSAGE_PREVIEW_MAX_CHARS,
  FILE_REF_RELEVANCE_MAX,
} from './context-sync/types.js';
