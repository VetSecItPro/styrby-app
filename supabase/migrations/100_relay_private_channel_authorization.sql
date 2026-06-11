-- ============================================================================
-- Migration 100: Relay private-channel authorization (realtime.messages RLS)
-- ============================================================================
--
-- SECURITY FIX (SEC-RELAY-AUTH-001, /sec-ship --comprehensive 2026-06-10)
--
-- The relay channel `relay:{userId}` was created as a PUBLIC Supabase Realtime
-- broadcast channel (no `private: true`, no authorization). The only secret in
-- the topic name is the userId UUID, so any authenticated client that learns a
-- userId could:
--   - subscribe and read all plaintext chat + tool I/O (confidentiality), and
--   - broadcast forged messages — including a `chat` the CLI forwards to
--     agent.sendPrompt() (integrity / agent-drive, RCE-class when a session runs
--     acceptEdits/bypassPermissions).
-- Only `permission_response` was nonce-gated (CLI-009); all other message types
-- were trusted-by-arrival.
--
-- FIX (broker-enforced, both confidentiality + integrity): the RelayClient now
-- opens the channel with `private: true`. For private channels, Supabase Realtime
-- authorizes every subscribe (SELECT) and every broadcast/presence write (INSERT)
-- against RLS on `realtime.messages`, keyed to `realtime.topic()`. These policies
-- restrict each authenticated user to their OWN relay topic — the broker rejects
-- any attempt to join or publish to another user's channel before app code runs.
--
-- WHY this does NOT affect other realtime usage: realtime.messages RLS applies
-- ONLY to channels opened with `private: true`. The cost/session dashboards use
-- postgres_changes subscriptions (gated by ordinary table RLS) and public
-- channels, which bypass realtime.messages RLS entirely. Only the relay channel
-- opts into private mode, so only the relay topic is gated here.
--
-- WHY both exact-match and `:%` LIKE: the topic is `relay:{userId}` today, with a
-- forward-compatible `relay:{userId}:{suffix}` variant (deriveChannelSuffix). Both
-- belong to the same owning user, so both are authorized for that user.
--
-- ROLLOUT ORDERING (zero-downtime): apply THIS migration BEFORE shipping the
-- RelayClient `private: true` change. While clients are still public, these
-- policies are inert (public channels ignore realtime.messages RLS). Once a
-- client connects with private:true, the matching policy is already present, so
-- it authorizes immediately. Old (public) and new (private) clients coexist with
-- no outage window.
-- ============================================================================

-- realtime.messages has RLS enabled by default in Supabase; CREATE POLICY is
-- additive. DROP IF EXISTS keeps this migration idempotent on re-run.

DROP POLICY IF EXISTS "relay_own_topic_select" ON realtime.messages;
CREATE POLICY "relay_own_topic_select"
  ON realtime.messages
  FOR SELECT
  TO authenticated
  USING (
    realtime.topic() = ('relay:' || (SELECT auth.uid())::text)
    OR realtime.topic() LIKE ('relay:' || (SELECT auth.uid())::text || ':%')
  );

DROP POLICY IF EXISTS "relay_own_topic_insert" ON realtime.messages;
CREATE POLICY "relay_own_topic_insert"
  ON realtime.messages
  FOR INSERT
  TO authenticated
  WITH CHECK (
    realtime.topic() = ('relay:' || (SELECT auth.uid())::text)
    OR realtime.topic() LIKE ('relay:' || (SELECT auth.uid())::text || ':%')
  );
