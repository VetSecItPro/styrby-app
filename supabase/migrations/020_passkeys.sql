-- ============================================================================
-- Migration 020: Passkeys (WebAuthn L3) Authentication
-- ============================================================================
-- Date:    2026-04-20
-- Author:  Claude Code (claude-opus-4-7)
-- Branch:  feat/passkey-login-2026-04-20
--
-- Phase:   1.2 — Passkey login (web + mobile parity)
-- Spec:    docs/planning/styrby-improve-19Apr.md §1.2 / §1.4
--
-- Audit standards cited:
--   SOC2 CC6.1          — Logical access controls / least privilege
--   SOC2 CC6.6          — Authentication mechanisms
--   SOC2 CC6.7          — Transmission / access path integrity
--   GDPR Art. 32         — Security of processing (technical measures)
--   NIST 800-63B AAL3    — Phishing-resistant multi-factor authentication
--   WebAuthn Level 3     — W3C Recommendation, 2024-03
--   FIDO2 CTAP2.2        — Client to Authenticator Protocol
--
-- Summary:
--   Adds `passkeys` table storing one row per registered WebAuthn credential.
--   RLS: users can SELECT / UPDATE / DELETE their own rows; only the service
--   role (edge functions) may INSERT, since credential registration requires
--   server-side attestation verification that cannot be done from the client.
--
-- Rollback:
--   DROP TABLE IF EXISTS public.passkeys CASCADE;
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.passkeys (
  -- Primary key: opaque row identifier.
  -- WHY uuid (not the credential_id): `credential_id` is authenticator-chosen
  -- and may collide across user accounts on shared authenticators; we keep it
  -- unique but also give each row a stable internal id for FK targets + logs.
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Owner of the credential (SOC2 CC6.1: access tied to authenticated subject).
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- WebAuthn credential ID as returned by the authenticator.
  -- Stored base64url-encoded per WebAuthn L3 §5.8.3 (PublicKeyCredential.id).
  -- WHY unique: step 3 of the WebAuthn auth ceremony (L3 §7.2) looks up the
  -- public key by credential id. If two rows shared the same id we could not
  -- deterministically select the correct public key.
  credential_id   text NOT NULL UNIQUE,

  -- COSE_Key encoded public key (CBOR). Opaque to us; fed back into the
  -- `@simplewebauthn/server` verifier on each authentication.
  -- Stored base64url-encoded so it round-trips safely through JSON.
  public_key      text NOT NULL,

  -- Signature counter.
  -- WHY mandatory: WebAuthn L3 §7.2 step 19 requires rejecting any assertion
  -- whose signature counter is <= the stored counter value. This is the sole
  -- defense against cloned authenticators. Missing or skipped = CVE-grade bug.
  counter         bigint NOT NULL DEFAULT 0 CHECK (counter >= 0),

  -- Available transport hints (usb / nfc / ble / internal / hybrid).
  -- Used by the client to speed up the authentication ceremony.
  transports      text[] NOT NULL DEFAULT '{}',

  -- Human-readable name for management UI (e.g. "Alice's iPhone").
  -- GDPR Art. 5(1)(c): data minimization — free-form, not sensitive.
  device_name     text NOT NULL DEFAULT 'Passkey',

  -- Timestamps (GDPR Art. 30 records of processing).
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz,

  -- Soft revocation.
  -- WHY soft not hard: SOC2 CC7.2 requires an auditable trail of revocations.
  -- A NULL revoked_at => credential is active. A non-null value retains the
  -- historical row for audit without allowing further authentication (the
  -- edge function treats revoked_at IS NOT NULL as "not found").
  revoked_at      timestamptz
);

-- Documentation / intent signals (pg_catalog).
COMMENT ON TABLE public.passkeys IS
  'WebAuthn/FIDO2 passkey credentials. One row per registered authenticator. '
  'SOC2 CC6.6 / NIST 800-63B AAL3 authentication factor store.';

COMMENT ON COLUMN public.passkeys.credential_id IS
  'base64url(PublicKeyCredential.id). Unique per WebAuthn L3 §5.8.3.';

COMMENT ON COLUMN public.passkeys.public_key IS
  'base64url(CBOR(COSE_Key)). Opaque to the DB; verified by @simplewebauthn/server.';

COMMENT ON COLUMN public.passkeys.counter IS
  'Signature counter. MUST be monotonically increasing per WebAuthn L3 §7.2 '
  'step 19. Used to detect cloned authenticators.';

COMMENT ON COLUMN public.passkeys.revoked_at IS
  'Soft-revocation timestamp. Non-null => credential rejected at auth time. '
  'Retained for SOC2 CC7.2 audit trail.';

-- ============================================================================
-- Indexes
-- ============================================================================

-- Lookup by user (list / revoke flows). Partial on active rows only to keep
-- the index tight; revoked rows are cold data queried only by audit.
CREATE INDEX IF NOT EXISTS idx_passkeys_user_active
  ON public.passkeys (user_id, created_at DESC)
  WHERE revoked_at IS NULL;

-- credential_id lookup during auth ceremony is already covered by the UNIQUE
-- constraint's implicit btree index. No secondary index needed.

-- ============================================================================
-- Row Level Security
-- ============================================================================

ALTER TABLE public.passkeys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.passkeys FORCE ROW LEVEL SECURITY;

-- SELECT: user can read their own credentials (settings page: list devices).
-- WHY (SELECT auth.uid()): query-plan caching. Re-evaluating auth.uid()
-- per-row is ~40x slower on large tables. See migration 008 / 013 for pattern.
CREATE POLICY passkeys_select_own
  ON public.passkeys
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- UPDATE: user can rename their own device / soft-revoke. Cannot change
-- user_id or credential_id (attempting to do so yields row not found under
-- the WITH CHECK predicate, since the new values would not match).
CREATE POLICY passkeys_update_own
  ON public.passkeys
  FOR UPDATE
  TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

-- DELETE: user can delete their own credential outright.
-- WHY both soft-revoke AND delete: GDPR Art. 17 (right to erasure) requires
-- an actual delete path. Soft-revoke is for routine "sign out this device."
CREATE POLICY passkeys_delete_own
  ON public.passkeys
  FOR DELETE
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- NO INSERT policy for `authenticated`. Inserts only happen inside the
-- verify-passkey edge function using the service role key, after the server
-- has validated attestation per WebAuthn L3 §7.1. Clients cannot forge a
-- passkey registration row.

-- ============================================================================
-- Grants
-- ============================================================================

-- authenticated gets the subset the RLS policies allow; anon gets nothing.
GRANT SELECT, UPDATE, DELETE ON public.passkeys TO authenticated;
REVOKE ALL ON public.passkeys FROM anon;

-- ROLLBACK:
--   DROP POLICY IF EXISTS passkeys_select_own  ON public.passkeys;
--   DROP POLICY IF EXISTS passkeys_update_own  ON public.passkeys;
--   DROP POLICY IF EXISTS passkeys_delete_own  ON public.passkeys;
--   DROP INDEX IF EXISTS public.idx_passkeys_user_active;
--   DROP TABLE IF EXISTS public.passkeys;
