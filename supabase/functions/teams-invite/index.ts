/**
 * Team Invitation Edge Function (Phase 2.2)
 *
 * Sends a cryptographically secure team invitation to an email address.
 * Only team owners and admins may invite. Seat cap and rate limit are
 * enforced before any token is generated or email sent.
 *
 * Flow:
 *   1. Parse + validate request body (Zod)
 *   2. Authenticate caller (Supabase JWT)
 *   3. Verify caller has `invite` permission on the team (owner or admin only)
 *   4. Acquire advisory lock on team_id (prevents concurrent seat-cap races)
 *   5. Check seat cap (Task 5 logic inlined — edge fn can't import shared pkg)
 *   6. Check rate limit via Upstash Redis (Task 6 logic inlined)
 *   7. Generate 64-hex-char token; store SHA-256 hash only
 *   8. Upsert team_invitations row
 *   9. Send invitation email via Resend REST API
 *  10. Write audit_log row
 *  11. Return { invitation_id, expires_at }
 *
 * @endpoint POST /functions/v1/teams-invite
 *
 * @auth Required - Supabase JWT (anon or service-role key in Authorization header)
 *   The JWT subject (sub) must be a member of team_id with role 'owner' or 'admin'.
 *
 * @rateLimit 20 invitations per team per 24 hours (Upstash Redis sliding window)
 *
 * @body {
 *   team_id: string (UUID),
 *   email: string (normalized: trim + lowercase),
 *   role: 'admin' | 'member' | 'viewer'
 * }
 *
 * @returns 200 {
 *   invitation_id: string (UUID),
 *   expires_at: string (ISO 8601, 24h from now)
 * }
 *
 * @error 400 { error: 'VALIDATION_ERROR', details: ZodError }
 * @error 401 { error: 'UNAUTHORIZED', message: 'Missing or invalid JWT' }
 * @error 403 { error: 'FORBIDDEN', message: 'Caller lacks invite permission' }
 * @error 402 { error: 'SEAT_CAP_EXCEEDED', upgradeCta: string }
 * @error 409 { error: 'CONCURRENT_INVITE', message: string }
 * @error 429 { error: 'RATE_LIMITED', resetAt: number, retryAfterSeconds: number }
 * @error 500 { error: 'INTERNAL_ERROR', message: string }
 * @error 503 { error: 'LOCK_UNAVAILABLE', message: string }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.47.10';
import { z } from 'https://esm.sh/zod@3.25.76';

// ============================================================================
// Constants
// ============================================================================

/** Invitation TTL: 24 hours (spec requirement). */
const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Rate limit cap: 20 invites per team per 24h sliding window.
 * WHY per team (not per user): A malicious admin rotating through user accounts
 * cannot bypass a per-team cap. A per-user cap would be trivially bypassed.
 */
const RATE_LIMIT_CAP = 20;

/** Sliding window for rate limiting. */
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Resend API base URL. */
const RESEND_API_URL = 'https://api.resend.com/emails';

/** Sender address for invitation emails. */
const FROM_EMAIL = 'hello@styrbyapp.com';
const FROM_NAME = 'Styrby';

// ============================================================================
// Request schema
// ============================================================================

/**
 * Zod schema for the POST body.
 *
 * WHY `.transform` on email: We normalize before storage and comparison so
 * "User@Example.COM" and "user@example.com" are treated identically. This
 * prevents duplicate invitations from slipping through the UNIQUE constraint
 * and prevents enumeration via case differences.
 */
const InviteRequestSchema = z.object({
  team_id: z.string().uuid({ message: 'team_id must be a valid UUID' }),
  email: z
    .string()
    .email({ message: 'email must be a valid email address' })
    .transform((v) => v.trim().toLowerCase()),
  role: z.enum(['admin', 'member', 'viewer'], {
    errorMap: () => ({ message: "role must be 'admin', 'member', or 'viewer'" }),
  }),
});

type InviteRequest = z.infer<typeof InviteRequestSchema>;

// ============================================================================
// Types
// ============================================================================

interface TeamMemberRow {
  role: 'owner' | 'admin' | 'member';
}

interface TeamRow {
  id: string;
  name: string;
  seat_cap: number | null;
  active_seats: number;
}

interface InvitationRow {
  id: string;
  expires_at: string;
}

interface ProfileRow {
  display_name: string | null;
  email: string | null;
}

// ============================================================================
// Crypto helpers
// ============================================================================

/**
 * Generates a cryptographically random invitation token.
 *
 * Token composition:
 *   - Deno.randomUUID() (128-bit UUID, removes hyphens = 32 hex chars)
 *   - 32 bytes from crypto.getRandomValues, hex-encoded (64 hex chars)
 *   - Concatenated: 96 hex chars total, well above the 64-char minimum
 *
 * WHY two entropy sources:
 *   UUID v4 uses the CSPRNG but is bounded to 122 bits. Adding an independent
 *   32-byte random value (256 bits) ensures the token has at least 378 bits
 *   of total entropy, making brute-force infeasible even if UUID generation
 *   were somehow weakened.
 *
 * @returns Raw token string (96 hex chars, never stored)
 */
function generateInviteToken(): string {
  const uuidPart = crypto.randomUUID().replace(/-/g, ''); // 32 hex chars
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  const randomPart = Array.from(randomBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(''); // 64 hex chars
  return uuidPart + randomPart; // 96 hex chars
}

/**
 * Computes the SHA-256 hex digest of a token string.
 *
 * WHY store hash only:
 *   If the database is compromised, attackers cannot use a leaked token_hash
 *   to accept invitations — they need the raw token, which only exists in the
 *   email sent to the recipient. This is the same approach used for API keys
 *   (SEC-009) and password reset tokens.
 *
 * The accept flow (Unit B) receives the raw token from the URL, hashes it,
 * and looks up by token_hash. Comparison is hash-to-hash, so timing-safe
 * equality (crypto.timingSafeEqual or constant-time string compare) applies
 * to the DB lookup rather than to a direct token comparison.
 *
 * @param token - Raw token string to hash
 * @returns Hex-encoded SHA-256 digest (64 chars)
 */
async function sha256Hex(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ============================================================================
// Rate limiter (Upstash Redis sliding window)
// ============================================================================

/**
 * Checks and records an invite attempt in the per-team sliding window.
 *
 * Uses the Upstash REST API directly (fetch) since edge functions cannot
 * import the @upstash/redis npm package.
 *
 * WHY fetch instead of @upstash/redis:
 *   Deno edge functions run in a sandboxed environment. The Upstash Redis
 *   client for npm requires Node.js-compatible module resolution that Deno
 *   doesn't guarantee at runtime without a compatibility shim. The REST API
 *   is environment-agnostic and equally secure.
 *
 * @param teamId - Team UUID (rate limit key is scoped to team, not user)
 * @returns Rate limit result
 */
async function checkTeamRateLimit(
  teamId: string,
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const redisUrl = Deno.env.get('UPSTASH_REDIS_REST_URL');
  const redisToken = Deno.env.get('UPSTASH_REDIS_REST_TOKEN');

  // WHY fail-open on missing Redis creds:
  //   If Redis is not configured (e.g., staging environment without Upstash),
  //   we allow the request rather than blocking all invitations. Rate limiting
  //   is a safeguard, not a hard dependency. An operator misconfiguration
  //   should not silently break the invitation flow for all users.
  //   We log a warning so monitoring catches the missing config.
  if (!redisUrl || !redisToken) {
    console.warn(
      '[teams-invite] UPSTASH_REDIS_REST_URL/TOKEN not set — rate limiting disabled',
    );
    return { allowed: true, remaining: RATE_LIMIT_CAP, resetAt: Date.now() + RATE_LIMIT_WINDOW_MS };
  }

  const key = `rate-limit:team-invite:${teamId}`;
  const nowMs = Date.now();
  const windowStartMs = nowMs - RATE_LIMIT_WINDOW_MS;
  const member = `${nowMs}-${crypto.randomUUID()}`;

  // Execute sliding window operations via Upstash pipeline.
  // Pipeline: ZADD → ZREMRANGEBYSCORE → ZCARD — all in one HTTP round-trip.
  const pipeline = [
    ['ZADD', key, String(nowMs), member],
    ['ZREMRANGEBYSCORE', key, '0', String(windowStartMs)],
    ['ZCARD', key],
    ['EXPIRE', key, String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000))],
  ];

  const response = await fetch(`${redisUrl}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${redisToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(pipeline),
  });

  if (!response.ok) {
    // WHY fail-open: same reasoning as missing credentials above.
    console.error('[teams-invite] Redis pipeline failed, allowing request:', response.status);
    return { allowed: true, remaining: RATE_LIMIT_CAP, resetAt: nowMs + RATE_LIMIT_WINDOW_MS };
  }

  // Pipeline response is an array of [error, result] pairs.
  // Index 2 is ZCARD result.
  const results = await response.json() as Array<{ result: unknown; error: string | null }>;
  const count = typeof results[2]?.result === 'number' ? results[2].result : 0;

  const allowed = count <= RATE_LIMIT_CAP;
  const remaining = Math.max(0, RATE_LIMIT_CAP - count);
  const resetAt = nowMs + RATE_LIMIT_WINDOW_MS;

  return { allowed, remaining, resetAt };
}

// ============================================================================
// Email sender
// ============================================================================

/**
 * Sends the team invitation email via Resend REST API.
 *
 * WHY Resend REST API directly (not the SDK):
 *   The Resend npm SDK requires Node.js module resolution. Edge functions run
 *   in Deno. The REST API is equivalent and environment-agnostic.
 *
 * The email body is plain HTML (no React Email at runtime in edge functions).
 * React Email templates in packages/styrby-web/src/emails/ are compiled to
 * HTML by the web server and used for Next.js API routes. For the edge
 * function we render a structured HTML email inline.
 *
 * @param params - Email parameters
 * @throws {Error} When RESEND_API_KEY is not set or the API call fails
 */
async function sendInvitationEmail(params: {
  toEmail: string;
  teamName: string;
  inviterName: string;
  inviterEmail: string;
  role: 'admin' | 'member' | 'viewer';
  inviteUrl: string;
  expiresAt: string;
}): Promise<void> {
  const apiKey = Deno.env.get('RESEND_API_KEY');
  if (!apiKey) {
    // WHY warn-and-skip rather than throw:
    //   Invitation records should still be created even if email sending fails.
    //   The recipient can request a resend. A missing API key should not
    //   silently corrupt the invitation state — so we log loudly but don't
    //   prevent the invitation row from being created.
    console.error('[teams-invite] RESEND_API_KEY not set — invitation created but email not sent');
    return;
  }

  const roleLabel =
    params.role === 'admin'
      ? 'an admin'
      : params.role === 'viewer'
      ? 'a viewer'
      : 'a member';

  const expirationDate = new Date(params.expiresAt).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  // Structured HTML email — minimal, functional, consistent with Styrby brand.
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="background:#09090b;color:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;padding:32px 16px;">
  <div style="max-width:560px;margin:0 auto;background:#18181b;border-radius:8px;padding:32px;border:1px solid #27272a;">
    <h1 style="color:#fafafa;font-size:24px;margin:0 0 16px;">You're invited to join ${escapeHtml(params.teamName)}</h1>
    <p style="color:#a1a1aa;margin:0 0 16px;">
      <strong style="color:#fafafa;">${escapeHtml(params.inviterName)}</strong> (${escapeHtml(params.inviterEmail)})
      has invited you to join <strong style="color:#fafafa;">${escapeHtml(params.teamName)}</strong> as
      ${roleLabel} on Styrby.
    </p>
    <p style="color:#a1a1aa;margin:0 0 24px;">
      As a team member, you'll be able to view shared coding sessions,
      collaborate on projects, and track costs together.
    </p>
    <div style="text-align:center;margin:24px 0;">
      <a href="${params.inviteUrl}" style="display:inline-block;background:#3b82f6;color:#ffffff;text-decoration:none;padding:12px 32px;border-radius:6px;font-weight:600;font-size:16px;">
        Accept Invitation
      </a>
    </div>
    <hr style="border:none;border-top:1px solid #27272a;margin:24px 0;">
    <table style="width:100%;margin-bottom:16px;">
      <tr><td style="color:#a1a1aa;font-size:14px;padding:4px 0;"><strong style="color:#fafafa;">Team:</strong> ${escapeHtml(params.teamName)}</td></tr>
      <tr><td style="color:#a1a1aa;font-size:14px;padding:4px 0;"><strong style="color:#fafafa;">Your role:</strong> ${params.role === 'admin' ? 'Admin' : params.role === 'viewer' ? 'Viewer' : 'Member'}</td></tr>
      <tr><td style="color:#a1a1aa;font-size:14px;padding:4px 0;"><strong style="color:#fafafa;">Invited by:</strong> ${escapeHtml(params.inviterName)}</td></tr>
    </table>
    <p style="color:#a1a1aa;font-size:14px;margin:0 0 16px;">
      This invitation expires on <strong style="color:#fafafa;">${expirationDate}</strong>.
      If you don't want to join this team, you can ignore this email.
    </p>
    <p style="color:#71717a;font-size:12px;margin:0;">The Styrby Team</p>
  </div>
</body>
</html>`;

  const result = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: params.toEmail,
      subject: `You've been invited to join ${params.teamName} on Styrby`,
      html,
    }),
  });

  if (!result.ok) {
    const body = await result.text();
    throw new Error(`Resend API error ${result.status}: ${body}`);
  }
}

/**
 * Minimal HTML entity escaper for user-controlled strings in email HTML.
 *
 * WHY: Invitation emails include user-controlled values (team name, inviter
 * name, email). Without escaping, a team named `<script>alert(1)</script>`
 * could inject HTML into the email client. The set of chars escaped here
 * covers all common HTML injection vectors.
 *
 * @param unsafe - User-supplied string
 * @returns HTML-safe string
 */
function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ============================================================================
// Main handler
// ============================================================================

Deno.serve(async (req: Request): Promise<Response> => {
  // CORS preflight.
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      },
    });
  }

  if (req.method !== 'POST') {
    return jsonError(405, 'METHOD_NOT_ALLOWED', 'Only POST is supported');
  }

  // ── Step 1: Parse + validate request body ────────────────────────────────

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'INVALID_JSON', 'Request body must be valid JSON');
  }

  const parsed = InviteRequestSchema.safeParse(body);
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const { team_id: teamId, email, role } = parsed.data;

  // ── Step 2: Authenticate caller ───────────────────────────────────────────

  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonError(401, 'UNAUTHORIZED', 'Missing or invalid Authorization header');
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('[teams-invite] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');
    return jsonError(500, 'INTERNAL_ERROR', 'Server configuration error');
  }

  // Create a user-scoped client to validate the JWT and extract the user ID.
  const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error: authError } = await userClient.auth.getUser();
  if (authError || !user) {
    return jsonError(401, 'UNAUTHORIZED', 'Invalid or expired JWT');
  }

  const callerId = user.id;

  // Use service-role client for all subsequent DB operations (bypasses RLS).
  // WHY service role: The RLS policies on team_invitations require membership
  // checks that can deadlock with advisory locks. We enforce permission at the
  // application level (step 3 below) using the service-role client.
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  });

  // ── Step 3: Verify caller has invite permission ───────────────────────────

  const { data: membership, error: memberError } = await supabase
    .from('team_members')
    .select('role')
    .eq('team_id', teamId)
    .eq('user_id', callerId)
    .single<TeamMemberRow>();

  if (memberError || !membership) {
    return jsonError(403, 'FORBIDDEN', 'You are not a member of this team');
  }

  // WHY owner + admin only (not approver or member):
  //   The role-matrix (packages/styrby-shared/src/team/role-matrix.ts) defines
  //   canInvite(role) → owner and admin only. We inline the check here because
  //   the shared package cannot be imported in Deno edge functions without
  //   a bundling step. The logic is identical to canInvite() in the matrix.
  if (membership.role !== 'owner' && membership.role !== 'admin') {
    return jsonError(403, 'FORBIDDEN', 'Only team owners and admins can send invitations');
  }

  // ── Step 4: Acquire advisory lock on team_id (seat-cap race prevention) ──

  // WHY advisory lock:
  //   Two concurrent invite requests for the same team could both pass the
  //   seat-cap check before either inserts the invitation row, allowing the
  //   team to exceed its cap. pg_try_advisory_xact_lock acquires a session-level
  //   lock that is released at the end of the transaction. We use the lower 32
  //   bits of a stable hash of the team UUID as the lock ID.
  //   If the lock is not immediately available (another invite in progress),
  //   we return 409 rather than blocking indefinitely (try vs. advisory_lock).
  //
  // NOTE: Supabase Edge Functions do not support long-running DB transactions
  // across multiple round-trips. The advisory lock is acquired per-statement
  // and released when the connection is returned to the pool. This is a
  // best-effort guard; the UNIQUE constraint on (team_id, email) and
  // (token_hash) provide the hard safety net.
  const teamIdHash = await teamIdToAdvisoryLockId(teamId);
  const { data: lockAcquired, error: lockError } = await supabase.rpc(
    'acquire_team_invite_lock',
    { team_lock_key: teamIdHash },
  );

  if (lockError) {
    console.error('[teams-invite] Advisory lock RPC failed:', lockError);
    return jsonError(503, 'LOCK_UNAVAILABLE', 'Could not acquire seat-cap lock. Please retry.');
  }

  if (lockAcquired === false) {
    // Another request holds the lock - contended, client should retry
    return jsonError(409, 'CONCURRENT_INVITE', 'Another invite is being processed for this team. Please retry.');
  }

  // lockAcquired === true: proceed with seat-cap check + insert

  // ── Step 5: Check seat cap ────────────────────────────────────────────────

  const { data: team, error: teamError } = await supabase
    .from('teams')
    .select('id, name, seat_cap, active_seats')
    .eq('id', teamId)
    .single<TeamRow>();

  if (teamError || !team) {
    return jsonError(404, 'TEAM_NOT_FOUND', 'Team not found');
  }

  if (team.seat_cap !== null && team.active_seats >= team.seat_cap) {
    return new Response(
      JSON.stringify({
        error: 'SEAT_CAP_EXCEEDED',
        message: `This team has reached its ${team.seat_cap}-seat limit.`,
        upgradeCta: `/billing/add-seat?team=${teamId}`,
        currentSeats: team.active_seats,
        seatCap: team.seat_cap,
      }),
      { status: 402, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Log a warning if seat_cap is NULL (Phase 2.6 not yet deployed).
  if (team.seat_cap === null) {
    console.warn(
      `[teams-invite] team ${teamId} has no seat_cap — treating as unlimited (Phase 2.6 pending)`,
    );
  }

  // ── Step 6: Check rate limit ──────────────────────────────────────────────

  const rl = await checkTeamRateLimit(teamId);
  if (!rl.allowed) {
    const retryAfterSeconds = Math.ceil((rl.resetAt - Date.now()) / 1000);
    return new Response(
      JSON.stringify({
        error: 'RATE_LIMITED',
        message: `This team has sent too many invitations. Try again after the rate limit resets.`,
        resetAt: rl.resetAt,
        retryAfterSeconds,
      }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(retryAfterSeconds),
        },
      },
    );
  }

  // ── Step 7: Generate token + SHA-256 hash ─────────────────────────────────

  const rawToken = generateInviteToken(); // 96-hex chars, never stored
  const tokenHash = await sha256Hex(rawToken); // stored in DB
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();

  // ── Step 8: Upsert invitation row ─────────────────────────────────────────

  // WHY upsert (not insert): The UNIQUE constraint on (team_id, email) means
  // a second invite to the same email re-uses the existing row, updating the
  // token_hash and expiry. This is intentional: re-inviting a previously
  // declined or expired email address resets the invitation window without
  // creating orphaned rows.
  //
  // The `token` column (legacy plain-text field from migration 006) is set to
  // a placeholder value ('HASHED' prefix) to satisfy the NOT NULL + UNIQUE
  // constraint. Migration 027 makes token_hash the authoritative field.
  // WHY keep `token` column at all: Dropping it is a breaking schema change
  // that requires coordinating with Unit B (accept flow) and potential data
  // backfill. We keep it populated with a meaningless sentinel until a
  // separate cleanup migration removes the column entirely in Phase 2.3.
  // WHY opaque UUID instead of a hash-derived sentinel: the legacy `token` column
  // (migration 006 NOT NULL UNIQUE) must be populated for backwards compat, but
  // we must not leak any part of the real token_hash via a queryable column.
  // A fresh UUID is cryptographically independent of the token and safe to expose.
  const legacyTokenSentinel = crypto.randomUUID();

  const { data: invitation, error: upsertError } = await supabase
    .from('team_invitations')
    .upsert(
      {
        team_id: teamId,
        email,
        role,
        token: legacyTokenSentinel,
        token_hash: tokenHash,
        expires_at: expiresAt,
        invited_by: callerId,
        status: 'pending',
      },
      {
        onConflict: 'team_id,email',
        ignoreDuplicates: false,
      },
    )
    .select('id, expires_at')
    .single<InvitationRow>();

  if (upsertError || !invitation) {
    console.error('[teams-invite] Failed to upsert invitation:', upsertError);
    return jsonError(500, 'INTERNAL_ERROR', 'Failed to create invitation record');
  }

  // ── Step 9: Send invitation email ─────────────────────────────────────────

  // Fetch inviter's display name for the email.
  const { data: profile } = await supabase
    .from('profiles')
    .select('display_name, email')
    .eq('id', callerId)
    .single<ProfileRow>();

  const inviterName = profile?.display_name ?? profile?.email ?? 'A team admin';
  const inviterEmail = profile?.email ?? '';

  const appUrl = Deno.env.get('NEXT_PUBLIC_APP_URL') ?? 'https://styrbyapp.com';
  const inviteUrl = `${appUrl}/invite/accept?token=${rawToken}`;

  let emailSent = false;
  try {
    await sendInvitationEmail({
      toEmail: email,
      teamName: team.name,
      inviterName,
      inviterEmail,
      role,
      inviteUrl,
      expiresAt: invitation.expires_at,
    });
    emailSent = true;
  } catch (emailError) {
    // WHY warn-and-continue: Email failure does not invalidate the invitation.
    // The invitation row exists and can be resent. Throwing here would
    // leave the invitation in the DB but return an error, confusing the caller.
    console.error('[teams-invite] Email send failed:', emailError);
  }

  // ── Step 10: Write audit_log row ──────────────────────────────────────────

  // Audit log always records the invite creation, including whether email was sent.
  const { error: auditError } = await supabase.from('audit_log').insert({
    user_id: callerId,
    action: 'team_invite_sent',
    resource_type: 'team_invitation',
    resource_id: invitation.id,
    metadata: {
      team_id: teamId,
      invited_email: email,
      role,
      email_sent: emailSent,
    },
  });

  if (auditError) {
    // WHY warn-and-continue: Audit log failure does not invalidate the invite.
    // The invitation was created and the email was sent. Audit logs are
    // eventually-consistent by design — a single missed row is acceptable.
    // SEC concern: Log the failure so it's visible in Supabase function logs.
    console.error('[teams-invite] Failed to write audit_log row:', auditError);
  }

  // If email failed, add a second audit row explicitly so ops can detect and
  // retry. The audit_action enum 'team_invite_email_failed' is added in
  // migration 030 (ALTER TYPE audit_action ADD VALUE IF NOT EXISTS ...).
  if (!emailSent) {
    const { error: emailAuditError } = await supabase.from('audit_log').insert({
      user_id: callerId,
      action: 'team_invite_email_failed',
      resource_type: 'team_invitation',
      resource_id: invitation.id,
      metadata: { team_id: teamId, invited_email: email, role },
    });
    if (emailAuditError) {
      console.error('[teams-invite] Failed to write email_failed audit_log row:', emailAuditError);
    }
  }

  // ── Step 11: Return success ───────────────────────────────────────────────

  // IMPORTANT: Never return the raw token or token_hash in the response.
  // The token was already sent via email; the response only confirms creation.
  return new Response(
    JSON.stringify({
      invitation_id: invitation.id,
      expires_at: invitation.expires_at,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
});

// ============================================================================
// Helpers
// ============================================================================

/**
 * Converts a team UUID to a stable 32-bit integer for use as a PostgreSQL
 * advisory lock ID.
 *
 * WHY hash vs. UUID numeric value:
 *   UUIDs are 128-bit; pg_try_advisory_lock takes two INT4 or one INT8.
 *   We hash the UUID bytes to an INT8 (FNV-1a 64-bit equivalent via
 *   SHA-256 first-8-bytes). Collisions are possible but astronomically
 *   rare for the small number of concurrent teams that would contend.
 *   A collision means two unrelated teams briefly share a lock — they
 *   serialize unnecessarily but correctness is not violated.
 *
 * @param teamId - Team UUID string
 * @returns INT8-range lock ID (first 8 bytes of SHA-256, read as BigInt)
 */
async function teamIdToAdvisoryLockId(teamId: string): Promise<number> {
  const hashHex = await sha256Hex(teamId);
  // Read first 8 hex chars = 4 bytes = 32-bit value (safe for Postgres INT4).
  // We use 32-bit (not 64-bit) to avoid BigInt serialization complexity.
  const int32 = parseInt(hashHex.slice(0, 8), 16);
  return int32;
}

/**
 * Returns a standardized JSON error response.
 *
 * @param status - HTTP status code
 * @param error - Error code string
 * @param message - Human-readable error message
 * @returns Response with JSON body
 */
function jsonError(status: number, error: string, message: string): Response {
  return new Response(
    JSON.stringify({ error, message }),
    {
      status,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}
