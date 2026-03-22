-- ============================================================================
-- Migration 014: Add Web Push subscription support to device_tokens
-- ============================================================================
-- Purpose: Store Web Push (VAPID) subscriptions alongside APNs/FCM tokens
-- for unified notification delivery across web and native platforms.
--
-- The existing device_tokens table supports iOS (APNs) and Android (FCM).
-- This migration extends it to also support browser-based Web Push via the
-- Push API (VAPID protocol), enabling notifications on the PWA dashboard.
--
-- Changes:
--   1. Add web_push_subscription JSONB column for PushSubscription objects
--   2. Expand platform CHECK constraint to allow 'web'
--   3. Add partial index for efficient web push subscription lookups
--
-- Backward-compatible: all changes use IF NOT EXISTS or safe ALTER patterns.
-- ============================================================================


-- 1. Add web_push_subscription column for storing the PushSubscription object
-- from the Web Push API. This JSON includes the endpoint URL, expiration time,
-- and encryption keys (p256dh, auth) needed to send push notifications.
-- Only populated when platform = 'web'; NULL for native APNs/FCM tokens.
ALTER TABLE device_tokens
ADD COLUMN IF NOT EXISTS web_push_subscription JSONB DEFAULT NULL;

COMMENT ON COLUMN device_tokens.web_push_subscription IS
'Web Push API PushSubscription object (endpoint, expirationTime, keys.p256dh, keys.auth). Only populated for platform=web tokens.';


-- 2. Expand the platform CHECK constraint to include 'web'.
-- The original schema (001) defined: CHECK (platform IN ('ios', 'android')).
-- We drop that constraint and recreate it with 'web' added.
-- Using a named constraint reference from the original schema.
DO $$
BEGIN
  -- Drop the existing CHECK constraint on platform.
  -- The constraint name comes from the original CREATE TABLE definition.
  -- PostgreSQL auto-names CHECK constraints as <table>_<column>_check when
  -- defined inline, so we try that name first. If a custom name was used,
  -- we query pg_constraint to find it.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'device_tokens'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%platform%'
  ) THEN
    EXECUTE (
      SELECT 'ALTER TABLE device_tokens DROP CONSTRAINT ' || quote_ident(conname)
      FROM pg_constraint
      WHERE conrelid = 'device_tokens'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%platform%'
      LIMIT 1
    );
  END IF;
END $$;

-- Recreate the constraint with 'web' included
ALTER TABLE device_tokens
ADD CONSTRAINT device_tokens_platform_check
CHECK (platform IN ('ios', 'android', 'web'));


-- 3. Partial index for efficient web push subscription lookup.
-- When sending web push notifications, we need to find all active web
-- subscriptions for a user. This index covers that query pattern without
-- bloating the index with native token rows.
CREATE INDEX IF NOT EXISTS idx_device_tokens_web_push
ON device_tokens (user_id)
WHERE web_push_subscription IS NOT NULL;
