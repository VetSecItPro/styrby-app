/**
 * Privacy utilities barrel export.
 *
 * Exports pure TypeScript helpers for computing session retention windows.
 * These mirror the PL/pgSQL functions in migration 025 to allow client-side
 * code (web/mobile) to display "this session will be deleted on <DATE>"
 * without a DB round-trip.
 *
 * Audit: GDPR Art. 5(1)(e) — storage limitation; SOC2 CC7.2
 *
 * @module privacy
 */

export * from './retention.js';
