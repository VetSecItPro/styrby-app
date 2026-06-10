'use client';

/**
 * useRelaySend
 *
 * Connects the web dashboard to the user's Supabase Realtime relay channel
 * (`relay:{userId}`) as a `web` device and exposes `sendChat` for pushing a
 * chat message to the CLI/agent live.
 *
 * WHY a client-side RelayClient (not a server route): this mirrors the mobile
 * app exactly (both use the shared `styrby-shared/relay` `RelayClient`), reuses
 * the tested transport, and lets the CLI see the web device's presence. The CLI
 * dispatcher reads `payload.content` as PLAINTEXT, so the relay payload is
 * intentionally unencrypted here — E2E encryption applies only to the persisted
 * `session_messages` history (see `encryptForSession`), not the transient relay
 * control message.
 *
 * Inbound (agent responses) is NOT handled here: `ChatThread` already subscribes
 * to `session_messages` via Supabase postgres_changes, and the CLI persists the
 * agent's output there. This hook is outbound-only.
 *
 * @module hooks/useRelaySend
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createRelayClient, type RelayClient } from '@styrby/shared/relay';
import type { AgentType } from '@styrby/shared';
import { createClient } from '@/lib/supabase/client';

/** localStorage key holding the web device's machine id (set by registerWebDevice). */
const WEB_MACHINE_ID_KEY = 'styrby_web_machine_id';

/**
 * Return value of {@link useRelaySend}.
 */
export interface UseRelaySendReturn {
  /**
   * Broadcast a chat message to the CLI/agent over the relay (plaintext).
   *
   * @param content - The user's message (plaintext — the CLI reads it directly).
   * @param agent - The session's agent type.
   * @param sessionId - The session id (the CLI drops chats for other sessions).
   * @throws If the relay client is not connected yet.
   */
  sendChat: (content: string, agent: AgentType, sessionId?: string) => Promise<void>;
  /** Whether the relay channel is currently connected. */
  connected: boolean;
}

/**
 * Connect to the relay as a web device and expose `sendChat`.
 *
 * The client connects on mount (once `userId` is known) and disconnects on
 * unmount. A stable per-device id is reused from localStorage when present
 * (the registered web machine id) so the CLI sees a consistent web presence.
 *
 * @param userId - The authenticated user's id (relay channel is `relay:{userId}`).
 * @returns `{ sendChat, connected }`.
 */
export function useRelaySend(userId: string): UseRelaySendReturn {
  const clientRef = useRef<RelayClient | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!userId) return;

    // Reuse the registered web machine id when available so the CLI sees a
    // stable web presence; otherwise a per-tab ephemeral id is fine for sending.
    const deviceId =
      (typeof localStorage !== 'undefined' && localStorage.getItem(WEB_MACHINE_ID_KEY)) ||
      `web_${crypto.randomUUID()}`;

    // No channelSuffix — matches the CLI, which connects to `relay:{userId}`.
    const client = createRelayClient({
      supabase: createClient(),
      userId,
      deviceId,
      deviceType: 'web',
      deviceName: 'Web Dashboard',
      platform: 'web',
    });
    clientRef.current = client;

    let cancelled = false;
    client
      .connect()
      .then(() => {
        if (!cancelled) setConnected(true);
      })
      .catch((err: unknown) => {
        if (process.env.NODE_ENV === 'development') {
          console.error('[useRelaySend] relay connect failed:', err);
        }
      });

    return () => {
      cancelled = true;
      setConnected(false);
      clientRef.current = null;
      void client.disconnect().catch(() => {
        /* best-effort teardown */
      });
    };
  }, [userId]);

  const sendChat = useCallback(
    async (content: string, agent: AgentType, sessionId?: string): Promise<void> => {
      const client = clientRef.current;
      if (!client) throw new Error('Relay is not connected');
      await client.sendChat(content, agent, sessionId);
    },
    []
  );

  return { sendChat, connected };
}
