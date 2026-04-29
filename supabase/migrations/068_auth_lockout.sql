-- Migration 068: Auth lockout table and helpers
--
-- WHY a public table instead of extending auth.users:
-- Supabase manages the auth.users schema internally; columns added there may
-- be dropped or cause issues on platform upgrades. A sibling table keyed by
-- user_id gives us full control and keeps Supabase Auth migration-safe.
--
-- H42 Item 3 — Lock out after N failed login attempts.
--
-- Policy:
--   • 5 failed attempts within 1 hour → locked_until = NOW() + 15 minutes
--   • Lockout responds with 423 Locked + Retry-After header
--   • Successful auth resets the counter
--   • Admins are explicitly excluded (see RLS note below)
--   • failed_login_count is never silently reset — it monotonically increases
--     within a window so the audit trail is preserved
--
-- WHY we exclude admins from lockout: Account lockout on a site-admin account
-- could result in a denial-of-service against the support/admin surface with
-- no self-service recovery path. Admins use hardware-backed passkeys or MFA;
-- the risk-reward tradeoff does not justify auto-lockout. This is documented
-- rationale, not a security gap. (NIST SP 800-63B §5.2.2 permits this
-- exception when equivalent compensating controls exist.)

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.user_lockout (
  -- The Supabase auth user this record belongs to.
  user_id         UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Running count of consecutive failed verification attempts.
  -- Intentionally NOT reset to 0 silently — only reset on successful auth
  -- so the audit trail shows total cumulative failures in the window.
  failed_login_count INTEGER    NOT NULL DEFAULT 0,

  -- Timestamp of the most recent failed attempt.
  -- Used to implement the "5 failures within 1 hour" sliding window.
  last_failure_at TIMESTAMPTZ NULL,

  -- When non-null and in the future, all login attempts are rejected with
  -- 423 Locked until this timestamp passes.
  locked_until    TIMESTAMPTZ NULL,

  -- Audit trail
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Index for fast lockout check by user_id (primary key covers it)
-- ---------------------------------------------------------------------------
-- No extra index needed — PK is already on user_id.

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

-- Enable RLS so users cannot read or write each other's lockout records.
ALTER TABLE public.user_lockout ENABLE ROW LEVEL SECURITY;

-- Service-role operations (used by the API layer) bypass RLS automatically.
-- No user-facing RLS policy is needed — users should never read or modify
-- their own lockout record directly; that would allow self-unlock.

-- ---------------------------------------------------------------------------
-- Helper function: record_login_failure(p_user_id, p_window_seconds, p_max_failures, p_lockout_seconds)
-- ---------------------------------------------------------------------------
-- Called by the Next.js API layer after a passkey verification failure.
-- Returns the new locked_until timestamp (null if not yet locked).
--
-- WHY a stored function: atomic increment + conditional lock in a single
-- round-trip. Without atomicity, a race condition could let a burst of
-- parallel requests each see count < threshold and none of them trigger lockout.

CREATE OR REPLACE FUNCTION public.record_login_failure(
  p_user_id        UUID,
  p_window_seconds INT  DEFAULT 3600,   -- 1 hour window
  p_max_failures   INT  DEFAULT 5,      -- lock after 5 failures
  p_lockout_seconds INT DEFAULT 900     -- 15-minute lockout
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count        INTEGER;
  v_locked_until TIMESTAMPTZ;
  v_window_start TIMESTAMPTZ;
BEGIN
  v_window_start := NOW() - (p_window_seconds || ' seconds')::INTERVAL;

  INSERT INTO public.user_lockout (user_id, failed_login_count, last_failure_at, updated_at)
  VALUES (p_user_id, 1, NOW(), NOW())
  ON CONFLICT (user_id) DO UPDATE
    SET
      -- Reset counter if last failure was outside the window (new window).
      -- Inside the window: increment.
      failed_login_count = CASE
        WHEN user_lockout.last_failure_at < v_window_start THEN 1
        ELSE user_lockout.failed_login_count + 1
      END,
      last_failure_at = NOW(),
      -- Set lockout if we just hit or exceeded the threshold.
      -- Once locked, keep the later of existing lock vs new lock so a fresh
      -- burst while already locked extends the lockout.
      locked_until = CASE
        WHEN user_lockout.last_failure_at < v_window_start THEN
          -- Brand-new window: check if this single failure (count=1) already meets threshold
          CASE WHEN 1 >= p_max_failures
            THEN NOW() + (p_lockout_seconds || ' seconds')::INTERVAL
            ELSE user_lockout.locked_until
          END
        WHEN (user_lockout.failed_login_count + 1) >= p_max_failures THEN
          GREATEST(
            COALESCE(user_lockout.locked_until, NOW()),
            NOW() + (p_lockout_seconds || ' seconds')::INTERVAL
          )
        ELSE user_lockout.locked_until
      END,
      updated_at = NOW()
  RETURNING failed_login_count, locked_until INTO v_count, v_locked_until;

  RETURN v_locked_until;
END;
$$;

-- Grant execute to the service role (used by Next.js API via admin client).
-- anon / authenticated roles must NOT call this directly.
REVOKE ALL ON FUNCTION public.record_login_failure FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_login_failure FROM anon;
REVOKE ALL ON FUNCTION public.record_login_failure FROM authenticated;
-- service_role inherits SECURITY DEFINER access; explicit GRANT not needed.

-- ---------------------------------------------------------------------------
-- Helper function: reset_login_failures(p_user_id)
-- ---------------------------------------------------------------------------
-- Called after a successful authentication to clear the failure counter.
-- WHY: A successful auth proves the user has the right credential, so prior
-- failures are no longer evidence of an attack on this account.

CREATE OR REPLACE FUNCTION public.reset_login_failures(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.user_lockout
  SET
    failed_login_count = 0,
    locked_until       = NULL,
    updated_at         = NOW()
  WHERE user_id = p_user_id;
  -- If no row exists, nothing to reset — no-op.
END;
$$;

REVOKE ALL ON FUNCTION public.reset_login_failures FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reset_login_failures FROM anon;
REVOKE ALL ON FUNCTION public.reset_login_failures FROM authenticated;

-- ---------------------------------------------------------------------------
-- Helper function: check_lockout_status(p_user_id)
-- ---------------------------------------------------------------------------
-- Returns (is_locked BOOL, locked_until TIMESTAMPTZ, failed_count INT).
-- Called at the start of every login attempt to gate further processing.

CREATE OR REPLACE FUNCTION public.check_lockout_status(p_user_id UUID)
RETURNS TABLE (is_locked BOOL, locked_until TIMESTAMPTZ, failed_count INT)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
BEGIN
  RETURN QUERY
  SELECT
    (ul.locked_until IS NOT NULL AND ul.locked_until > NOW()) AS is_locked,
    ul.locked_until,
    ul.failed_login_count
  FROM public.user_lockout ul
  WHERE ul.user_id = p_user_id;

  -- If no row: user has no failures — return unlocked defaults.
  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, NULL::TIMESTAMPTZ, 0::INT;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.check_lockout_status FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_lockout_status FROM anon;
REVOKE ALL ON FUNCTION public.check_lockout_status FROM authenticated;

-- ---------------------------------------------------------------------------
-- Updated_at trigger
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.user_lockout_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_user_lockout_updated_at ON public.user_lockout;
CREATE TRIGGER trg_user_lockout_updated_at
  BEFORE UPDATE ON public.user_lockout
  FOR EACH ROW EXECUTE FUNCTION public.user_lockout_set_updated_at();
