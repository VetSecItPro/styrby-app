/**
 * POST /api/v1/broadcast
 *
 * Server-side Supabase Realtime broadcast fan-out endpoint. Used by the CLI daemon
 * to push real-time events (cost updates, budget alerts) to connected mobile devices
 * without requiring the CLI to hold a persistent Realtime WebSocket.
 *
 * CLI callsites:
 *  - packages/styrby-cli/src/costs/budget-actions.ts:403 — channel: `user:${userId}:alerts`
 *  - packages/styrby-cli/src/costs/cost-reporter.ts:520  — channel: `user:${userId}:costs`
 *
 * @auth Required - Bearer `styrby_*` API key via withApiAuthAndRateLimit
 * @rateLimit 60 requests per minute per key (aggressive — broadcasts are user-facing real-time)
 *
 * @body {
 *   channel: string,                  // Must start with `user:${authenticatedUid}:`
 *   event: string,                    // Short event name (e.g. "cost_update", "budget_alert")
 *   payload: Record<string, unknown>  // Opaque event payload for Realtime subscribers
 * }
 *
 * @returns 200 { delivered: boolean }
 *   - delivered:true  — supabase.channel().send() returned 'ok'
 *   - delivered:false — send() returned non-'ok' status (best-effort; not a 5xx)
 *
 * @error 400 { error: string }  — Zod validation failure or payload too large
 * @error 401 { error: string }  — Missing or invalid API key
 * @error 403 { error: string }  — Channel not scoped to authenticated user (OWASP A01:2021)
 * @error 429 { error: string }  — Rate limit exceeded
 * @error 500 { error: string }  — Unexpected error (sanitized; captured in Sentry)
 *
 * @security OWASP A01:2021 (Broken Access Control — channel-prefix authorization prevents cross-user broadcast)
 * @security OWASP A07:2021 (Identification and Authentication Failures — withApiAuthAndRateLimit)
 * @security OWASP A03:2021 (Injection / Mass Assignment — Zod .strict() guard)
 * @security GDPR Art 6 (Lawful basis — broadcast only routes to authenticated user's own channel)
 * @security SOC 2 CC6.1 (Logical Access Controls — channel scoping enforced server-side)
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import * as Sentry from '@sentry/nextjs';

import {
  withApiAuthAndRateLimit,
  type ApiAuthContext,
} from '@/middleware/api-auth';
import { createAdminClient } from '@/lib/supabase/server';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Rate limit override for this route.
 * WHY 60 req/min: broadcasts are user-facing real-time updates (cost tickers,
 * budget alerts). A 60 req/min cap is aggressive but appropriate — the CLI
 * daemon batches cost updates so even busy sessions rarely exceed 1/sec.
 * This prevents a rogue CLI instance from flooding Supabase Realtime.
 */
const BROADCAST_RATE_LIMIT = {
  windowMs: 60_000,
  maxRequests: 60,
};

/**
 * Maximum allowed payload size in bytes (JSON-serialized).
 * WHY 64 KB: Supabase Realtime has its own message-size limits (~1 MB per channel),
 * but we enforce a tighter app-layer cap to prevent abuse (e.g. a CLI instance
 * trying to relay large file contents through the broadcast channel).
 * 64 KB comfortably covers all legitimate CLI payloads (cost summaries, alert data).
 */
const MAX_PAYLOAD_BYTES = 64_000;

// ---------------------------------------------------------------------------
// Zod Schema — mass-assignment guard + field bounds
// ---------------------------------------------------------------------------

/**
 * Request body schema for POST /api/v1/broadcast.
 *
 * WHY .strict(): rejects any fields not listed in the schema. This prevents
 * mass-assignment attacks where a caller injects unexpected fields (e.g. `user_id`
 * to spoof the broadcast originator). OWASP A03:2021.
 */
const BroadcastBodySchema = z
  .object({
    /**
     * Supabase Realtime channel name. Must be scoped to the authenticated user:
     * `user:${userId}:<topic>`. Server enforces the prefix — cross-user broadcast
     * is rejected with 403. Max 255 chars: a UUID (36) + prefix (5) + colon + topic
     * is well under this bound.
     */
    channel: z.string().min(1, 'channel is required').max(255, 'channel must be 255 characters or fewer'),

    /**
     * Short Realtime event name. Examples: "cost_update", "budget_alert", "reconnect".
     * Max 64 chars: keeps event names concise and prevents unbounded strings in
     * Supabase Realtime message headers.
     */
    event: z.string().min(1, 'event is required').max(64, 'event must be 64 characters or fewer'),

    /**
     * Opaque event payload. Stored as-is in the Realtime message; shape is
     * caller's contract with their subscribers. We do NOT validate the inner
     * structure — that would couple the API to every CLI event schema.
     * Payload size is checked at runtime against MAX_PAYLOAD_BYTES.
     */
    payload: z.record(z.unknown()),
  })
  .strict(); // rejects unknown fields — mass-assignment guard (OWASP A03:2021)

type BroadcastBody = z.infer<typeof BroadcastBodySchema>;

// ---------------------------------------------------------------------------
// Response interface
// ---------------------------------------------------------------------------

/**
 * Response shape for POST /api/v1/broadcast.
 *
 * WHY delivered (not success/error): broadcast is best-effort per spec. The
 * CLI daemon should never retry aggressively on delivered:false — the mobile
 * client will catch up on the next poll. A boolean flag signals the outcome
 * without implying a hard error when Realtime is temporarily degraded.
 */
interface BroadcastResult {
  delivered: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts only the topic suffix from a channel string for safe Sentry logging.
 *
 * Channel format: `user:${userId}:<topic>`. Logging the raw channel embeds the
 * userId (a personal identifier) in Sentry. This helper strips the user-scoped
 * prefix so Sentry receives only the topic (e.g. "costs", "alerts").
 *
 * WHY `<unscoped>` fallback: used in the 403 path where the channel did NOT match
 * the authenticated user's prefix — logging the actual mismatched channel could
 * expose another user's UUID. GDPR Art 5(1)(c) — data minimisation.
 *
 * @param channel  - Raw Realtime channel name from the request body
 * @param userId   - Authenticated user's UUID from auth context
 * @returns The topic suffix, or `<unscoped>` if the channel doesn't match the prefix
 */
function channelTopicForLog(channel: string, userId: string): string {
  const prefix = `user:${userId}:`;
  return channel.startsWith(prefix) ? channel.slice(prefix.length) : '<unscoped>';
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Core POST handler for server-side Realtime broadcast.
 *
 * Wrapped by withApiAuthAndRateLimit — never called directly. The wrapper
 * enforces:
 *  1. IP-based pre-auth rate limit (60 req/min/IP) — blocks unauthenticated floods
 *  2. Per-key rate limit (100 req/min/key default from authenticateApiRequest)
 *  3. This route's per-route override (60 req/min/key via BROADCAST_RATE_LIMIT)
 *
 * @param request - Authenticated NextRequest
 * @param context - Auth context from withApiAuthAndRateLimit (userId, keyId, scopes)
 * @returns 200 with { delivered: boolean }, or an appropriate error response
 *
 * @security OWASP A01:2021 — channel-prefix check prevents cross-user broadcast
 * @security OWASP A07:2021 — auth enforced by withApiAuthAndRateLimit
 * @security OWASP A03:2021 — mass-assignment blocked by Zod .strict()
 * @security GDPR Art 6   — only broadcasts to authenticated user's own channel
 * @security SOC 2 CC6.1  — least-privilege: write scope required; prefix check server-enforced
 */
async function handlePost(request: NextRequest, context: ApiAuthContext): Promise<NextResponse> {
  const { userId } = context;

  // -------------------------------------------------------------------------
  // Step 0: Defense-in-depth — empty userId guard (OWASP A01:2021)
  // WHY: Auth middleware should never produce an empty userId, but if it somehow
  // does, `expectedPrefix` would become `"user::"` and any channel starting with
  // that would pass the prefix check. Fail-closed with 403 + Sentry error log
  // rather than silently allowing a dangerously permissive prefix match.
  // -------------------------------------------------------------------------
  if (!userId) {
    Sentry.captureMessage('Broadcast: auth context missing userId', {
      level: 'error',
      tags: { endpoint: '/api/v1/broadcast' },
    });
    return NextResponse.json({ error: 'Broadcast request rejected' }, { status: 403 });
  }

  // -------------------------------------------------------------------------
  // Step 1: Parse + validate request body
  // WHY Zod .strict() here (not schema-level): the schema is already defined
  // with .strict(); this parse call enforces it and surfaces field-level errors.
  // -------------------------------------------------------------------------
  let parsedBody: BroadcastBody;

  try {
    const rawBody = await request.json();
    const parseResult = BroadcastBodySchema.safeParse(rawBody);

    if (!parseResult.success) {
      const errorMessage = parseResult.error.errors
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join('; ');

      return NextResponse.json({ error: errorMessage }, { status: 400 });
    }

    parsedBody = parseResult.data;
  } catch {
    // JSON.parse failure — malformed body
    return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 });
  }

  const { channel, event, payload } = parsedBody;

  // -------------------------------------------------------------------------
  // Step 2: Payload size guard
  // WHY app-layer check before calling Realtime: Supabase Realtime will reject
  // oversized messages with an opaque error. We surface a clean 400 with a
  // meaningful message rather than letting the caller see a cryptic Realtime
  // rejection. Prevents abuse of the broadcast channel as a large-object relay.
  // -------------------------------------------------------------------------
  const payloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (payloadBytes > MAX_PAYLOAD_BYTES) {
    return NextResponse.json(
      { error: `Payload exceeds maximum allowed size of ${MAX_PAYLOAD_BYTES} bytes` },
      { status: 400 },
    );
  }

  // -------------------------------------------------------------------------
  // Step 3: Channel-prefix authorization (OWASP A01:2021 — Broken Access Control)
  // WHY: The `user:${userId}:` prefix scopes the channel to the authenticated user.
  // Without this check, any valid API key could broadcast to ANY user's channel,
  // enabling cross-user event injection (e.g. faking budget alerts for victim users).
  //
  // WHY exact startsWith with colon delimiter (not substring/regex):
  //   - `user:${userId}:` ends with a colon, so `user:victim-uuid-evil:alerts`
  //     must match user:victim-uuid: exactly — no concatenation-attack bypass.
  //   - `channel.startsWith(`user:${userId}-evil:alerts`)` would fail because
  //     `-evil` is not a colon, so the prefix `user:${userId}:` does not match.
  //   - The colon delimiter is load-bearing: this is why it's included in the
  //     expectedPrefix rather than just checking `user:${userId}`.
  //
  // WHY the error message does NOT reveal the authenticated userId:
  //   Information leakage prevention — an attacker who crafts a channel targeting
  //   another user would otherwise see their own userId in the error, confirming
  //   the channel naming convention. OWASP A01:2021, SOC 2 CC6.1.
  // -------------------------------------------------------------------------
  const expectedPrefix = `user:${userId}:`;
  if (!channel.startsWith(expectedPrefix)) {
    return NextResponse.json(
      { error: 'Channel must be scoped to authenticated user' },
      { status: 403 },
    );
  }

  // -------------------------------------------------------------------------
  // Step 4: Broadcast via Supabase Realtime
  // WHY createAdminClient() per request: the service-role key allows the server
  // to publish to any Realtime channel without requiring the user's JWT session.
  // The app-layer channel-prefix check (Step 3) is the security control — the
  // service-role client is deliberately unrestricted at the DB/Realtime level.
  // Per-request instantiation: Next.js route handlers are stateless; a single
  // shared client would leak state across concurrent requests. SOC 2 CC6.1.
  // -------------------------------------------------------------------------
  const supabase = createAdminClient();

  try {
    // WHY: supabase.channel().send() is fire-and-forget — it resolves to a
    // status string ('ok', 'error', 'timed out') and does not throw on soft failures.
    // We treat 'ok' as delivered:true and anything else as delivered:false.
    // This is intentional: broadcast is best-effort per spec. A temporary Realtime
    // degradation should not surface as a 500 to the CLI daemon.
    const sendStatus = await supabase.channel(channel).send({
      type: 'broadcast',
      event,
      payload,
    });

    if (sendStatus === 'ok') {
      const result: BroadcastResult = { delivered: true };
      return NextResponse.json(result, { status: 200 });
    }

    // Soft failure — Realtime returned a non-'ok' status.
    // WHY warning (not captureException): this is expected degradation, not a
    // code bug. Sentry warning lets us track Realtime reliability over time
    // without alerting on-call for transient infrastructure issues.
    Sentry.captureMessage(`Realtime broadcast soft failure: send() returned '${sendStatus}'`, {
      level: 'warning',
      extra: {
        // WHY channelTopicForLog (not raw channel): channel format is
        // `user:${userId}:<topic>`, so the raw value embeds the user's UUID.
        // GDPR Art 5(1)(c) data minimisation — log only the topic suffix.
        channelTopic: channelTopicForLog(channel, userId),
        event,
        sendStatus,
        route: '/api/v1/broadcast',
      },
    });

    const result: BroadcastResult = { delivered: false };
    return NextResponse.json(result, { status: 200 });

  } catch (err) {
    // Unexpected error — supabase.channel() itself threw (e.g. SDK bug, null ref).
    // WHY captureException (not captureMessage): this is an unexpected code-level
    // failure, not a Realtime soft failure. We want a Sentry alert with full stack
    // trace. OWASP A02:2021 — raw error not returned to caller.
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
      extra: {
        // WHY channelTopicForLog (not raw channel): GDPR Art 5(1)(c) — strip
        // userId from channel before sending to Sentry. Same minimisation
        // principle as the soft-failure path above.
        channelTopic: channelTopicForLog(channel, userId),
        event,
        route: '/api/v1/broadcast',
      },
    });

    return NextResponse.json({ error: 'Broadcast failed unexpectedly' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Export — wrapped with auth + rate limit override
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/broadcast
 *
 * Rate limit override: 60 req/min/key (aggressive cap for real-time updates).
 * Required scopes: ['write'] — broadcast is a write operation that pushes
 * events to connected mobile clients.
 *
 * WHY 'write' scope: read-only API keys (e.g. dashboard integrations) must
 * not be able to inject events into the user's Realtime channel. Requiring
 * 'write' scope enforces least-privilege. SOC 2 CC6.1.
 *
 * WHY NO idempotency middleware: broadcasts are transient by nature. A repeated
 * broadcast with the same body is a legitimate re-send (e.g. CLI retry after
 * a network hiccup), not a duplicate write. Idempotency would incorrectly
 * suppress re-sends. Spec explicitly states "no idempotency".
 */
export const POST = withApiAuthAndRateLimit(handlePost, ['write'], {
  rateLimit: BROADCAST_RATE_LIMIT,
});
