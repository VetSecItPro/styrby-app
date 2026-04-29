-- Migration 066: Idempotency Keys
--
-- WHY: Per OWASP A04:2021 (Insecure Design) — replay protection for state-
-- mutating endpoints. The CLI retries POST/PATCH/DELETE on transient network
-- errors; without server-side deduplication the same operation can fire twice
-- (e.g. double-charge on checkout retry, double-delete on account wipe).
--
-- Design mirrors Stripe's idempotency key pattern + Standard Webhooks spec:
-- - Key is client-supplied (UUID/ULID/any opaque string)
-- - Scoped to (key, user_id, route) so the same key cannot collide across users
--   or be replayed against a different endpoint
-- - Cached responses live for 24 hours then expire
-- - Service-role-only access; client code never reads this table directly
--
-- References:
--   Stripe: https://stripe.com/docs/idempotency
--   OWASP A04:2021: https://owasp.org/Top10/A04_2021-Insecure_Design/

-- ============================================================================
-- Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.idempotency_keys (
  -- Client-supplied idempotency key (UUID, ULID, or any opaque string).
  -- WHY TEXT not UUID: allows ULID and other non-UUID formats the CLI may
  -- generate without requiring a conversion step on the client side.
  key              TEXT        NOT NULL,

  -- User context. Collisions across different users with the same key value
  -- are prevented by including user_id in the primary key.
  user_id          UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Normalized route path the key was used against (e.g. '/api/billing/checkout/team').
  -- WHY: Prevents cross-route replay — a key issued for checkout cannot
  -- accidentally match a cached response for account delete.
  route            TEXT        NOT NULL,

  -- sha256(method || ':' || path || ':' || body) — detects body mismatch on replay.
  -- WHY store body hash not body: avoids storing potentially large request payloads
  -- in Postgres; the hash is sufficient to detect a different-body replay.
  request_hash     TEXT        NOT NULL,

  -- HTTP status code of the original response (e.g. 200, 201).
  -- WHY: Replayed responses must preserve the original status, not always 200.
  response_status  INTEGER     NOT NULL,

  -- Full JSON response body, returned verbatim on replay.
  -- WHY JSONB: Next.js route handlers return JSON; storing as JSONB enables
  -- future queries on response shape if needed, and Postgres validates the JSON.
  response_body    JSONB       NOT NULL,

  -- Composite primary key: (key, user_id, route).
  -- Ensures uniqueness per key per user per endpoint.
  PRIMARY KEY (key, user_id, route),

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Auto-expire: 24-hour window matches Stripe's idempotency window.
  -- The cleanup cron deletes rows where expires_at < NOW().
  expires_at       TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')
);

-- ============================================================================
-- Index
-- ============================================================================

-- Supports the daily cleanup cron: DELETE WHERE expires_at < NOW().
-- WHY a dedicated index on expires_at: the PK index cannot serve this range
-- scan efficiently because expires_at is not part of the PK.
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires
  ON public.idempotency_keys (expires_at);

-- ============================================================================
-- Row Level Security
-- ============================================================================

-- Enable RLS — every access goes through a policy.
ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;

-- Service-role bypass: RLS is skipped for service-role key connections, which
-- is how the Next.js API routes access this table (via createAdminClient).
-- No explicit policy is needed for service-role; the enabled RLS will block
-- anon/authenticated role access, preventing client SDKs from reading or
-- writing idempotency records directly.

-- WHY no SELECT/INSERT/UPDATE/DELETE policies for anon or authenticated roles:
-- This table is internal infrastructure. All access flows through the API layer
-- (service role). Exposing it to the client would allow users to inspect or
-- manipulate each other's cached responses if user_id check was ever missed.

COMMENT ON TABLE public.idempotency_keys IS
  'Server-side idempotency cache for state-mutating API endpoints. '
  'Service-role access only. Rows expire after 24 hours. '
  'OWASP A04:2021 replay protection.';
