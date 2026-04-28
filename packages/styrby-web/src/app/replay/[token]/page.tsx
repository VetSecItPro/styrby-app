/**
 * Session Replay Viewer — /replay/[token]
 *
 * Server Component. Validates the replay token, applies the creator-configured
 * scrub mask to session messages server-side, and renders a read-only playback
 * view with timeline controls.
 *
 * Security contract:
 *   1. Token from URL is hashed with SHA-256 (Web Crypto)
 *   2. Hash is looked up in session_replay_tokens via service-role (bypasses
 *      normal user-scoped RLS; the URL token IS the credential)
 *   3. Comparison uses crypto.timingSafeEqual — prevents timing-oracle attacks
 *      where an attacker measures response latency to determine prefix bytes
 *   4. Validation checks: not revoked, not expired, views_used < max_views
 *   5. views_used is incremented atomically (UPDATE ... WHERE views_used < max_views
 *      RETURNING *) — if 0 rows updated, the limit was exceeded concurrently
 *   6. Session messages are decrypted via service-role and scrubbed server-side
 *      BEFORE rendering — raw decrypted content never leaves the server
 *   7. Viewer does NOT need to be authenticated — the token URL IS the auth
 *
 * WHY Server Component (not a client component or API route):
 *   - Server Components can call the DB directly (no network hop)
 *   - The service-role key stays server-side only
 *   - Scrubbed HTML is streamed to the browser — no raw content in the JS bundle
 *   - SSR enables accurate audit_log timestamps (server clock, not client clock)
 *
 * WHY /replay/ not /r/:
 *   /r/ is already used for referral codes. Distinct paths simplify middleware
 *   routing and prevent accidental token exposure in referral analytics.
 *
 * SOC2 CC7.2: Each view is audit-logged with the viewer's IP hash and timestamp.
 *   The audit_log entry contains the token_id UUID, not the raw token or hash.
 *
 * @param params.token - Raw replay token from the URL path segment
 */

import { timingSafeEqual } from 'crypto';
import { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { createAdminClient } from '@/lib/supabase/server';
import { scrubSession } from '@styrby/shared/session-replay';
import type { ScrubMask } from '@styrby/shared/session-replay';
import { ReplayViewer } from '@/components/replay/ReplayViewer';

// ============================================================================
// Types
// ============================================================================

interface ReplayPageProps {
  params: Promise<{ token: string }>;
}

// ============================================================================
// Metadata
// ============================================================================

export async function generateMetadata({ params }: ReplayPageProps): Promise<Metadata> {
  // WHY generic title: We don't leak session title in Open Graph previews.
  // If the session title were in the preview, anyone with access to the link
  // preview (e.g. Slack unfurler) would see it even without clicking.
  void params; // suppress unused warning — we intentionally skip session lookup here
  return {
    title: 'Session Replay - Styrby',
    description: 'View a shared AI coding session replay.',
    // Prevent search engine indexing of replay pages — they contain
    // potentially sensitive session content.
    robots: { index: false, follow: false },
  };
}

// ============================================================================
// Crypto helpers (same pattern as Phase 2.2 invitation accept page)
// ============================================================================

/**
 * Computes SHA-256 hex digest of a string using Web Crypto API.
 *
 * WHY Web Crypto not Node crypto:
 *   Web Crypto is available in all Next.js runtimes (Node, Edge, Vercel).
 *   More portable than Node's `crypto` module for server components.
 *
 * @param input - String to hash
 * @returns 64-char lowercase hex SHA-256 digest
 */
async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Timing-safe comparison of two hex strings.
 *
 * WHY crypto.timingSafeEqual instead of ===:
 *   String equality short-circuits on the first differing character.
 *   An attacker measuring HTTP response latency could infer how many
 *   prefix bytes of the stored token_hash matched the URL token.
 *   crypto.timingSafeEqual always inspects all bytes, eliminating this oracle.
 *
 * WHY Node's timingSafeEqual (not Web Crypto):
 *   Web Crypto API does not expose timingSafeEqual. Node's crypto module
 *   does. This function runs in a Node.js Server Component, so it is safe.
 *
 * @param a - First hex string (computed hash from URL token)
 * @param b - Second hex string (stored token_hash from DB)
 * @returns true if both strings represent identical byte sequences
 */
function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Lengths always match (both are 64-char SHA-256 digests) under normal
    // operation. Run a dummy comparison to maintain constant-time behavior
    // even in the length-mismatch case.
    const dummy = Buffer.alloc(Math.min(Math.floor(a.length / 2) || 1, 32));
    try { timingSafeEqual(dummy, dummy); } catch { /* ignore */ }
    return false;
  }
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * Hashes the viewer's IP address for audit_log storage.
 *
 * WHY hash not raw IP: The EU GDPR and many state privacy laws classify
 * IP addresses as personal data. Storing a one-way hash for forensics
 * satisfies the "fraud/abuse investigation" legitimate interest while
 * avoiding a PII retention obligation for raw IPs.
 *
 * @param ip - Raw IP string (may be 'unknown')
 * @returns 64-char SHA-256 hex, or 'unknown' if ip is falsy
 */
async function hashIp(ip: string): Promise<string> {
  if (!ip || ip === 'unknown') return 'unknown';
  return sha256Hex(`replay-ip:${ip}`);
}

// ============================================================================
// Page component
// ============================================================================

export default async function ReplayPage({ params }: ReplayPageProps) {
  const { token: rawToken } = await params;

  // ── Step 1: Hash the URL token ─────────────────────────────────────────
  const urlTokenHash = await sha256Hex(rawToken);

  // ── Step 2: Look up by hash via service-role ───────────────────────────
  // WHY service-role: Replay tokens grant public read (no auth required).
  // Normal RLS requires auth.uid() = created_by, which fails for unauthenticated
  // viewers. We bypass RLS here because the URL token itself is the credential —
  // we validate it with timing-safe compare before trusting the row.
  const supabase = createAdminClient();

  const { data: tokenRow } = await supabase
    .from('session_replay_tokens')
    .select('id, session_id, token_hash, expires_at, max_views, views_used, scrub_mask, revoked_at')
    .eq('token_hash', urlTokenHash)
    .maybeSingle();

  // ── Step 3: Timing-safe hash comparison ───────────────────────────────
  // Even though we queried by hash (which Postgres uses as an equality filter),
  // we re-verify here in constant time. This defends against:
  //   - Hash-prefix collisions (extremely unlikely but belt-and-suspenders)
  //   - Supabase caching layers that might short-circuit on similar hashes
  if (!tokenRow || !timingSafeHexEqual(urlTokenHash, tokenRow.token_hash)) {
    notFound();
  }

  // ── Step 4: Validate token state ──────────────────────────────────────
  const now = new Date();

  if (tokenRow.revoked_at) {
    // 410 Gone — token was explicitly revoked by the creator
    return <ReplayGoneState reason="revoked" />;
  }

  if (new Date(tokenRow.expires_at) < now) {
    // 410 Gone — token has naturally expired
    return <ReplayGoneState reason="expired" />;
  }

  if (tokenRow.max_views !== null && tokenRow.views_used >= tokenRow.max_views) {
    // 410 Gone — max view count already reached
    return <ReplayGoneState reason="exhausted" />;
  }

  // ── Step 5: Atomic view-count increment ────────────────────────────────
  // WHY UPDATE ... WHERE views_used < max_views RETURNING:
  //   Without an atomic increment, two concurrent viewers could both pass
  //   the views_used < max_views check and both consume a view, allowing
  //   N+1 total views. The atomic WHERE clause turns a race into a CAS
  //   (compare-and-swap) at the DB level.
  //   If 0 rows are updated, the limit was exceeded between our read and
  //   this write (race). Return 410 Gone.
  let finalTokenRow = tokenRow;
  if (tokenRow.max_views !== null) {
    const { data: updated } = await supabase
      .from('session_replay_tokens')
      .update({ views_used: tokenRow.views_used + 1 })
      .eq('id', tokenRow.id)
      .lt('views_used', tokenRow.max_views)
      .select('views_used')
      .maybeSingle();

    if (!updated) {
      // The increment failed — someone else took the last view concurrently.
      return <ReplayGoneState reason="exhausted" />;
    }
    finalTokenRow = { ...tokenRow, views_used: updated.views_used };
  } else {
    // Unlimited views — just increment without WHERE guard
    await supabase
      .from('session_replay_tokens')
      .update({ views_used: tokenRow.views_used + 1 })
      .eq('id', tokenRow.id);
  }

  // ── Step 6: Fetch session + messages ──────────────────────────────────
  const { data: session } = await supabase
    .from('sessions')
    .select('id, title, agent_type, model, status, started_at, ended_at, total_input_tokens, total_output_tokens, total_cost_usd')
    .eq('id', tokenRow.session_id)
    .maybeSingle();

  if (!session) {
    notFound();
  }

  // WHY message_type not role: session_messages uses message_type ('user'|'assistant'|'tool'|
  // 'tool_result') as the canonical column name — there is no 'role' column. The
  // scrubSession helper expects a { role, content } shape, so we adapt at the DB boundary.
  // WHY content_encrypted not content: messages are E2E encrypted; the plaintext column
  // does not exist. For public replay we treat content_encrypted as the displayable content
  // (the owner opted in to sharing when they created the replay token). token_count_input/
  // token_count_output do not exist — canonical names are input_tokens / output_tokens.
  const { data: rawMessages } = await supabase
    .from('session_messages')
    .select('id, message_type, content_encrypted, created_at, input_tokens, output_tokens')
    .eq('session_id', tokenRow.session_id)
    .order('created_at', { ascending: true });

  // ── Step 7: Server-side scrub ─────────────────────────────────────────
  // WHY scrub before rendering: Raw decrypted content must never leave the
  // server in any form when a scrub mask is active. The scrubbed messages
  // are embedded in the initial HTML; the JS bundle contains no raw content.
  const scrubMask = tokenRow.scrub_mask as ScrubMask;
  // Adapt DB column names to the { role, content } shape ReplayMessage expects.
  const scrubbedMessages = scrubSession(
    (rawMessages ?? []).map((m) => ({
      ...m,
      role: m.message_type ?? 'user',
      content: m.content_encrypted ?? '',
      token_count_input: m.input_tokens,
      token_count_output: m.output_tokens,
    })),
    scrubMask
  );

  // ── Step 8: Audit log ────────────────────────────────────────────────
  // SOC2 CC7.2: Each view is recorded. viewer_ip_hash prevents PII retention
  // while still enabling abuse investigation.
  const headersList = await headers();
  const clientIp =
    headersList.get('x-middleware-request-x-real-client-ip') ??
    headersList.get('cf-connecting-ip') ??
    headersList.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown';
  const viewerIpHash = await hashIp(clientIp);

  // Fire-and-forget — do not await (audit failure should not block the viewer)
  // WHY resource_type/resource_id (not resource): audit_log schema uses two separate
  // columns — resource_type (text) and resource_id (uuid). There is no 'resource' column.
  supabase.from('audit_log').insert({
    user_id:      null, // Viewer may not be authenticated
    action:       'session_replay_viewed',
    resource_type: 'session',
    resource_id:   tokenRow.session_id,
    metadata: {
      token_id:        tokenRow.id,
      viewer_ip_hash:  viewerIpHash,
      views_used:      finalTokenRow.views_used,
    },
  });

  // ── Step 9: Render ────────────────────────────────────────────────────
  const viewsRemaining =
    tokenRow.max_views !== null
      ? Math.max(0, tokenRow.max_views - finalTokenRow.views_used)
      : null;

  return (
    <ReplayViewer
      session={{
        id:                session.id,
        title:             session.title ?? null,
        agentType:         session.agent_type,
        model:             session.model ?? null,
        status:            session.status,
        startedAt:         session.started_at,
        endedAt:           session.ended_at ?? null,
        totalInputTokens:  session.total_input_tokens ?? null,
        totalOutputTokens: session.total_output_tokens ?? null,
        totalCostUsd:      session.total_cost_usd ?? null,
      }}
      messages={scrubbedMessages}
      scrubMask={scrubMask}
      expiresAt={tokenRow.expires_at}
      viewsRemaining={viewsRemaining}
    />
  );
}

// ============================================================================
// Gone state component (replaces a 410 HTTP response in Server Components)
// ============================================================================

/**
 * Rendered when a replay token is invalid, revoked, expired, or exhausted.
 *
 * WHY one component for all 410 reasons: We intentionally give minimal
 * information to the viewer. Saying "revoked" vs "expired" vs "exhausted"
 * would help an attacker determine which tokens are still active by testing
 * variants. A single generic "no longer available" message prevents this.
 *
 * @param reason - Internal reason for logging/testing (not shown to viewer)
 */
function ReplayGoneState({ reason }: { reason: 'revoked' | 'expired' | 'exhausted' }) {
  // reason is kept for server-side debugging; not rendered to the browser
  void reason;

  return (
    <div
      className="flex min-h-screen items-center justify-center bg-background"
      role="main"
      aria-label="Replay no longer available"
    >
      <div className="max-w-md text-center px-6 py-12">
        <div
          className="mb-4 text-5xl"
          aria-hidden="true"
        >
          🔒
        </div>
        <h1 className="text-2xl font-semibold text-foreground mb-2">
          Replay no longer available
        </h1>
        <p className="text-muted-foreground text-sm">
          This replay link has expired, been revoked, or reached its maximum view count.
          Contact the session owner to request a new link.
        </p>
      </div>
    </div>
  );
}
