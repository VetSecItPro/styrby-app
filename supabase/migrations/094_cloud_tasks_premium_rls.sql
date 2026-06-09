-- Migration 094: Server-side premium-tier enforcement on cloud_tasks INSERT.
--
-- DEFECT CLOSED (PR-flagged by /launch audit + sec-ship):
--   Cloud Tasks is a PREMIUM feature (growth/power). The gate was UI-only:
--   the cloud_tasks INSERT RLS policy (migration 063) authorized ANY
--   authenticated user (WITH CHECK auth.uid() = user_id), with no tier check.
--   Because the INSERT is the dispatch trigger (the relay subscribes to
--   cloud_tasks and RUNS queued rows — see packages/styrby-cli/src/commands/
--   cloud.ts + packages/styrby-mobile/src/services/cloud-tasks.ts), a free or
--   pro user could bypass the UI and POST directly to /rest/v1/cloud_tasks to
--   run the paid feature. This adds the missing server-side entitlement gate.
--
-- ENTITLEMENT: premium = subscriptions.tier IN ('growth','power') AND
--   status = 'active'. This matches the rest of the app
--   (packages/styrby-web/src/lib/tier-enforcement.ts gates on status='active')
--   and the canonical model (docs/planning/styrby-tiers-canonical.md):
--     - growth = current premium tier
--     - power  = legacy premium (grandfathered; 1 live customer, status active)
--     - pro    = paid INDIVIDUAL tier — NOT premium, must NOT pass this gate
--     - free   = not premium
--   Verified against live production 2026-06-08: all 5 premium subscriptions
--   (1 power + 4 growth) are status='active', so no current customer is
--   affected by adding this check.
--
-- WHY a SECURITY DEFINER helper (not an inline subquery in WITH CHECK):
--   the policy must read `subscriptions`, which is itself RLS-protected. A
--   definer function with a pinned search_path reads it safely and keeps the
--   policy expression cheap + reusable. Mirrors the is_team_member pattern
--   (migration 090). NULL-safe: returns false for a NULL uid (defensive —
--   the policy's auth.uid()=user_id arm already excludes anon).
--
-- SCOPE: only the INSERT (dispatch) path is gated. SELECT/UPDATE/DELETE keep
--   their owner-only policies so a user who later downgrades can still VIEW,
--   CANCEL, and clean up tasks they already created — we gate creation of new
--   paid work, not management of existing rows. service_role inserts
--   (headless/relay infrastructure) bypass RLS entirely and are unaffected.
--
-- Governing: SOC2 CC6.1 (logical access enforcement at the data boundary).

-- 1. Premium-tier predicate (SECURITY DEFINER, reads RLS-protected subscriptions).
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
        AND tier IN ('growth', 'power')
        AND status = 'active'
    )
  END;
$function$;

GRANT EXECUTE ON FUNCTION public.user_has_premium_tier(uuid) TO authenticated;

COMMENT ON FUNCTION public.user_has_premium_tier(uuid) IS
  'Returns true if the user holds an ACTIVE premium subscription '
  '(tier growth or legacy power). NULL-safe. Used by the cloud_tasks INSERT '
  'RLS policy to enforce the premium entitlement server-side. Canonical tier '
  'model: docs/planning/styrby-tiers-canonical.md.';

-- 2. Replace the owner-only INSERT policy with owner + premium.
DROP POLICY IF EXISTS "cloud_tasks: owner insert" ON public.cloud_tasks;

CREATE POLICY "cloud_tasks: premium owner insert"
  ON public.cloud_tasks
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT auth.uid()) = user_id
    AND public.user_has_premium_tier((SELECT auth.uid()))
  );
