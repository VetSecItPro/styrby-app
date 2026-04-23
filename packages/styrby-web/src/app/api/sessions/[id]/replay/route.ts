/**
 * POST /api/sessions/[id]/replay
 *
 * Creates a new session replay token for the given session. The token grants
 * time-limited, view-limited, scrub-masked replay access to anyone who has the URL.
 *
 * WHY one-time signed tokens instead of direct share links:
 *   Session messages are E2E-encrypted at rest. Replay requires server-side
 *   decryption (service-role) and scrubbing before delivery to the viewer.
 *   A token with an embedded scrub mask lets the creator configure exactly
 *   what information the viewer sees — without exposing raw decrypted content.
 *
 * Security contracts:
 *   - Raw token is generated server-side with 96 hex chars of crypto.getRandomValues()
 *   - Only SHA-256 hash stored in DB (token_hash column) — DB breach cannot
 *     replay existing links
 *   - Raw token appears in the response URL exactly once; never logged
 *   - Token lookup uses timing-safe comparison (see /replay/[token] viewer page)
 *   - Viewer authentication is NOT required — the URL token IS the credential
 *
 * SOC2 CC7.2: Controlled disclosure. Every token creation is audit-logged.
 *   Viewers are tracked via views_used increment (no user_id needed).
 *
 * @auth Required - Supabase Auth JWT via cookie or Authorization: Bearer header
 * @rateLimit 10 requests per minute (sensitive — token creation)
 *
 * @body {
 *   duration: '1h' | '24h' | '7d' | '30d'
 *   maxViews: 1 | 5 | 10 | 'unlimited'
 *   scrubMask: { secrets: boolean, file_paths: boolean, commands: boolean }
 * }
 *
 * @returns 201 {
 *   token: SessionReplayToken,
 *   url: string  — full replay URL (only time raw token appears)
 * }
 *
 * @error 400 { error: 'VALIDATION_ERROR', message: string }
 * @error 401 { error: 'UNAUTHORIZED', message: string }
 * @error 403 { error: 'FORBIDDEN', message: string } — session not owned by caller
 * @error 404 { error: 'NOT_FOUND', message: string }
 * @error 429 { error: 'RATE_LIMITED', retryAfter: number }
 * @error 500 { error: 'INTERNAL_ERROR', message: string }
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';
import { getAppUrl } from '@/lib/config';
import type { CreateReplayTokenResponse, SessionReplayToken } from '@styrby/shared/session-replay';

// ============================================================================
// Duration mapping: string label → Postgres interval-compatible offset (ms)
// ============================================================================

const DURATION_MS: Record<string, number> = {
  '1h':  1 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d':  7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

// ============================================================================
// Request validation schema
// ============================================================================

/**
 * Zod schema for the POST body.
 *
 * WHY maxViews as union: The UI offers 1/5/10/unlimited. 'unlimited' maps to
 * null in the DB. Using a union keeps the API surface explicit and prevents
 * callers from passing arbitrary large numbers to circumvent view limits.
 */
const CreateReplaySchema = z.object({
  duration: z.enum(['1h', '24h', '7d', '30d']),
  maxViews: z.union([z.literal(1), z.literal(5), z.literal(10), z.literal('unlimited')]),
  scrubMask: z.object({
    secrets:    z.boolean(),
    file_paths: z.boolean(),
    commands:   z.boolean(),
  }),
});

// ============================================================================
// Token generation
// ============================================================================

/**
 * Generates a cryptographically random 96-character hex token.
 *
 * 96 hex chars = 48 bytes = 384 bits of entropy. This is well above the
 * OWASP minimum of 128 bits for session tokens.
 *
 * WHY Web Crypto API: Available in all Next.js runtimes (Node, Edge, Vercel).
 *
 * @returns 96-character lowercase hex string
 */
function generateRawToken(): string {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Computes SHA-256 hex digest of a string using Web Crypto API.
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

// ============================================================================
// Route handler
// ============================================================================

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, { params }: RouteParams) {
  const { id: sessionId } = await params;

  // ── Rate limit ────────────────────────────────────────────────────────────
  const rl = await rateLimit(request as Parameters<typeof rateLimit>[0], RATE_LIMITS.sensitive, `replay-create:${sessionId}`);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfter!);

  // ── Auth ──────────────────────────────────────────────────────────────────
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'UNAUTHORIZED', message: 'Authentication required' }, { status: 401 });
  }

  // ── Body validation ───────────────────────────────────────────────────────
  let body: z.infer<typeof CreateReplaySchema>;
  try {
    const raw = await request.json();
    body = CreateReplaySchema.parse(raw);
  } catch (err) {
    const message = err instanceof z.ZodError ? (err.errors[0]?.message ?? 'Validation failed') : 'Invalid request body';
    return NextResponse.json({ error: 'VALIDATION_ERROR', message }, { status: 400 });
  }

  // ── Verify session ownership ──────────────────────────────────────────────
  // WHY user-scoped client for this check: We want RLS to enforce ownership.
  // The service-role client (used later for the insert) bypasses RLS, so we
  // must verify ownership here first.
  const { data: session, error: sessionError } = await supabase
    .from('sessions')
    .select('id, user_id')
    .eq('id', sessionId)
    .is('deleted_at', null)
    .maybeSingle();

  if (sessionError) {
    console.error('[replay:create] session lookup error', sessionError);
    return NextResponse.json({ error: 'INTERNAL_ERROR', message: 'Database error' }, { status: 500 });
  }

  if (!session) {
    return NextResponse.json({ error: 'NOT_FOUND', message: 'Session not found' }, { status: 404 });
  }

  if (session.user_id !== user.id) {
    return NextResponse.json({ error: 'FORBIDDEN', message: 'You do not own this session' }, { status: 403 });
  }

  // ── Look up creator's profile ID ──────────────────────────────────────────
  const { data: profile } = await supabase
    .from('profiles')
    .select('id')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile) {
    return NextResponse.json({ error: 'INTERNAL_ERROR', message: 'Profile not found' }, { status: 500 });
  }

  // ── Generate token ────────────────────────────────────────────────────────
  const rawToken = generateRawToken();
  const tokenHash = await sha256Hex(rawToken);

  const expiresAt = new Date(Date.now() + DURATION_MS[body.duration]).toISOString();
  const maxViews = body.maxViews === 'unlimited' ? null : body.maxViews;

  // ── Insert token (service-role for audit-log write, RLS check already done)
  // WHY: The replay_tokens table RLS allows INSERT WHERE created_by = auth.uid().
  // We use the user-scoped client here so RLS is enforced at the DB layer too.
  const { data: tokenRow, error: insertError } = await supabase
    .from('session_replay_tokens')
    .insert({
      session_id:  sessionId,
      created_by:  profile.id,
      token_hash:  tokenHash,
      expires_at:  expiresAt,
      max_views:   maxViews,
      scrub_mask:  body.scrubMask,
    })
    .select('id, session_id, created_by, expires_at, max_views, views_used, scrub_mask, revoked_at, created_at')
    .single();

  if (insertError || !tokenRow) {
    console.error('[replay:create] insert error', insertError);
    return NextResponse.json({ error: 'INTERNAL_ERROR', message: 'Failed to create replay token' }, { status: 500 });
  }

  // ── Audit log ─────────────────────────────────────────────────────────────
  // SOC2 CC7.2: Every token creation is recorded. The raw token is NOT logged;
  // only the token_id UUID is stored so forensics can correlate without replay risk.
  await supabase.from('audit_log').insert({
    user_id:    user.id,
    action:     'session_replay_token_created',
    resource:   `session:${sessionId}`,
    metadata:   { token_id: tokenRow.id, duration: body.duration, max_views: maxViews },
  });

  // ── Build response ────────────────────────────────────────────────────────
  // WHY /replay/ not /r/: /r/ is already used for referral codes. Using a
  // distinct path prevents ambiguity and simplifies middleware routing.
  const replayUrl = `${getAppUrl()}/replay/${rawToken}`;

  const token: SessionReplayToken = {
    id:          tokenRow.id,
    sessionId:   tokenRow.session_id,
    createdBy:   tokenRow.created_by,
    expiresAt:   tokenRow.expires_at,
    maxViews:    tokenRow.max_views,
    viewsUsed:   tokenRow.views_used,
    scrubMask:   tokenRow.scrub_mask as SessionReplayToken['scrubMask'],
    revokedAt:   tokenRow.revoked_at,
    createdAt:   tokenRow.created_at,
  };

  const responseBody: CreateReplayTokenResponse = { token, url: replayUrl };
  return NextResponse.json(responseBody, { status: 201 });
}
