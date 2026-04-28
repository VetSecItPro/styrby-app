/**
 * Polar environment variable validation and product ID accessor.
 *
 * This module is the single cold-start guard for all Polar configuration.
 * It must be called from the webhook route handler's module scope so that a
 * missing env var causes the edge function to fail loudly at startup — before
 * Polar can deliver any event — rather than silently mis-routing subscription
 * state mid-flight.
 *
 * WHY validate at startup (not per-request): if a product ID env var is
 * missing, every inbound webhook event for that tier will fall through the
 * product-ID resolver with `undefined`, returning `null` and silently
 * discarding the event. The billing state becomes stale with no error logged
 * at the point of failure. A cold-start throw surfaces the misconfiguration
 * immediately in Vercel's function logs before any customer is affected.
 *
 * WHY Zod (not manual if-chains): Zod gives us a structured ZodError with
 * one message per missing/invalid field, making the log line actionable.
 * Manual if-chains would stop at the first failure and hide the rest.
 *
 * WHY the values are NEVER logged: POLAR_ACCESS_TOKEN and
 * POLAR_WEBHOOK_SECRET are secrets. Logging them — even on error — would
 * write them into Vercel's log aggregation, which has different access
 * controls than the application itself. Product IDs are not secrets, but
 * logging the token alongside them creates a log line that is partially
 * secret, which is ambiguous for log-scrubbing tooling.
 *
 * SOC2 CC7.2: Startup validation is a preventive control for billing
 * integrity. A missing Polar product ID is a configuration error that could
 * lead to incorrect tier assignments, which are material billing events.
 *
 * OWASP ASVS V14.1: Environment configuration hygiene — required values must
 * be verified to exist before the application enters a serving state.
 *
 * @module lib/polar-env
 */

import { z } from 'zod';
// WHY no .js extension: polar-env.ts is imported by Next.js route handlers which
// run through webpack (moduleResolution: "bundler"). Webpack cannot resolve
// explicit .js extensions for TypeScript source files — it expects the import
// to omit the extension (or use .ts). The .js extension is ESM/Node convention
// for pre-compiled output but is a webpack foot-gun in mixed Next.js projects.
import { getEnv } from './env';

// ============================================================================
// Types
// ============================================================================

/**
 * Billable tier — any tier that maps to a Polar product ID.
 *
 * Includes both the legacy team-pricing tiers (`team`, `business`) and the
 * post-cutover canonical tiers (`pro`, `growth`). Enterprise is excluded
 * because enterprise deals use bespoke Polar orders, not catalog products.
 *
 * WHY all four are kept: the resolver is bidirectional. Legacy product IDs
 * still exist in Vercel env scopes for backward compatibility during the
 * cutover. Removing them would break any in-flight subscription whose
 * Polar product is still under the legacy schema. Adding `pro` + `growth`
 * fixes the e2e finding where the team-path resolver returned null for
 * Growth product IDs, causing 422 + audit-log noise on every Growth
 * subscription event.
 *
 * Historical name retained ("TeamBillingTier") to avoid touching every
 * consumer in this PR; a future rename to `BillingTier` is tracked
 * separately in the legacy-shim cleanup task.
 */
export type TeamBillingTier = 'team' | 'business' | 'pro' | 'growth';

/**
 * Billing cycle for per-seat subscriptions.
 */
export type BillingCycle = 'monthly' | 'annual';

// ============================================================================
// Zod schema — validates all required Polar env vars at once
// ============================================================================

/**
 * Zod schema for the six required Polar environment variables.
 *
 * WHY non-empty string (.min(1)): process.env values can be set to an
 * empty string by some deployment platforms (notably, Vercel treats an
 * env var with no value as an empty string, not undefined). An empty
 * string would pass a plain z.string() check but would cause the HMAC
 * to use an empty key, making every signature trivially bypassable.
 *
 * WHY the schema only reads from process.env via a local snapshot (not
 * getEnv()): Zod schema .parse() is called once at cold-start, not per
 * request, so we don't need getEnv()'s whitespace trimming here —
 * process.env values on Vercel are already trimmed. We use getEnv()
 * only in getPolarProductId() where we need the trimmed runtime value.
 */
const PolarEnvSchema = z.object({
  POLAR_ACCESS_TOKEN: z.string().min(1),
  POLAR_WEBHOOK_SECRET: z.string().min(1),
  POLAR_TEAM_MONTHLY_PRODUCT_ID: z.string().min(1),
  POLAR_TEAM_ANNUAL_PRODUCT_ID: z.string().min(1),
  POLAR_BUSINESS_MONTHLY_PRODUCT_ID: z.string().min(1),
  POLAR_BUSINESS_ANNUAL_PRODUCT_ID: z.string().min(1),
});

// ============================================================================
// Validation
// ============================================================================

/**
 * Validates that all required Polar environment variables are present and
 * non-empty. Throws a descriptive error at cold-start if any are missing.
 *
 * Call this once at module scope in the webhook route file so that a
 * misconfigured deployment fails immediately rather than silently discarding
 * billing events.
 *
 * NEVER logs the values of any variables — secrets must not appear in logs.
 * On failure, only the variable NAMES are included in the error message.
 *
 * @throws {Error} When one or more required Polar env vars are missing or blank.
 *
 * @example
 * ```ts
 * // At the top of packages/styrby-web/src/app/api/webhooks/polar/route.ts
 * import { validatePolarEnv } from '@/lib/polar-env';
 * validatePolarEnv(); // throws at cold-start if misconfigured
 * ```
 */
export function validatePolarEnv(): void {
  // Build a snapshot of only the vars we need — do NOT spread all of process.env.
  // Spreading process.env would include secrets from other services in the
  // Zod parse input, which could appear in error messages on validation failure.
  const snapshot = {
    POLAR_ACCESS_TOKEN: process.env.POLAR_ACCESS_TOKEN,
    POLAR_WEBHOOK_SECRET: process.env.POLAR_WEBHOOK_SECRET,
    POLAR_TEAM_MONTHLY_PRODUCT_ID: process.env.POLAR_TEAM_MONTHLY_PRODUCT_ID,
    POLAR_TEAM_ANNUAL_PRODUCT_ID: process.env.POLAR_TEAM_ANNUAL_PRODUCT_ID,
    POLAR_BUSINESS_MONTHLY_PRODUCT_ID: process.env.POLAR_BUSINESS_MONTHLY_PRODUCT_ID,
    POLAR_BUSINESS_ANNUAL_PRODUCT_ID: process.env.POLAR_BUSINESS_ANNUAL_PRODUCT_ID,
  };

  const result = PolarEnvSchema.safeParse(snapshot);

  if (!result.success) {
    // Extract only the field names from the Zod error — never the values.
    const missingVars = result.error.errors
      .map((e) => e.path.join('.'))
      .join(', ');

    // WHY not console.error here: this throws synchronously at cold-start.
    // Vercel will surface the uncaught error in function logs with full stack.
    // A console.error before the throw would be redundant.
    throw new Error(
      `Polar configuration error: the following environment variables are missing or blank: ${missingVars}. ` +
        'Add them in Vercel Dashboard > Project Settings > Environment Variables.'
    );
  }
}

// ============================================================================
// Product ID lookup
// ============================================================================

/**
 * Mapping from tier+cycle tuple to the environment variable NAME that holds
 * the Polar product ID for that combination.
 *
 * WHY a lookup table (not a switch): the four combinations are enumerable and
 * static. A lookup table is exhaustive by construction — adding a new tier
 * requires adding a row here, which is immediately visible. A switch with a
 * default case can silently fall through if a case is missed.
 *
 * WHY the env var NAMES are in source code but not the VALUES: names are not
 * secrets and are stable across environments. Values (the actual Polar UUIDs)
 * differ between test mode and live mode — keeping them out of source forces
 * correct parameterisation per environment.
 */
const PRODUCT_ID_ENV_VAR_MAP: Record<TeamBillingTier, Record<BillingCycle, string>> = {
  team: {
    monthly: 'POLAR_TEAM_MONTHLY_PRODUCT_ID',
    annual: 'POLAR_TEAM_ANNUAL_PRODUCT_ID',
  },
  business: {
    monthly: 'POLAR_BUSINESS_MONTHLY_PRODUCT_ID',
    annual: 'POLAR_BUSINESS_ANNUAL_PRODUCT_ID',
  },
  pro: {
    monthly: 'POLAR_PRO_MONTHLY_PRODUCT_ID',
    annual: 'POLAR_PRO_ANNUAL_PRODUCT_ID',
  },
  growth: {
    monthly: 'POLAR_GROWTH_MONTHLY_PRODUCT_ID',
    annual: 'POLAR_GROWTH_ANNUAL_PRODUCT_ID',
  },
};

/**
 * Returns the Polar product ID value for the given tier and billing cycle.
 *
 * Reads from environment variables at call time (not cached) so that the value
 * reflects any runtime injection. Returns an empty string if the env var is
 * unset — callers must treat an empty return as a configuration error.
 *
 * IMPORTANT: `validatePolarEnv()` must be called at module scope before this
 * function is ever called in production. That call guarantees all four product
 * ID env vars are non-empty. This function does not re-validate for performance
 * (it is called on every webhook event).
 *
 * @param tier - The billing tier: 'team' or 'business'.
 * @param cycle - The billing cycle: 'monthly' or 'annual'.
 * @returns The Polar product ID string from the matching env var.
 *
 * @example
 * ```ts
 * const id = getPolarProductId('team', 'annual');
 * // Returns process.env.POLAR_TEAM_ANNUAL_PRODUCT_ID (trimmed)
 * ```
 */
export function getPolarProductId(tier: TeamBillingTier, cycle: BillingCycle): string {
  const envVarName = PRODUCT_ID_ENV_VAR_MAP[tier][cycle];
  // WHY getEnv(): strips whitespace including paste-from-dashboard newlines.
  // See lib/env.ts for the production incident that motivated this helper.
  return getEnv(envVarName) ?? '';
}

/**
 * Reverse-maps a Polar product ID to the tier and cycle it represents.
 *
 * Used by the webhook handler to resolve an inbound subscription's product ID
 * back to (tier, cycle) without a Polar API call.
 *
 * WHY null on miss (not a thrown error): an unrecognized product ID is a
 * semantic error, not a programming error. The webhook handler converts a null
 * result into a 422 response with an audit_log entry, allowing operations to
 * investigate without crashing the process.
 *
 * @param productId - The Polar product ID from the webhook payload.
 * @returns The tier+cycle pair, or null if the ID is unrecognized.
 *
 * @example
 * ```ts
 * const mapping = resolvePolarProductId('prod_abc123');
 * if (!mapping) { return NextResponse.json({ error: 'Unknown product' }, { status: 422 }); }
 * const { tier, cycle } = mapping;
 * ```
 */
export function resolvePolarProductId(
  productId: string
): { tier: TeamBillingTier; cycle: BillingCycle } | null {
  if (!productId) return null;

  // Iterate ALL tiers (both legacy team/business and canonical pro/growth)
  // so that subscription events using new-tier product IDs resolve correctly
  // in the team-path code at /api/webhooks/polar/route.ts. Without this,
  // every Growth subscription event returned 422 with "unknown product_id"
  // because the resolver only knew about the pre-cutover schema.
  const tiers: TeamBillingTier[] = ['team', 'business', 'pro', 'growth'];
  const cycles: BillingCycle[] = ['monthly', 'annual'];

  for (const tier of tiers) {
    for (const cycle of cycles) {
      if (getPolarProductId(tier, cycle) === productId) {
        return { tier, cycle };
      }
    }
  }

  return null;
}
