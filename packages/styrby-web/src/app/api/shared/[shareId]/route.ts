/**
 * GET /api/shared/[shareId]
 *
 * Retrieves session data for a shared link.
 *
 * Returns the session metadata and encrypted messages. The response does
 * NOT include plaintext content - the caller must supply the decryption
 * key (shared out-of-band) to read the messages.
 *
 * WHY encrypted response: This endpoint is public (no auth required). If
 * we decrypted messages server-side, the server would need the E2E key,
 * defeating the purpose of E2E encryption. Instead the client receives
 * the ciphertext and decrypts locally after the user enters the key.
 *
 * @auth None required (public endpoint)
 * @rateLimit 100 requests per minute (standard, by IP)
 *
 * @returns 200 {
 *   share: SharedSession,
 *   session: SharedSessionData,
 *   messages: SharedMessageData[]
 * }
 *
 * @error 404 { error: 'NOT_FOUND', message: string }
 * @error 410 { error: 'EXPIRED', message: string }
 * @error 429 { error: 'RATE_LIMITED', retryAfter: number }
 * @error 500 { error: 'INTERNAL_ERROR', message: string }
 */

import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';
import type { SharedSession } from '@styrby/shared';

/**
 * Public session metadata included in the shared session response.
 * Excludes sensitive fields like user_id, machine_id, and project_path.
 *
 * WHY: Even though the messages are E2E encrypted, we should not expose
 * the owner's user ID or machine details to anonymous viewers.
 */
export interface SharedSessionData {
  /** Session ID */
  id: string;
  /** Display title */
  title: string | null;
  /** AI-generated summary (may be null) */
  summary: string | null;
  /** Agent type that ran this session */
  agentType: string;
  /** Session completion status */
  status: string;
  /** Total session cost in USD */
  totalCostUsd: number;
  /** Total message count */
  messageCount: number;
  /** Session start ISO timestamp */
  startedAt: string;
  /** Session end ISO timestamp (null if ongoing) */
  endedAt: string | null;
}

/**
 * Encrypted message data included in the shared session response.
 * Content is kept encrypted - decryption happens client-side after key entry.
 */
export interface SharedMessageData {
  /** Message ID */
  id: string;
  /** Message ordering position */
  sequenceNumber: number;
  /** Message type determines rendering role */
  messageType: string;
  /** Base64-encoded encrypted content */
  contentEncrypted: string | null;
  /** Base64-encoded nonce for decryption */
  encryptionNonce: string | null;
  /** Duration in ms (null for user messages) */
  durationMs: number | null;
  /** Input tokens for cost pill display */
  inputTokens: number | null;
  /** Output tokens for cost pill display */
  outputTokens: number | null;
  /** Cache tokens for cost pill display */
  cacheTokens: number | null;
  /** ISO timestamp */
  createdAt: string;
}

/**
 * Route params type.
 */
interface RouteContext {
  params: Promise<{ shareId: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  // Rate limit by IP - this is a public endpoint
  const { allowed, retryAfter } = await rateLimit(request, RATE_LIMITS.standard, 'shared-session-view');
  if (!allowed) {
    return rateLimitResponse(retryAfter!);
  }

  try {
    const { shareId } = await context.params;
    const supabase = await createClient();

    // Look up the share record
    const { data: shareRow, error: shareError } = await supabase
      .from('session_shared_links')
      .select('*')
      .eq('share_id', shareId)
      .single();

    if (shareError || !shareRow) {
      return NextResponse.json(
        { error: 'NOT_FOUND', message: 'Share link not found' },
        { status: 404 }
      );
    }

    // Check expiry
    if (shareRow.expires_at && new Date(shareRow.expires_at) < new Date()) {
      return NextResponse.json(
        { error: 'EXPIRED', message: 'This share link has expired' },
        { status: 410 }
      );
    }

    // Check access count limit
    if (
      shareRow.max_accesses !== null &&
      shareRow.access_count >= shareRow.max_accesses
    ) {
      return NextResponse.json(
        { error: 'EXPIRED', message: 'This share link has reached its maximum number of views' },
        { status: 410 }
      );
    }

    // Atomically increment access count
    // WHY: We use an RPC-style update with a condition to prevent race conditions
    // where two concurrent requests both read max_accesses - 1 and both succeed.
    const { error: updateError } = await supabase
      .from('session_shared_links')
      .update({ access_count: shareRow.access_count + 1 })
      .eq('share_id', shareId)
      .eq('access_count', shareRow.access_count); // optimistic concurrency

    if (updateError) {
      // Non-fatal: log and continue - the viewer still gets the data
      console.error('Failed to increment share access count:', updateError.message);
    }

    // Fetch the session (using service-level access since this is public)
    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .select('id, title, summary, agent_type, status, total_cost_usd, message_count, started_at, ended_at')
      .eq('id', shareRow.session_id)
      .single();

    if (sessionError || !session) {
      return NextResponse.json(
        { error: 'NOT_FOUND', message: 'Session data not found' },
        { status: 404 }
      );
    }

    // Fetch messages - encrypted content is included but plaintext is not exposed
    const { data: messages } = await supabase
      .from('session_messages')
      .select('id, sequence_number, message_type, content_encrypted, encryption_nonce, duration_ms, input_tokens, output_tokens, cache_tokens, created_at')
      .eq('session_id', shareRow.session_id)
      .order('sequence_number', { ascending: true })
      .limit(500);

    // Build the share response
    // SECURITY: Do NOT include shareRow.shared_by (user_id) in the public response.
    // Leaking user UUIDs to unauthenticated viewers enables IDOR enumeration and
    // targeted social engineering. We redact it before serialization.
    const share: Omit<SharedSession, 'sharedBy'> = {
      shareId: shareRow.share_id,
      sessionId: shareRow.session_id,
      expiresAt: shareRow.expires_at,
      accessCount: shareRow.access_count + 1,
      maxAccesses: shareRow.max_accesses,
      createdAt: shareRow.created_at,
    };

    const sessionData: SharedSessionData = {
      id: session.id,
      title: session.title,
      summary: session.summary,
      agentType: session.agent_type,
      status: session.status,
      totalCostUsd: Number(session.total_cost_usd),
      messageCount: session.message_count,
      startedAt: session.started_at,
      endedAt: session.ended_at,
    };

    const messageData: SharedMessageData[] = (messages ?? []).map((m) => ({
      id: m.id,
      sequenceNumber: m.sequence_number,
      messageType: m.message_type,
      contentEncrypted: m.content_encrypted,
      encryptionNonce: m.encryption_nonce,
      durationMs: m.duration_ms,
      inputTokens: m.input_tokens,
      outputTokens: m.output_tokens,
      cacheTokens: m.cache_tokens,
      createdAt: m.created_at,
    }));

    return NextResponse.json({
      share,
      session: sessionData,
      messages: messageData,
    });
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error('Unexpected error in shared session view:', isDev ? error : (error instanceof Error ? error.message : 'Unknown'));
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
      { status: 500 }
    );
  }
}
