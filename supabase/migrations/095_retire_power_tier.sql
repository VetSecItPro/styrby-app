-- Migration 095: Retire the 'power' tier.
--
-- CONTEXT (canonical model: docs/planning/styrby-tiers-canonical.md):
--   'power' was the pre-cutover premium tier, replaced by 'growth' in Phase 5.
--   It has ZERO real customers. The only row on tier='power' in production was
--   the internal admin comp account (vetsecitpro@gmail.com,
--   polar_customer_id='internal_admin', polar_subscription_id ending '_no_mrr',
--   period 2026-01-01 .. 2099-12-31). Keeping 'power' alive in code created
--   recurring confusion (every premium gate special-cased it) and inflated
--   founder MRR by ~$49 (the comp account was counted as a power customer).
--
-- THIS MIGRATION:
--   1. Migrates the admin comp account to 'growth' (the highest self-serve
--      tier) so it retains premium access without a dedicated tier value.
--   2. Drops 'power' from the cloud_tasks premium predicate
--      (user_has_premium_tier) — premium is now 'growth' only.
--
-- WHY 'power' is NOT removed from the subscription_tier enum:
--   Postgres cannot drop an enum value (no DROP VALUE; would require recreating
--   the type + rewriting every dependent column/policy). The value is left in
--   place but is now DEPRECATED and UNUSED — zero rows, zero code paths. The
--   one defensive bridge remaining is @styrby/shared normalizeTier('power') ->
--   'growth' (handles any stray historical string). New code must never write
--   or branch on 'power'.
--
-- SAFETY: idempotent. The UPDATE is scoped to the comp account and is a no-op
--   once migrated. The function is CREATE OR REPLACE. Verified: zero cloud_tasks
--   rows in prod, and the comp account is the only 'power' row.
--
-- Governing: SOC2 CC6.1 (consistent logical-access model) + metrics integrity.

-- 1. Migrate the internal admin comp account to the current premium tier.
UPDATE public.subscriptions
   SET tier = 'growth'
 WHERE tier = 'power'
   AND polar_customer_id = 'internal_admin';

-- 2. Premium = 'growth' only (drop legacy 'power' from the predicate).
CREATE OR REPLACE FUNCTION public.user_has_premium_tier(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN _user_id IS NULL THEN false
    ELSE EXISTS(
      SELECT 1 FROM public.subscriptions
      WHERE user_id = _user_id
        AND tier = 'growth'
        AND status = 'active'
    )
  END;
$function$;

COMMENT ON FUNCTION public.user_has_premium_tier(uuid) IS
  'Returns true if the user holds an ACTIVE growth subscription (the premium '
  'tier). NULL-safe. Used by the cloud_tasks INSERT RLS policy. The legacy '
  '''power'' tier was retired in migration 095 (zero customers); see '
  'docs/planning/styrby-tiers-canonical.md.';
