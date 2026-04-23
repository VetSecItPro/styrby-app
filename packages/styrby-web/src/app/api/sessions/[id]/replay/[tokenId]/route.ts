/**
 * DELETE /api/sessions/[id]/replay/[tokenId]
 *
 * Revokes a session replay token. Sets `revoked_at = NOW()` on the token row.
 * Future replay viewer requests for this token will receive 410 Gone.
 *
 * WHY soft-delete (revoked_at) not hard-delete:
 *   If the viewer is mid-replay when the creator revokes the token, the next
 *   page load returns 410 with a clear "this replay has been revoked" message
 *   rather than a confusing 404. The revoked record also provides an audit
 *   trail: when was access withdrawn, by whom.
 *
 * Security contracts:
 *   - Only the creator (created_by) can revoke their own tokens
 *   - RLS enforces this at the DB layer; route-layer check is belt-and-suspenders
 *   - Revoking an already-revoked token is idempotent (200 OK)
 *   - Revoking a token from a different session returns 404 (not 403) to prevent
 *     token enumeration across sessions
 *
 * SOC2 CC7.2: Token revocation is audit-logged with the same token_id.
 *
 * @auth Required - Supabase Auth JWT via cookie or Authorization: Bearer header
 * @rateLimit standard (token revocation is low-risk, high-volume cleanup)
 *
 * @returns 200 { success: true }
 *
 * @error 401 { error: 'UNAUTHORIZED', message: string }
 * @error 404 { error: 'NOT_FOUND', message: string }
 * @error 500 { error: 'INTERNAL_ERROR', message: string }
 */

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

interface RouteParams {
  params: Promise<{ id: string; tokenId: string }>;
}

export async function DELETE(request: Request, { params }: RouteParams) {
  const { id: sessionId, tokenId } = await params;

  // ── Auth ──────────────────────────────────────────────────────────────────
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'UNAUTHORIZED', message: 'Authentication required' }, { status: 401 });
  }

  // ── Verify token exists, belongs to this session, and was created by caller
  // WHY: We check session_id to prevent cross-session confusion. A token for
  // /api/sessions/A/replay/[tokenForSessionB] returns 404, not a privilege
  // escalation error that might leak token existence across sessions.
  const { data: token, error: fetchError } = await supabase
    .from('session_replay_tokens')
    .select('id, session_id, created_by, revoked_at')
    .eq('id', tokenId)
    .eq('session_id', sessionId)
    .eq('created_by', user.id)
    .maybeSingle();

  if (fetchError) {
    console.error('[replay:revoke] fetch error', fetchError);
    return NextResponse.json({ error: 'INTERNAL_ERROR', message: 'Database error' }, { status: 500 });
  }

  if (!token) {
    // Return 404 regardless of whether the token exists-but-belongs-to-another-user.
    // WHY: A 403 would reveal that the token exists, enabling enumeration.
    return NextResponse.json({ error: 'NOT_FOUND', message: 'Token not found' }, { status: 404 });
  }

  // Idempotent: if already revoked, return success without updating.
  if (token.revoked_at) {
    return NextResponse.json({ success: true });
  }

  // ── Revoke (soft-delete) ──────────────────────────────────────────────────
  const { error: updateError } = await supabase
    .from('session_replay_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', tokenId)
    .eq('created_by', user.id);

  if (updateError) {
    console.error('[replay:revoke] update error', updateError);
    return NextResponse.json({ error: 'INTERNAL_ERROR', message: 'Failed to revoke token' }, { status: 500 });
  }

  // ── Audit log ─────────────────────────────────────────────────────────────
  // SOC2 CC7.2: Revocation is a controlled access withdrawal event.
  await supabase.from('audit_log').insert({
    user_id:  user.id,
    action:   'session_replay_token_revoked',
    resource: `session:${sessionId}`,
    metadata: { token_id: tokenId },
  });

  return NextResponse.json({ success: true });
}
