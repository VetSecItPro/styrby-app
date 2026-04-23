/**
 * Cost Forecasting Module — Phase 3.4
 *
 * Exports the pure-math forecasting functions and types that drive:
 *   - GET /api/costs/forecast (web API)
 *   - Nightly predictive alert pg_cron job (migration 038)
 *   - Web /dashboard/costs ForecastCard component
 *   - Mobile app/(tabs)/costs.tsx ForecastCard component
 *
 * WHY separate module from cost/: The forecast module depends only on
 * integer arithmetic and Date math — no Supabase types, no Zod schemas,
 * no billing-model concerns. Keeping it isolated ensures consumers can
 * import just the forecast math without pulling in the full cost-types
 * module (and its Zod dependency).
 *
 * @module cost-forecast
 */

export * from './forecast.js';
