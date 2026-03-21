-- ============================================================================
-- Migration 009: Schema Mismatch Fixes
-- ============================================================================
-- Fixes column name mismatches between application code and database schema
-- discovered during schema audit on 2026-03-21.
--
-- Fixes:
-- 1. insert_session_message RPC references non-existent `role` column
-- 2. device_tokens unique constraint needs to include user_id for upsert
-- ============================================================================


-- ============================================================================
-- FIX 1: Recreate insert_session_message WITHOUT `role` column
-- WHY: session_messages table has no `role` column. The RPC was inserting
-- into a non-existent column, causing all relay message inserts to fail
-- with: "column 'role' of relation 'session_messages' does not exist"
-- ============================================================================

CREATE OR REPLACE FUNCTION insert_session_message(
  p_session_id UUID,
  p_message_type TEXT,
  p_content_encrypted TEXT DEFAULT NULL,
  p_encryption_nonce TEXT DEFAULT NULL,
  p_parent_message_id UUID DEFAULT NULL,
  p_permission_granted BOOLEAN DEFAULT NULL,
  p_metadata JSONB DEFAULT NULL
)
RETURNS TABLE (id UUID, sequence_number INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session_owner UUID;
  v_next INTEGER;
  v_id UUID;
BEGIN
  -- Verify session ownership
  SELECT user_id INTO v_session_owner
  FROM sessions
  WHERE sessions.id = p_session_id;

  IF v_session_owner IS NULL THEN
    RAISE EXCEPTION 'Session not found';
  END IF;

  IF v_session_owner != auth.uid() THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  -- Advisory lock serializes sequence number generation per session
  PERFORM pg_advisory_xact_lock(hashtext(p_session_id::text));

  SELECT COALESCE(MAX(sm.sequence_number), 0) + 1 INTO v_next
  FROM session_messages sm
  WHERE sm.session_id = p_session_id;

  INSERT INTO session_messages (
    session_id, sequence_number, message_type,
    content_encrypted, encryption_nonce,
    parent_message_id, permission_granted, metadata
  ) VALUES (
    p_session_id, v_next, p_message_type,
    p_content_encrypted, p_encryption_nonce,
    p_parent_message_id, p_permission_granted, p_metadata
  )
  RETURNING session_messages.id, session_messages.sequence_number INTO v_id, v_next;

  RETURN QUERY SELECT v_id, v_next;
END;
$$;

-- Drop the old function signature (with p_role) so there's no ambiguity
DROP FUNCTION IF EXISTS insert_session_message(UUID, TEXT, TEXT, TEXT, TEXT, UUID, BOOLEAN, JSONB);

-- Grant on the new signature (without p_role)
GRANT EXECUTE ON FUNCTION insert_session_message(UUID, TEXT, TEXT, TEXT, UUID, BOOLEAN, JSONB) TO authenticated;


-- ============================================================================
-- FIX 2: Add composite unique constraint for device_tokens upsert
-- WHY: Mobile code upserts with onConflict: 'user_id,token' but the schema
-- only has UNIQUE(token). Add a composite unique index so the upsert works.
-- The original UNIQUE(token) is kept for backwards compatibility.
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_device_tokens_user_token
  ON device_tokens (user_id, token);
