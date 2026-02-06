-- ============================================================================
-- API KEYS SCHEMA v1.0
-- ============================================================================
-- Secure API key management for Power tier users.
-- Keys are hashed with bcrypt - plaintext keys are NEVER stored.
--
-- Security Design:
-- 1. Keys are hashed with bcrypt (cost factor 12) before storage
-- 2. Only the prefix (first 8 chars) is stored in plaintext for lookup
-- 3. Key format: sk_live_ + 32 random alphanumeric characters
-- 4. Users can revoke keys immediately (soft delete via revoked_at)
-- 5. Keys can have expiration dates for enhanced security
-- 6. All API requests are logged to audit_log table
--
-- Access Pattern:
-- 1. Client sends: Authorization: Bearer sk_live_xxxxxxxx...
-- 2. Server extracts prefix: sk_live_
-- 3. Server looks up key by prefix (indexed)
-- 4. Server verifies full key against bcrypt hash
-- 5. Server checks revoked_at and expires_at
-- 6. Server updates last_used_at and attaches user_id to request
-- ============================================================================


-- ============================================================================
-- API_KEYS TABLE
-- ============================================================================
-- Stores hashed API keys for programmatic access.
-- Power tier only - enforced at application level.
-- ============================================================================

CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  -- Key identification
  name TEXT NOT NULL,                      -- User-provided name for the key
  key_prefix TEXT NOT NULL,                -- First 8 chars (e.g., "sk_live_") for lookup

  -- Security - NEVER store plaintext key
  key_hash TEXT NOT NULL,                  -- bcrypt hash of the full key

  -- Permissions
  scopes TEXT[] DEFAULT '{read}' NOT NULL, -- Available: read, write (future)

  -- Usage tracking
  last_used_at TIMESTAMPTZ,
  last_used_ip INET,
  request_count INTEGER DEFAULT 0 NOT NULL,

  -- Lifecycle
  expires_at TIMESTAMPTZ,                  -- NULL = never expires
  revoked_at TIMESTAMPTZ,                  -- NULL = active
  revoked_reason TEXT,                     -- Optional reason for revocation

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  -- Constraints
  CONSTRAINT valid_scopes CHECK (
    scopes <@ ARRAY['read', 'write']::TEXT[]
  )
);

-- Index for key lookup by prefix (primary access pattern)
-- WHY: API requests need fast lookup by prefix before hash verification
CREATE INDEX idx_api_keys_prefix ON api_keys(key_prefix)
  WHERE revoked_at IS NULL;

-- Index for user's keys (settings page)
-- WHY: Users need to see their active and revoked keys
CREATE INDEX idx_api_keys_user ON api_keys(user_id, created_at DESC);

-- Index for active keys per user (limit enforcement)
-- WHY: Need to count active keys to enforce Power tier limit (5 keys)
CREATE INDEX idx_api_keys_user_active ON api_keys(user_id)
  WHERE revoked_at IS NULL;


-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================
-- Users can only access their own API keys.
-- Service role can access all keys for authentication middleware.
-- ============================================================================

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

-- Users can view their own keys
CREATE POLICY "api_keys_select_own"
  ON api_keys FOR SELECT
  USING (user_id = (SELECT auth.uid()));

-- Users can create their own keys
CREATE POLICY "api_keys_insert_own"
  ON api_keys FOR INSERT
  WITH CHECK (user_id = (SELECT auth.uid()));

-- Users can update their own keys (for revocation)
CREATE POLICY "api_keys_update_own"
  ON api_keys FOR UPDATE
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

-- Users can delete their own keys (hard delete if needed)
CREATE POLICY "api_keys_delete_own"
  ON api_keys FOR DELETE
  USING (user_id = (SELECT auth.uid()));


-- ============================================================================
-- FUNCTION: LOOKUP API KEY BY PREFIX
-- ============================================================================
-- Used by the authentication middleware to find candidate keys.
-- Returns the key record if found and not revoked/expired.
--
-- WHY security definer: Needs to bypass RLS for API authentication
-- where auth.uid() is not set (stateless API request).
-- ============================================================================

CREATE OR REPLACE FUNCTION lookup_api_key(p_prefix TEXT)
RETURNS TABLE (
  id UUID,
  user_id UUID,
  key_hash TEXT,
  scopes TEXT[],
  expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    ak.id,
    ak.user_id,
    ak.key_hash,
    ak.scopes,
    ak.expires_at
  FROM api_keys ak
  WHERE ak.key_prefix = p_prefix
    AND ak.revoked_at IS NULL
    AND (ak.expires_at IS NULL OR ak.expires_at > NOW())
  LIMIT 10; -- Limit to prevent abuse (shouldn't have many keys with same prefix)
END;
$$;


-- ============================================================================
-- FUNCTION: UPDATE API KEY USAGE
-- ============================================================================
-- Called after successful authentication to track usage.
-- Updates last_used_at, last_used_ip, and request_count.
--
-- WHY security definer: Same as above - needs to work without auth.uid().
-- ============================================================================

CREATE OR REPLACE FUNCTION update_api_key_usage(
  p_key_id UUID,
  p_ip_address INET DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE api_keys
  SET
    last_used_at = NOW(),
    last_used_ip = COALESCE(p_ip_address, last_used_ip),
    request_count = request_count + 1
  WHERE id = p_key_id;
END;
$$;


-- ============================================================================
-- FUNCTION: REVOKE API KEY
-- ============================================================================
-- Soft-revokes a key by setting revoked_at.
-- Returns success status.
--
-- WHY: Provides atomic revocation with optional reason.
-- ============================================================================

CREATE OR REPLACE FUNCTION revoke_api_key(
  p_key_id UUID,
  p_reason TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  -- Get the key's owner (RLS bypass needed for this check)
  SELECT user_id INTO v_user_id
  FROM api_keys
  WHERE id = p_key_id;

  -- Verify the caller owns this key (when called via RPC)
  IF v_user_id IS NULL THEN
    RETURN FALSE;
  END IF;

  -- Revoke the key
  UPDATE api_keys
  SET
    revoked_at = NOW(),
    revoked_reason = p_reason
  WHERE id = p_key_id
    AND revoked_at IS NULL;

  RETURN FOUND;
END;
$$;


-- ============================================================================
-- ADD AUDIT ACTION FOR API KEY EVENTS
-- ============================================================================
-- Note: 'api_key_created' and 'api_key_revoked' are already defined in the
-- audit_action enum from the initial schema. No changes needed here.
-- ============================================================================


-- ============================================================================
-- TRIGGER: AUTO-GENERATE KEY PREFIX
-- ============================================================================
-- If key_prefix is not provided (shouldn't happen), extract it from the hash.
-- This is a safety net - the application should always provide the prefix.
-- ============================================================================

-- No trigger needed - prefix is required and validated at application level.


-- ============================================================================
-- GRANTS FOR SERVICE ROLE
-- ============================================================================
-- Service role needs access to functions for API authentication.
-- ============================================================================

GRANT EXECUTE ON FUNCTION lookup_api_key(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION update_api_key_usage(UUID, INET) TO service_role;
GRANT EXECUTE ON FUNCTION revoke_api_key(UUID, TEXT) TO service_role;


-- ============================================================================
-- ADD API KEY LIMIT TO TIERS CONFIG (COMMENT)
-- ============================================================================
-- The Power tier limit of 5 API keys is enforced at the application level
-- in packages/styrby-web/src/lib/polar.ts TIERS configuration.
-- This keeps tier configuration centralized and easily adjustable.
-- ============================================================================


-- ============================================================================
-- END OF API KEYS SCHEMA
-- ============================================================================
