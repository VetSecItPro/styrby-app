/**
 * POST /api/sessions/[id]/share
 *
 * Creates a shareable link for a session. The session content remains
 * E2E encrypted - the viewer needs the decryption key (shared separately)
 * to read the messages.
 *
 * WHY separate key: Session messages in Supabase are encrypted with NaCl
 * box. The share link grants read access to the encrypted rows, but the
 * plaintext is only accessible to someone who also has the decryption key.
 * This means a leaked share URL is harmless without the key.
 *
 * @auth Required - Bearer token (Supabase Auth JWT via cookie)
 * @rateLimit 10 requests per minute (sensitive)
 *
 * @body {
 *   expiresAt?: string | null  - ISO 8601 expiry (null = never expires)
 *   maxAccesses?: number | null - Max view count (null = unlimited)
 * }
 *
 * @returns 201 {
 *   share: SharedSession,
 *   shareUrl: string
 * }
 *
 * @tier Power only (Free users receive 403 TIER_RESTRICTED)
 *
 * @error 400 { error: 'VALIDATION_ERROR', message: string }
 * @error 401 { error: 'UNAUTHORIZED', message: string }
 * @error 403 { error: 'FORBIDDEN' | 'TIER_RESTRICTED', message: string }
 * @error 404 { error: 'NOT_FOUND', message: string }
 * @error 429 { error: 'RATE_LIMITED', retryAfter: number }
 * @error 500 { error: 'INTERNAL_ERROR', message: string }
 */

import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';
import { getAppUrl } from '@/lib/config';
import type { SharedSession, CreateShareResponse } from '@styrby/shared';
import { normalizeEffectiveTier } from '@/lib/tier-enforcement';

/**
 * Alphabet for nanoid-style share ID generation.
 * URL-safe alphanumeric characters only - no ambiguous chars like 0/O or l/1.
 */
const SHARE_ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

/**
 * Length of the generated share ID.
 * 12 chars from a 55-char alphabet = 55^12 ≈ 1.15 × 10^20 combinations.
 * Collision probability is negligible even at tens of millions of shares.
 */
const SHARE_ID_LENGTH = 12;

/**
 * Generates a URL-safe random share ID using the Web Crypto API.
 *
 * WHY: We avoid `nanoid` as an explicit dependency by implementing the same
 * algorithm inline with crypto.getRandomValues(). This keeps the bundle lean
 * and avoids a supply-chain dependency for a trivial utility.
 *
 * SECURITY: Uses rejection sampling to eliminate modulo bias. A naive
 * `byte % alphabetLength` produces non-uniform output when 256 is not
 * evenly divisible by the alphabet size (55). We reject bytes >= the
 * largest multiple of alphabetLength that fits in a byte to guarantee
 * uniform distribution.
 *
 * @returns A 12-character URL-safe random string
 */
function generateShareId(): string {
  const alphabetLen = SHARE_ID_ALPHABET.length;
  // Largest multiple of alphabetLen that fits in [0, 255]
  const maxValid = Math.floor(256 / alphabetLen) * alphabetLen;
  const result: string[] = [];

  while (result.length < SHARE_ID_LENGTH) {
    // Request extra bytes to handle rejections without additional getRandomValues calls
    const bytes = new Uint8Array(SHARE_ID_LENGTH * 2);
    crypto.getRandomValues(bytes);

    for (const b of bytes) {
      if (result.length >= SHARE_ID_LENGTH) break;
      // Reject bytes that would cause modulo bias
      if (b < maxValid) {
        result.push(SHARE_ID_ALPHABET[b % alphabetLen]);
      }
    }
  }

  return result.join('');
}

/**
 * Request body schema for share creation.
 */
const createShareSchema = z.object({
  expiresAt: z.string().datetime().nullable().optional(),
  maxAccesses: z.number().int().positive().nullable().optional(),
});

/**
 * Route params type.
 */
interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  // Rate limit: sensitive operations tier (10/min)
  const { allowed, retryAfter } = await rateLimit(request, RATE_LIMITS.sensitive, 'session-share');
  if (!allowed) {
    return rateLimitResponse(retryAfter!);
  }

  try {
    const { id: sessionId } = await context.params;
    const supabase = await createClient();

    // Authenticate user
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: 'UNAUTHORIZED', message: 'Authentication required' },
        { status: 401 }
      );
    }

    // Enforce Pro+ tier gate for session sharing
    // WHY: Session sharing is listed in the Pro feature set. Free users cannot
    // create share links. We check the tier immediately after auth to short-circuit.
    const { data: subscription } = await supabase
      .from('subscriptions')
      .select('tier')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .maybeSingle();

    // WHY (Phase 5): legacy DB enum values (power/team/business/enterprise)
    // alias to canonical tiers via normalizeEffectiveTier (Decision #8).
    const userTierForShare = normalizeEffectiveTier((subscription?.tier as string) || 'free');
    if (userTierForShare !== 'growth' && userTierForShare !== 'pro') {
      return NextResponse.json(
        { error: 'TIER_RESTRICTED', message: 'Session sharing requires a Power plan. Upgrade at /pricing' },
        { status: 403 }
      );
    }

    // Validate session ID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(sessionId)) {
      return NextResponse.json(
        { error: 'VALIDATION_ERROR', message: 'Invalid session ID format' },
        { status: 400 }
      );
    }

    // Parse and validate request body
    const body = await request.json().catch(() => ({}));
    const parseResult = createShareSchema.safeParse(body);

    if (!parseResult.success) {
      return NextResponse.json(
        {
          error: 'VALIDATION_ERROR',
          message: parseResult.error.errors[0].message,
        },
        { status: 400 }
      );
    }

    const { expiresAt, maxAccesses } = parseResult.data;

    // Verify session exists and belongs to authenticated user
    // WHY: RLS on session_shared_links enforces ownership, but we verify
    // explicitly here so we can return a meaningful 404 vs 403.
    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .select('id, user_id, status')
      .eq('id', sessionId)
      .eq('user_id', user.id)
      .single();

    if (sessionError || !session) {
      return NextResponse.json(
        { error: 'NOT_FOUND', message: 'Session not found or access denied' },
        { status: 404 }
      );
    }

    // Generate a unique share ID (retry on collision - astronomically unlikely)
    let shareId = generateShareId();
    let attempts = 0;
    while (attempts < 5) {
      const { data: existing } = await supabase
        .from('session_shared_links')
        .select('share_id')
        .eq('share_id', shareId)
        .maybeSingle();

      if (!existing) break;
      shareId = generateShareId();
      attempts++;
    }

    // Insert the share record
    const { data: shareRow, error: insertError } = await supabase
      .from('session_shared_links')
      .insert({
        share_id: shareId,
        session_id: sessionId,
        shared_by: user.id,
        expires_at: expiresAt ?? null,
        max_accesses: maxAccesses ?? null,
        access_count: 0,
      })
      .select()
      .single();

    if (insertError || !shareRow) {
      const isDev = process.env.NODE_ENV === 'development';
      console.error('Failed to create share link:', isDev ? insertError : insertError?.message);
      return NextResponse.json(
        { error: 'INTERNAL_ERROR', message: 'Failed to create share link' },
        { status: 500 }
      );
    }

    // Build the response
    const share: SharedSession = {
      shareId: shareRow.share_id,
      sessionId: shareRow.session_id,
      sharedBy: shareRow.shared_by,
      expiresAt: shareRow.expires_at,
      accessCount: shareRow.access_count,
      maxAccesses: shareRow.max_accesses,
      createdAt: shareRow.created_at,
    };

    const appUrl = getAppUrl();
    // WHY: Use shareRow.share_id (the canonical ID from the DB) rather than the
    // local shareId variable. In practice they are the same, but the DB is the
    // source of truth for what was actually stored.
    const shareUrl = `${appUrl}/shared/${shareRow.share_id}`;

    const response: CreateShareResponse = { share, shareUrl };

    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error('Unexpected error in session share:', isDev ? error : (error instanceof Error ? error.message : 'Unknown'));
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
      { status: 500 }
    );
  }
}
