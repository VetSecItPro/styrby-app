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
export * from './invite-rate-limit.js';
