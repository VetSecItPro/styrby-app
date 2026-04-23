/**
 * Team Checkout Page — /checkout/team
 *
 * Server Component that renders a billing summary and checkout CTA for
 * per-seat team plans (Team and Business tiers). Enterprise tier is
 * excluded from self-service and routes to the sales flow instead.
 *
 * WHY a Server Component (not a client component with useEffect):
 *   All validation logic runs server-side before a single byte of HTML is
 *   rendered. A client component would fetch this data after hydration,
 *   creating a flash of unvalidated content and allowing client-tampering.
 *   Server components short-circuit to error UI on invalid params — no
 *   client JavaScript runs at all for bad requests.
 *
 * Query params:
 *   team_id  — UUID of the team being upgraded
 *   tier     — 'team' | 'business'  (enterprise not self-service)
 *   cycle    — 'monthly' | 'annual'
 *   seats    — integer (must pass validateSeatCount for the tier)
 *
 * Flow:
 *   1. Parse + validate query params (server-side, no trust of client input)
 *   2. Authenticate caller via Supabase cookie session
 *   3. Confirm caller is owner OR admin of the team
 *   4. Compute summary totals via calculateMonthlyCostCents / calculateAnnualCostCents
 *   5. Render summary + CTA (CTA posts to /api/billing/checkout)
 *   6. On return from Polar (success callback), webhook (Unit B) updates seat_cap
 *
 * NEVER trust client-supplied values — all billing decisions are server-side
 * with JWT-authenticated user context (OWASP ASVS V4.2.1).
 *
 * SOC2 CC6.1: Access control is enforced before rendering any billing UI.
 * SOC2 CC7.2: Pricing math uses the canonical shared module so web and
 *   webhook can never disagree on cost calculations.
 *
 * @module app/checkout/team/page
 */

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import {
  TIER_DEFINITIONS,
  validateSeatCount,
  calculateMonthlyCostCents,
  calculateAnnualCostCents,
  type BillableTier,
} from '@styrby/shared/billing';
import { TeamCheckoutSummary } from './TeamCheckoutSummary';
import type { BillingCycle } from '@/lib/polar-env';

// ============================================================================
// Validation helpers
// ============================================================================

/**
 * Returns true when `value` is one of the two self-service team tiers.
 *
 * WHY not 'enterprise': enterprise deals are negotiated custom by the sales
 * team; we never funnel enterprise prospects into the self-service checkout.
 *
 * @param value - Raw query param string
 * @returns true if value is 'team' or 'business'
 */
function isSelfServiceTier(value: string | undefined): value is Extract<BillableTier, 'team' | 'business'> {
  return value === 'team' || value === 'business';
}

/**
 * Returns true when `value` is a valid billing cycle string.
 *
 * @param value - Raw query param string
 * @returns true if value is 'monthly' or 'annual'
 */
function isBillingCycle(value: string | undefined): value is BillingCycle {
  return value === 'monthly' || value === 'annual';
}

// ============================================================================
// Types
// ============================================================================

/**
 * Parsed and validated search params — safe to use in render.
 */
interface ValidatedCheckoutParams {
  teamId: string;
  tier: Extract<BillableTier, 'team' | 'business'>;
  cycle: BillingCycle;
  seats: number;
}

/**
 * Team record fetched from Supabase for permission check.
 */
interface TeamRecord {
  id: string;
  name: string;
}

// ============================================================================
// Page component
// ============================================================================

/**
 * Next.js App Router page props — searchParams is always a Promise in Next 15.
 */
type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * Server Component for the team checkout page.
 *
 * Validates params, authenticates the caller, checks team admin membership,
 * then renders the pricing summary with a POST form targeting /api/billing/checkout.
 *
 * @param props - Next.js page props including searchParams Promise
 * @returns The checkout summary page, or redirects to /pricing on any error
 */
export default async function TeamCheckoutPage({ searchParams }: PageProps) {
  // ── Step 1: Parse + validate query params ──────────────────────────────────

  // WHY await searchParams: Next 15 made searchParams a Promise in Server
  // Components to allow streaming; we must await before reading.
  const params = await searchParams;

  const rawTeamId = typeof params.team_id === 'string' ? params.team_id : undefined;
  const rawTier = typeof params.tier === 'string' ? params.tier : undefined;
  const rawCycle = typeof params.cycle === 'string' ? params.cycle : undefined;
  const rawSeats = typeof params.seats === 'string' ? params.seats : undefined;

  // UUID pattern guard — prevents directory-traversal style injection
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!rawTeamId || !UUID_PATTERN.test(rawTeamId)) {
    redirect('/pricing');
  }

  if (!isSelfServiceTier(rawTier)) {
    // WHY redirect to /pricing (not 400): this is a page render, not an API
    // call. A 400 has no meaning in Next.js Server Component context; redirect
    // is the correct UX response to a bad URL.
    redirect('/pricing');
  }

  if (!isBillingCycle(rawCycle)) {
    redirect('/pricing');
  }

  const seatsParsed = rawSeats !== undefined ? parseInt(rawSeats, 10) : NaN;
  if (!Number.isInteger(seatsParsed)) {
    redirect('/pricing');
  }

  const seatValidation = validateSeatCount(rawTier, seatsParsed);
  if (!seatValidation.ok) {
    redirect('/pricing');
  }

  const validated: ValidatedCheckoutParams = {
    teamId: rawTeamId,
    tier: rawTier,
    cycle: rawCycle,
    seats: seatsParsed,
  };

  // ── Step 2: Authenticate caller ───────────────────────────────────────────

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    // WHY redirect to /login (not an error page): unauthenticated users
    // should complete sign-in and return to checkout. preserve=false is fine
    // here because the URL contains all the state needed to reconstruct the page.
    redirect('/login');
  }

  // ── Step 3: Verify caller is owner or admin of the team ───────────────────

  const { data: membership, error: membershipError } = await supabase
    .from('team_members')
    .select('role')
    .eq('team_id', validated.teamId)
    .eq('user_id', user.id)
    .single();

  if (membershipError || !membership) {
    // User is not a member of this team at all — redirect, don't 403.
    // WHY redirect, not error: exposing a 403 on checkout would confirm that a
    // team_id exists for an unauthorized user (enumeration oracle).
    redirect('/dashboard');
  }

  if (membership.role !== 'owner' && membership.role !== 'admin') {
    redirect('/dashboard');
  }

  // Fetch team name for display
  const { data: team, error: teamError } = await supabase
    .from('teams')
    .select('id, name')
    .eq('id', validated.teamId)
    .single() as { data: TeamRecord | null; error: unknown };

  if (teamError || !team) {
    redirect('/dashboard');
  }

  // ── Step 4: Compute pricing summary ──────────────────────────────────────

  const tierDef = TIER_DEFINITIONS[validated.tier];
  const monthlyCents = calculateMonthlyCostCents(validated.tier, validated.seats);
  const annualCents = calculateAnnualCostCents(validated.tier, validated.seats);

  // Annual savings = what 12 months costs monthly vs annual price
  // Both values are already integer cents
  const annualSavingsCents = validated.cycle === 'annual'
    ? (monthlyCents * 12) - annualCents
    : 0;

  // ── Step 5: Render ─────────────────────────────────────────────────────────

  return (
    <TeamCheckoutSummary
      teamId={validated.teamId}
      teamName={team.name}
      tier={validated.tier}
      cycle={validated.cycle}
      seats={validated.seats}
      seatPriceCents={tierDef.seatPriceCents}
      monthlyCents={monthlyCents}
      annualCents={annualCents}
      annualSavingsCents={annualSavingsCents}
      minSeats={tierDef.minSeats}
    />
  );
}
