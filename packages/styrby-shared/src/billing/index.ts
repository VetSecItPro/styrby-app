/**
 * Billing barrel — shared, dependency-free tier helpers.
 *
 * Web and mobile both consume these so a tier gating decision can never
 * disagree across surfaces (SOC2 CC6.1 logical access enforcement).
 *
 * @module billing
 */

export * from './tier-logic.js';
// NOTE: the legacy `polar-products.js` (team/business/enterprise per-seat
// pricing) was removed 2026-06-09 — billing math consolidated into the web
// canonical module `@/lib/billing/polar-products` keyed to the live
// 'pro' | 'growth' model. See backlog TIER-DRIFT-2 / BILLING-CONSOLIDATION.
export * from './manual-override.js';
