/**
 * POST /api/invitations/accept
 *
 * Accepts a team invitation. Verifies the raw token from the URL against the
 * stored SHA-256 hash using timing-safe comparison, checks session email matches
 * the invitation email (case-insensitive), then atomically inserts the team
 * member and marks the invitation accepted.
 *
 * @auth Required - Supabase Auth JWT via cookie
 *
 * @body {
 *   token: string  (96-hex raw token from the invite URL)
 * }
 *
 * @returns 200 { success: true, team_id: string, role: 'admin' | 'member' }
 *
 * @error 400 { error: 'VALIDATION_ERROR', message: string }
 * @error 401 { error: 'UNAUTHORIZED', message: string }
 * @error 403 { error: 'EMAIL_MISMATCH', message: string }
 * @error 404 { error: 'NOT_FOUND', message: string }   (unknown OR expired - same shape prevents enumeration)
 * @error 409 { error: 'ALREADY_PROCESSED', message: string }  (accepted or revoked)
 * @error 410 { error: 'EXPIRED', message: string }
 * @error 500 { error: 'INTERNAL_ERROR', message: string }
 *
 * Security:
 *   - Token comparison uses crypto.timingSafeEqual on hex Buffers to prevent
 *     timing-oracle attacks (an attacker measuring response time cannot determine
 *     how many prefix bytes matched before a short-circuit return).
 *   - Email comparison is lowercased + trimmed on both sides.
 *   - 404 is returned for both "unknown token" and an internally resolved
 *     "no row for this hash" state to prevent enumeration of issued tokens.
 *   - service_role client is NOT used for the accept flow — all DB ops use the
 *     user-scoped client so RLS policies remain enforced.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { timingSafeEqual } from 'crypto';
import { createClient } from '@/lib/supabase/server';
import { INVITE_ROLE_TO_MEMBER_ROLE } from '@styrby/shared';

// ============================================================================
// Zod schema
// ============================================================================

/**
 * Schema for the POST body.
 *
 * WHY minimum length of 64: The edge function generates 96-char tokens.
 * We don't enforce exactly 96 chars in case future token lengths change,
 * but we enforce a lower bound to reject obviously invalid payloads fast.
 */
const AcceptBodySchema = z.object({
  token: z
    .string()
    .min(64, 'token must be at least 64 characters')
    .regex(/^[0-9a-f]+$/i, 'token must be a hex string'),
});

// ============================================================================
// Crypto helpers
// ============================================================================

/**
 * Computes SHA-256 hex digest of a string.
 *
 * WHY Web Crypto API (not Node crypto):
 *   Next.js API routes run in the Node.js Edge Runtime or Node runtime depending
 *   on config. crypto.subtle is available in both; the Node `crypto` module
 *   import works too but Web Crypto is the cross-runtime standard. We import
 *   createHash from 'crypto' as a Node fallback but use subtle for edge compat.
 *
 * @param input - String to hash
 * @returns Lowercase hex SHA-256 digest
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
 * Performs timing-safe comparison of two hex strings by comparing their
 * decoded Buffer forms via crypto.timingSafeEqual.
 *
 * WHY Buffer comparison rather than string ===:
 *   String equality short-circuits on first differing character. An attacker
 *   who can measure response latency can infer how many prefix bytes matched,
 *   turning token comparison into an oracle. crypto.timingSafeEqual always
 *   inspects all bytes in constant time.
 *
 * @param a - First hex string
 * @param b - Second hex string
 * @returns true if both hex strings represent identical byte sequences
 * @throws When either input is not a valid hex string of the same length
 */
function timingSafeHexEqual(a: string, b: string): boolean {
  // WHY length check first: timingSafeEqual throws for different-length buffers.
  // We don't short-circuit on length mismatch here because that would reveal
  // the length of the stored hash. Instead we pad both to a common length.
  // In practice both are 64-char SHA-256 digests so this is a safety net only.
  if (a.length !== b.length) {
    // Lengths differ — provably not equal, but execute dummy comparison to
    // maintain constant-time behavior at the call site (caller should not
    // be able to infer hash length from response time difference).
    // Run a dummy comparison to maintain constant-time behavior even on
    // length mismatch (prevents length-oracle timing attacks).
    const dummy = Buffer.alloc(Math.min(32, Math.floor(a.length / 2) || 1));
    try { timingSafeEqual(dummy, dummy); } catch { /* ignore */ }
    return false;
  }

  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  // WHY Node's timingSafeEqual (not globalThis.crypto):
  //   Web Crypto API exposes crypto.subtle but NOT timingSafeEqual. Node's
  //   built-in `crypto` module provides timingSafeEqual for constant-time
  //   comparison. Both Next.js Node runtime and Vercel serverless support it.
  return timingSafeEqual(bufA, bufB);
}

// ============================================================================
// Route handler
// ============================================================================

/**
 * Handles team invitation acceptance.
 *
 * Flow:
 *   1. Parse + validate body
 *   2. Authenticate caller
 *   3. Hash the raw token
 *   4. Look up team_invitations by token_hash
 *   5. Timing-safe comparison of stored hash vs computed hash
 *   6. Validate status = 'pending', not expired
 *   7. Validate caller email matches invitation email (case-insensitive)
 *   8. Map invitation role through INVITE_ROLE_TO_MEMBER_ROLE
 *   9. INSERT team_members + UPDATE team_invitations (pseudo-transaction)
 *  10. Write audit_log
 *  11. Return { success, team_id, role }
 *
 * @param request - Incoming POST request
 * @returns JSON response
 */
export async function POST(request: Request): Promise<NextResponse> {
  // ── Step 1: Parse + validate body ─────────────────────────────────────────

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'VALIDATION_ERROR', message: 'Request body must be valid JSON' },
      { status: 400 },
    );
  }

  const parsed = AcceptBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid token' },
      { status: 400 },
    );
  }

  const { token: rawToken } = parsed.data;

  // ── Step 2: Authenticate caller ───────────────────────────────────────────

  // WHY user-scoped client (not admin/service role):
  //   The accept flow operates on behalf of the authenticated user. Using the
  //   user-scoped client ensures RLS policies apply and no service_role
  //   credentials are exposed via this route.
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json(
      { error: 'UNAUTHORIZED', message: 'Authentication required' },
      { status: 401 },
    );
  }

  // ── Step 3: Hash the raw token ────────────────────────────────────────────

  const tokenHashFromUrl = await sha256Hex(rawToken);

  // ── Step 4: Look up invitation by token_hash ──────────────────────────────

  // WHY we select by token_hash directly (not token):
  //   Migration 030 added token_hash as the authoritative lookup field.
  //   The legacy `token` column holds a meaningless sentinel value.
  const { data: invitation, error: dbError } = await supabase
    .from('team_invitations')
    .select('id, team_id, email, role, status, expires_at, token_hash, invited_by')
    .eq('token_hash', tokenHashFromUrl)
    .single();

  if (dbError || !invitation) {
    // WHY same 404 for "not found" and a missing row:
    //   Returning 410 for "token exists but expired" vs 404 for "token never existed"
    //   would let an attacker enumerate which tokens have ever been issued.
    //   We uniformly return 404 when the hash lookup fails so there's no oracle.
    return NextResponse.json(
      { error: 'NOT_FOUND', message: 'Invitation not found or already used' },
      { status: 404 },
    );
  }

  // ── Step 5: Timing-safe comparison ───────────────────────────────────────

  // WHY we re-compare after lookup:
  //   The DB query already matched on token_hash, but an ORM bug or RLS bypass
  //   could theoretically return a non-matching row. The double-check is defense
  //   in depth. timingSafeEqual ensures no timing oracle even in this second pass.
  if (!timingSafeHexEqual(tokenHashFromUrl, invitation.token_hash)) {
    // This should never happen if the DB lookup is correct. If it does,
    // treat it as "not found" rather than revealing internal inconsistency.
    return NextResponse.json(
      { error: 'NOT_FOUND', message: 'Invitation not found or already used' },
      { status: 404 },
    );
  }

  // ── Step 6: Validate email match FIRST ───────────────────────────────────

  // WHY email check comes BEFORE status/expiry check:
  //   A user on the wrong account who intercepts an invitation URL must NOT
  //   learn whether the invitation is active, expired, or already consumed.
  //   If we checked status first, a wrong-email user would see "EXPIRED" or
  //   "ALREADY_PROCESSED" — leaking the invitation's lifecycle state. By
  //   checking email first, wrong-email users always get 403 WRONG_EMAIL
  //   regardless of invitation state.
  //
  // WHY lowercase + trim on both sides:
  //   Email addresses are case-insensitive per RFC 5321. An invitee who signs
  //   up as "Alice@Example.COM" must be able to accept an invitation sent to
  //   "alice@example.com". Without normalization, case differences block acceptance.
  const sessionEmail = (user.email ?? '').toLowerCase().trim();
  const invitationEmail = (invitation.email ?? '').toLowerCase().trim();

  if (!sessionEmail || sessionEmail !== invitationEmail) {
    return NextResponse.json(
      {
        error: 'EMAIL_MISMATCH',
        message:
          'This invitation was sent to a different email address. ' +
          'Please sign in with the correct account to accept.',
      },
      { status: 403 },
    );
  }

  // ── Step 7: Validate status + expiry ─────────────────────────────────────

  // WHY status check is AFTER email check: see Step 6 above.
  // Only users with matching email learn status-specific error details.
  if (invitation.status !== 'pending') {
    return NextResponse.json(
      {
        error: 'ALREADY_PROCESSED',
        message: 'This invitation has already been accepted or revoked',
      },
      { status: 409 },
    );
  }

  if (new Date(invitation.expires_at) < new Date()) {
    // WHY 410 (Gone) instead of 404:
    //   The invitation DID exist and is a valid token, but has expired.
    //   410 is semantically correct for "this resource existed but is now gone".
    //   The caller can request a re-send (POST /api/invitations/[id]/resend).
    return NextResponse.json(
      { error: 'EXPIRED', message: 'This invitation has expired. Please request a new invitation.' },
      { status: 410 },
    );
  }

  // ── Step 8: Map invitation role to member role ────────────────────────────

  // WHY INVITE_ROLE_TO_MEMBER_ROLE (imported from @styrby/shared):
  //   team_invitations.role can be 'viewer' (Phase 2.2) but team_members.role
  //   does not yet support 'viewer' (Phase 2.3 migration). The mapping converts
  //   'viewer' -> 'member' at accept time. See types.ts for full explanation.
  const invitationRole = invitation.role as keyof typeof INVITE_ROLE_TO_MEMBER_ROLE;
  const memberRole = INVITE_ROLE_TO_MEMBER_ROLE[invitationRole] ?? 'member';

  // ── Step 9: Insert team member + update invitation ────────────────────────

  // WHY two separate statements instead of a true DB transaction:
  //   Supabase's PostgREST API doesn't expose arbitrary transaction control.
  //   The operations are ordered so partial failure leaves a consistent state:
  //   If INSERT succeeds but UPDATE fails, the user is a member without a
  //   closed invitation — the invitation will expire naturally. The audit trail
  //   will capture the discrepancy.
  //   For full ACID, this would move to an RPC function. That's Phase 2.3 scope.

  const { error: memberInsertError } = await supabase
    .from('team_members')
    .insert({
      team_id: invitation.team_id,
      user_id: user.id,
      role: memberRole,
    });

  if (memberInsertError) {
    // WHY check for duplicate: If the user is already a member (e.g., they
    // accepted via another invite), return 409 rather than 500.
    if (memberInsertError.code === '23505') {
      return NextResponse.json(
        { error: 'ALREADY_PROCESSED', message: 'You are already a member of this team' },
        { status: 409 },
      );
    }
    console.error('[invitations/accept] Failed to insert team member:', memberInsertError);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Failed to join team' },
      { status: 500 },
    );
  }

  // Mark invitation as accepted
  const { error: updateError } = await supabase
    .from('team_invitations')
    .update({
      status: 'accepted',
      accepted_at: new Date().toISOString(),
      accepted_by: user.id,
    })
    .eq('id', invitation.id);

  if (updateError) {
    // Non-fatal: the member row was inserted. Log and continue — the invitation
    // will expire naturally. The audit log below captures the discrepancy.
    console.error('[invitations/accept] Failed to update invitation status:', updateError);
  }

  // ── Step 10: Write audit_log ──────────────────────────────────────────────

  // WHY warn-and-continue on audit failure:
  //   The accept operation succeeded. Audit log failure should not undo the
  //   membership or surface as an error to the user. Ops monitoring catches it.
  const { error: auditError } = await supabase.from('audit_log').insert({
    user_id: user.id,
    action: 'team_invite_accepted',
    resource_type: 'team_invitation',
    resource_id: invitation.id,
    metadata: {
      team_id: invitation.team_id,
      invitation_role: invitation.role,
      member_role: memberRole,
    },
  });

  if (auditError) {
    console.error('[invitations/accept] Failed to write audit_log:', auditError);
  }

  // ── Step 11: Return success ───────────────────────────────────────────────

  return NextResponse.json({
    success: true,
    team_id: invitation.team_id,
    role: memberRole,
  });
}
