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
--   2. Expand platform CHECK constraint to allow 'web' (idempotent)
--   3. Add constraint ensuring web rows have subscription data
--   4. Add structural validation of JSONB PushSubscription shape
--   5. Add partial index for efficient web push subscription lookups
--
-- Backward-compatible: all changes use IF NOT EXISTS or DO-block guards.
-- ============================================================================


-- 1. Add web_push_subscription column for storing the PushSubscription object
-- from the Web Push API. This JSON includes the endpoint URL, expiration time,
-- and encryption keys (p256dh, auth) needed to send push notifications.
-- Only populated when platform = 'web'; NULL for native APNs/FCM tokens.
ALTER TABLE device_tokens
ADD COLUMN IF NOT EXISTS web_push_subscription JSONB DEFAULT NULL;

COMMENT ON COLUMN device_tokens.web_push_subscription IS
'Web Push API PushSubscription object (endpoint, expirationTime, keys.p256dh, keys.auth). Only populated for platform=web tokens.';


-- 2. Expand the platform CHECK constraint to include 'web' (idempotent).
-- The original schema (001) defined: CHECK (platform IN ('ios', 'android')).
-- We drop and recreate only if the existing constraint does not already
-- include 'web', preventing failure on re-run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'device_tokens'::regclass
    AND contype = 'c'
    AND conname = 'device_tokens_platform_check'
    AND pg_get_constraintdef(oid) LIKE '%web%'
  ) THEN
    ALTER TABLE device_tokens
      DROP CONSTRAINT IF EXISTS device_tokens_platform_check;
    ALTER TABLE device_tokens
      ADD CONSTRAINT device_tokens_platform_check
      CHECK (platform IN ('ios', 'android', 'web'));
  END IF;
END $$;


-- 3. Ensure web platform rows always have a push subscription populated.
-- Without this, a device_tokens row with platform='web' but NULL subscription
-- would be useless for sending notifications.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'device_tokens'::regclass
    AND contype = 'c'
    AND conname = 'device_tokens_web_requires_subscription'
  ) THEN
    ALTER TABLE device_tokens
    ADD CONSTRAINT device_tokens_web_requires_subscription
    CHECK (
      platform != 'web'
      OR (platform = 'web' AND web_push_subscription IS NOT NULL)
    );
  END IF;
END $$;


-- 4. Validate the shape of web_push_subscription JSONB.
-- The Web Push API PushSubscription object must contain an 'endpoint' string
-- and nested 'keys' object with 'p256dh' and 'auth' fields. Without these
-- the server cannot encrypt or deliver the notification payload.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'device_tokens'::regclass
    AND contype = 'c'
    AND conname = 'device_tokens_web_push_subscription_valid'
  ) THEN
    ALTER TABLE device_tokens
    ADD CONSTRAINT device_tokens_web_push_subscription_valid
    CHECK (
      web_push_subscription IS NULL
      OR (
        web_push_subscription ? 'endpoint'
        AND web_push_subscription -> 'keys' ? 'p256dh'
        AND web_push_subscription -> 'keys' ? 'auth'
      )
    );
  END IF;
END $$;


-- 5. Partial index for efficient web push subscription lookup.
-- When sending web push notifications, we need to find all active web
-- subscriptions for a user. This index covers that query pattern without
-- bloating the index with native token rows. Includes is_active filter
-- so inactive subscriptions are excluded from the index entirely.
DROP INDEX IF EXISTS idx_device_tokens_web_push;

CREATE INDEX IF NOT EXISTS idx_device_tokens_web_push
ON device_tokens (user_id)
WHERE web_push_subscription IS NOT NULL AND is_active = TRUE;
