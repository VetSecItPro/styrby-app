-- Migration 067: Ensure api_keys.expires_at column exists
--
-- WHY: The column was defined in 007_api_keys.sql but this migration is
-- idempotent (ADD COLUMN IF NOT EXISTS) in case a production environment
-- was provisioned before migration 007 included it or if an older schema
-- snapshot was restored. Safe to run multiple times.
--
-- H42 Item 2 — API Key TTL enforcement.

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NULL;

-- Ensure the lookup_api_key RPC still returns expires_at so the middleware
-- can enforce TTL without a second round-trip. If the function body already
-- selects it, this is a no-op documentation comment only.
-- (No DDL change needed — 007_api_keys.sql already includes expires_at in
-- the lookup_api_key function's SELECT list.)
