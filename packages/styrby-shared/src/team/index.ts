/**
 * Team governance barrel (Phase 2.1 + 2.2).
 *
 * Re-exports the types + role matrix + approval-chain evaluator used by
 * CLI, web, and mobile for Team/Business tier governance, plus the Phase 2.2
 * seat-cap validator and invite rate limiter.
 *
 * @module team
 */

export * from './types.js';
export * from './role-matrix.js';
export * from './approval-chain.js';
export * from './seat-cap.js';

// Phase 2.3 — admin UI types (member admin view, policy settings, founder team metrics)
export * from './admin-types.js';

// WHY invite-rate-limit is NOT re-exported from the barrel:
// It imports @upstash/redis (~20-30 KB gzipped), which would be transitively
// pulled into the web client bundle anywhere @styrby/shared is imported.
// This is server-only code (edge functions + Next.js route handlers) — the
// single server consumer should deep-import from '@styrby/shared/team/invite-rate-limit.js'.
// Matches the packages/styrby-shared/src/index.ts pattern established for
// pricing/litellm-pricing.ts (Node built-ins) in Phase 1.6.13.
// export * from './invite-rate-limit.js'; // INTENTIONALLY EXCLUDED
