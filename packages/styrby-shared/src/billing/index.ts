/**
 * Billing barrel — shared, dependency-free tier helpers.
 *
 * Web and mobile both consume these so a tier gating decision can never
 * disagree across surfaces (SOC2 CC6.1 logical access enforcement).
 *
 * @module billing
 */

export * from './tier-logic.js';
export * from './polar-products.js';
