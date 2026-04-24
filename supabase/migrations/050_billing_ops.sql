-- ============================================================================
-- Migration 050: Billing Ops — Refund / Credit / Churn-Save (Phase 4.3 T1)
--
/**
 * Creates three billing-operations tables that back the admin refund, credit,
 * and churn-save workflows:
 *
 *   1. polar_refund_events  — idempotency dedup for Polar refund calls
 *   2. billing_credits      — manually-issued account credits applied at invoice
 *   3. churn_save_offers    — win-back offer lifecycle (sent → accepted/revoked)
 *
 * Security model (all three tables):
 *   - RLS enabled; deny-by-default.
 *   - polar_refund_events: service_role only (no app-level SELECT at all).
 *     Admins access refund history through the admin_audit_log (canonical view).
 *   - billing_credits / churn_save_offers: two SELECT policies each
 *     (self + site_admin). NO INSERT/UPDATE/DELETE policies — all mutations
 *     flow through SECURITY DEFINER wrappers (migration 051, T2).
 *   - INSERT/UPDATE/DELETE explicitly REVOKED from PUBLIC/authenticated/anon
 *     on all three tables (defense-in-depth against future GRANT regressions).
 *   - service_role retains ALL for webhook handlers and admin tooling.
 *
 * @soc2 CC6.1  Least-privilege: app roles cannot mutate billing tables directly.
 * @soc2 CC7.2  Logical access control enforced at database layer via RLS.
 * @soc2 CC9.2  Billing operations audited atomically with admin_audit_log writes.
 * @gdpr Art.5  Purpose limitation: polar_response_json and refund reason fields
 *              capture only the minimum data needed for dispute resolution and
 *              are service_role-access-only to limit exposure.
 */
-- ============================================================================

-- ============================================================================
-- §3.1  polar_refund_events — Idempotency dedup for Polar refund events
-- ============================================================================

/**
 * polar_refund_events
 *
 * Stores one row per successfully processed Polar refund event.  The PK is
 * Polar's own event_id string, which makes re-processing a webhook payload
 * a safe ON CONFLICT DO NOTHING operation (see admin_issue_refund wrapper
 * in migration 051).
 *
 * This table is intentionally opaque to all app roles:
 *   - Admins audit refunds via admin_audit_log (action = 'refund_issued').
 *   - Customers do not see refund events at all — Polar emails are the UX.
 *   - polar_response_json stores the raw Polar API response for dispute
 *     resolution; it may contain PII (card last4, billing address) so access
 *     is restricted to service_role only.
 *
 * FK design for actor_id / target_user_id:
 *   NO CASCADE — a deleted user must not silently remove the financial audit
 *   trail.  Matches the precedent set by admin_audit_log.actor_id (migration
 *   040) which also uses no cascade on admin references.  The FK will RESTRICT
 *   deletion if a refund row exists, prompting an explicit data-retention
 *   decision before account deletion.
 *
 * @soc2 CC9.2  Financial event record kept for dispute / chargeback defense.
 * @gdpr Art.5  Purpose limitation — polar_response_json restricted to
 *              service_role; never surfaced to authenticated callers.
 */
CREATE TABLE public.polar_refund_events (
  -- WHY text PK: Polar event IDs are UUID-format strings but not Postgres UUIDs;
  -- using text avoids a lossy cast and preserves the exact string Polar sends,
  -- which is what we echo back in idempotency dedup (ON CONFLICT on event_id).
  event_id              text        PRIMARY KEY,
  refund_id             text        NOT NULL,
  -- WHY nullable: subscription_id is absent for one-time (non-subscription) charges.
  subscription_id       text,
  amount_cents          bigint      NOT NULL,
  currency              text        NOT NULL DEFAULT 'usd',
  -- WHY NOT NULL: reason is required by our admin wrapper (see migration 051);
  -- an empty reason would compromise the audit trail.
  reason                text        NOT NULL,
  -- WHY no ON DELETE CASCADE: preserve refund audit trail if user is deleted.
  -- Matches admin_audit_log granted_by precedent (migration 040, §3.1 comment).
  actor_id              uuid        NOT NULL REFERENCES auth.users(id),
  target_user_id        uuid        NOT NULL REFERENCES auth.users(id),
  processed_at          timestamptz NOT NULL DEFAULT now(),
  -- WHY nullable: polar_response_json is populated after a successful Polar API
  -- call.  Storing NULL here indicates the refund event came from a webhook
  -- without a synchronous response snapshot (future-proof path).
  polar_response_json   jsonb
);

-- WHY composite index (target_user_id, processed_at DESC):
--   Admin dossier page queries refunds by target user, ordered newest-first.
--   The composite covering index avoids a table scan on the common filter path.
CREATE INDEX idx_polar_refund_events_target
  ON public.polar_refund_events (target_user_id, processed_at DESC);

-- WHY composite index (actor_id, processed_at DESC):
--   Supports audit queries like "show me all refunds issued by admin X today."
--   actor_id alone would require a filesort for the time-ordered display.
CREATE INDEX idx_polar_refund_events_actor
  ON public.polar_refund_events (actor_id, processed_at DESC);

ALTER TABLE public.polar_refund_events ENABLE ROW LEVEL SECURITY;

-- WHY no SELECT/INSERT/UPDATE/DELETE policies:
--   service_role bypasses RLS entirely.  For app-role callers the deny-by-default
--   table-level REVOKE below is the effective gate.  No business requirement exists
--   for authenticated callers to read this table — refund history is surfaced via
--   the admin_audit_log join in the admin dossier (migration 041 wrapper pattern).
REVOKE ALL ON public.polar_refund_events FROM PUBLIC, authenticated, anon;
GRANT ALL ON public.polar_refund_events TO service_role;

-- ============================================================================
-- §3.2  billing_credits — Manually-issued credits applied at next invoice
-- ============================================================================

/**
 * billing_credits
 *
 * Records one row per manually-issued account credit.  Credits remain in
 * "unapplied" state (applied_at IS NULL) until the billing webhook confirms
 * that Polar has applied them to an invoice, at which point the wrapper
 * (migration 051) sets applied_at and applied_to_polar_invoice_id.
 *
 * Lifecycle states (enforced in wrappers, reflected in partial index):
 *   unapplied : applied_at IS NULL AND revoked_at IS NULL
 *   applied   : applied_at IS NOT NULL
 *   revoked   : revoked_at IS NOT NULL AND applied_at IS NULL
 *
 * FK design:
 *   user_id  → ON DELETE CASCADE: the credit belongs to the user; if the user
 *              account is deleted during GDPR erasure, delete the credit record
 *              with it.  Credits with applied_at IS NOT NULL represent completed
 *              financial transactions; the admin_audit_log row is the durable
 *              financial record for those.
 *   granted_by → no CASCADE: preserves the grant attribution even if the admin
 *              account is later removed.  Matches polar_refund_events pattern above.
 *
 * @soc2 CC6.1  Only service_role can mutate; app layer reads via SELECT policies.
 * @soc2 CC9.2  Every credit grant + revoke audited in admin_audit_log (wrapper).
 * @gdpr Art.5  reason field limited to admin-supplied justification text;
 *              no session content or message data stored.
 */
CREATE TABLE public.billing_credits (
  id                          bigserial   PRIMARY KEY,
  user_id                     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- WHY amount_cents > 0: credits can never be zero or negative; a zero-value
  -- credit is a no-op and a negative value would be a charge disguised as a credit.
  amount_cents                bigint      NOT NULL CHECK (amount_cents > 0),
  currency                    text        NOT NULL DEFAULT 'usd',
  -- WHY btrim(reason): prevent a credit with reason = '   ' (whitespace-only)
  -- from passing the check, which would create an empty audit trail entry.
  reason                      text        NOT NULL CHECK (length(btrim(reason)) > 0),
  -- WHY no ON DELETE CASCADE on granted_by: if the admin who issued the credit
  -- is later removed, we must retain the grant record with its attribution.
  -- A dangling FK is acceptable here; the admin_audit_log row provides durable
  -- attribution even if the auth.users row is gone.
  granted_by                  uuid        NOT NULL REFERENCES auth.users(id),
  granted_at                  timestamptz NOT NULL DEFAULT now(),
  -- WHY nullable: applied_at is set only when Polar confirms invoice application.
  -- NULL = unapplied; non-null = applied (see lifecycle states above).
  applied_at                  timestamptz,
  applied_to_polar_invoice_id text,
  -- WHY nullable: expires_at is optional; a NULL value means the credit does
  -- not expire (e.g. a permanent goodwill credit vs a 1-year promotional credit).
  expires_at                  timestamptz,
  -- WHY nullable: revoked_at is set by admin_revoke_credit wrapper (migration 051).
  -- Revocation is only permitted while applied_at IS NULL (unapplied state).
  revoked_at                  timestamptz
);

-- WHY partial index (applied_at IS NULL AND revoked_at IS NULL):
--   The primary read path is "fetch all unapplied, un-revoked credits for user X."
--   A full index on (user_id, granted_at) would include historical applied credits
--   that are never queried this way.  The partial index is smaller and faster for
--   the hot path.  The DESC on granted_at surfaces the most recent credit first
--   in admin dossier and user billing views.
CREATE INDEX idx_billing_credits_user_unapplied
  ON public.billing_credits (user_id, granted_at DESC)
  WHERE applied_at IS NULL AND revoked_at IS NULL;

ALTER TABLE public.billing_credits ENABLE ROW LEVEL SECURITY;

-- WHY subquery form "(SELECT auth.uid())" instead of "auth.uid()":
--   Postgres can cache the subquery result across rows in the same query plan,
--   reducing function-call overhead on scans of this table (Supabase pattern,
--   matches all prior migrations 020-049).
CREATE POLICY billing_credits_select_self ON public.billing_credits
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY billing_credits_select_admin ON public.billing_credits
  FOR SELECT TO authenticated
  USING (public.is_site_admin((SELECT auth.uid())));

-- WHY REVOKE INSERT/UPDATE/DELETE:
--   No DML policies exist; without explicit REVOKE, a misconfigured GRANT at
--   the schema level could silently open a write path.  Defense-in-depth.
REVOKE INSERT, UPDATE, DELETE ON public.billing_credits FROM PUBLIC, authenticated, anon;
GRANT ALL ON public.billing_credits TO service_role;
GRANT ALL ON SEQUENCE public.billing_credits_id_seq TO service_role;

-- ============================================================================
-- §3.3  churn_save_offers — Win-back offer lifecycle
-- ============================================================================

/**
 * churn_offer_kind
 *
 * Enum constraining the two supported win-back offer types.  Using an enum
 * (vs a plain text column with a CHECK) makes the kind value explicit in query
 * plans and prevents typos from reaching the DB.
 *
 * Values:
 *   annual_3mo_25pct   — 25% off for 3 months, targeting annual-plan churners
 *   monthly_1mo_50pct  — 50% off for 1 month, targeting monthly-plan churners
 *
 * WHY separate enum instead of deriving from the subscriptions.tier:
 *   Offer kind is a business decision that may differ from the current tier.
 *   An annual subscriber who has already downgraded to monthly still gets the
 *   'annual_3mo_25pct' offer if that is what the admin chooses to send.
 */
CREATE TYPE public.churn_offer_kind AS ENUM (
  'annual_3mo_25pct',
  'monthly_1mo_50pct'
);

/**
 * churn_save_offers
 *
 * Records the full lifecycle of a churn-save (win-back) offer:
 *   sent     : row created by admin_send_churn_save_offer (migration 051 wrapper)
 *   active   : accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
 *   accepted : accepted_at IS NOT NULL (user clicked Accept within expiry window)
 *   expired  : expires_at <= now() AND accepted_at IS NULL AND revoked_at IS NULL
 *   revoked  : revoked_at IS NOT NULL (admin cancelled before user accepted)
 *
 * FK design:
 *   user_id  → ON DELETE CASCADE: same rationale as billing_credits.user_id.
 *   sent_by  → no CASCADE: preserve offer attribution if admin account removed.
 *
 * Composite CHECK binding kind ↔ discount_pct + discount_duration_months:
 *   WHY: The individual CHECKs on pct (25|50) and duration (1|3) prevent
 *   individually-invalid values, but do not prevent a malformed combination like
 *   (kind='annual_3mo_25pct', discount_pct=50, duration=3) that passes each
 *   individual check.  The composite CHECK closes this gap, ensuring pct and
 *   duration are always derived from kind — not set independently by a caller.
 *   This is the server-side enforcement of the spec §2 threat: "Churn-save offer
 *   code tampered — discount_pct hardcoded server-side, user never sees other values."
 *
 * @soc2 CC6.1  Service-role-only mutations; app reads via SELECT policies.
 * @soc2 CC9.2  Every offer send/accept/revoke audited in admin_audit_log.
 * @gdpr Art.5  reason field limited to admin-supplied justification; no
 *              user content exposed.
 */
CREATE TABLE public.churn_save_offers (
  id                      bigserial           PRIMARY KEY,
  user_id                 uuid                NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind                    public.churn_offer_kind NOT NULL,
  -- WHY NOT NULL integers (not derived from kind at read time):
  --   Storing pct and duration explicitly preserves the offer terms even if the
  --   enum definition changes in a future migration.  The composite CHECK below
  --   ensures they are always consistent with kind at write time.
  discount_pct            int                 NOT NULL,
  discount_duration_months int                NOT NULL,
  -- WHY no ON DELETE CASCADE on sent_by: preserve offer attribution if admin removed.
  sent_by                 uuid                NOT NULL REFERENCES auth.users(id),
  sent_at                 timestamptz         NOT NULL DEFAULT now(),
  -- WHY NOT NULL: every offer must have an expiry; an offer with no expiry is
  -- effectively a permanent discount, which is a billing liability.
  -- The wrapper sets expires_at = now() + interval '7 days' (spec §3.3).
  expires_at              timestamptz         NOT NULL,
  accepted_at             timestamptz,
  revoked_at              timestamptz,
  -- WHY nullable: polar_discount_code is created server-side via Polar API when
  -- the admin sends the offer.  May be NULL if Polar call is deferred or fails.
  polar_discount_code     text,
  reason                  text                NOT NULL,

  -- CHECK 1: discount_pct must be one of the two valid values.
  CONSTRAINT churn_save_offers_pct_valid
    CHECK (discount_pct IN (25, 50)),

  -- CHECK 2: duration must be one of the two valid values.
  CONSTRAINT churn_save_offers_duration_valid
    CHECK (discount_duration_months IN (1, 3)),

  -- CHECK 3 (composite): kind ↔ pct + duration must be internally consistent.
  -- WHY: CHECKs 1 and 2 allow (pct=25, duration=1) or (pct=50, duration=3) —
  -- combinations that pass each individual check but do not correspond to any
  -- valid offer kind.  This composite CHECK closes the gap by requiring that
  -- kind, pct, and duration are always a coherent triple.  It is the DB-layer
  -- enforcement of the "server-side hardcoding" threat mitigation in §2.
  CONSTRAINT churn_save_offers_kind_coherent
    CHECK (
      (kind = 'annual_3mo_25pct'  AND discount_pct = 25 AND discount_duration_months = 3) OR
      (kind = 'monthly_1mo_50pct' AND discount_pct = 50 AND discount_duration_months = 1)
    )
);

-- WHY partial index (accepted_at IS NULL AND revoked_at IS NULL):
--   The hot path is "find active offers for this user" — used by the acceptance
--   page (user_accept_churn_save_offer wrapper) and the admin dossier "active
--   offer" badge.  Filtering out accepted/revoked rows keeps the index small;
--   historical offers are queried infrequently (full-table path acceptable).
--   DESC on expires_at surfaces the soonest-expiring active offer first, which
--   is the natural display order for the admin dossier.
CREATE INDEX idx_churn_save_offers_user_active
  ON public.churn_save_offers (user_id, expires_at DESC)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

ALTER TABLE public.churn_save_offers ENABLE ROW LEVEL SECURITY;

CREATE POLICY churn_save_offers_select_self ON public.churn_save_offers
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY churn_save_offers_select_admin ON public.churn_save_offers
  FOR SELECT TO authenticated
  USING (public.is_site_admin((SELECT auth.uid())));

-- WHY REVOKE INSERT/UPDATE/DELETE (same rationale as billing_credits):
--   Defense-in-depth against future GRANT regressions.  All mutations must
--   flow through SECURITY DEFINER wrappers in migration 051.
REVOKE INSERT, UPDATE, DELETE ON public.churn_save_offers FROM PUBLIC, authenticated, anon;
GRANT ALL ON public.churn_save_offers TO service_role;
GRANT ALL ON SEQUENCE public.churn_save_offers_id_seq TO service_role;

-- ============================================================================
-- §3.4  NOTE: audit_action enum extension intentionally OMITTED
-- ============================================================================
-- WHY: admin_audit_log.action (migration 040) is typed as text CHECK
--   (action ~ '^[a-z_]+$'), NOT the audit_action enum.  The audit_action enum
--   belongs to the legacy audit_log table (migration 028).  Phase 4.3 wrappers
--   (migration 051) write to admin_audit_log with text action values
--   ('refund_issued', 'credit_issued', 'credit_revoked', 'churn_save_sent',
--   'churn_save_accepted', 'churn_save_revoked') — no ALTER TYPE needed.
-- ============================================================================
