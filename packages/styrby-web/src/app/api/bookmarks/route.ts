/**
 * Bookmarks API Route
 *
 * Provides CRUD operations for session bookmarks. Bookmark creation is
 * tier-gated (Free: 5, Pro: 50, Power: unlimited).
 *
 * GET    /api/bookmarks           - List user's bookmarks
 * POST   /api/bookmarks           - Create a new bookmark (tier-limited)
 * DELETE /api/bookmarks           - Delete a bookmark by session_id
 *
 * @rateLimit 30 requests per minute for POST/DELETE
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { TIERS, type TierId } from '@/lib/polar';
import { z } from 'zod';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

/**
 * Schema for creating a new bookmark.
 * WHY: A bookmark is simply a reference to a session - the session_id is all
 * that is required. Notes are optional for user-supplied context.
 */
const CreateBookmarkSchema = z.object({
  session_id: z.string().uuid('Invalid session ID'),
  note: z.string().max(500, 'Note must be 500 characters or less').optional(),
});

/**
 * Schema for deleting a bookmark.
 */
const DeleteBookmarkSchema = z.object({
  session_id: z.string().uuid('Invalid session ID'),
});

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/**
 * Resolves the user's subscription tier from Supabase.
 *
 * @param supabase - Authenticated Supabase client
 * @param userId - The authenticated user's ID
 * @returns The user's tier ID (defaults to 'free' if no subscription found)
 */
async function getUserTier(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string
): Promise<TierId> {
  const { data: subscription } = await supabase
    .from('subscriptions')
    .select('tier')
    .eq('user_id', userId)
    .eq('status', 'active')
    .single();

  return (subscription?.tier as TierId) || 'free';
}

// ---------------------------------------------------------------------------
// GET /api/bookmarks
// ---------------------------------------------------------------------------

/**
 * GET /api/bookmarks
 *
 * Lists all session bookmarks for the authenticated user.
 *
 * @auth Required - Supabase Auth JWT via cookie
 *
 * @returns 200 {
 *   bookmarks: SessionBookmark[],
 *   tier: TierId,
 *   bookmarkLimit: number,
 *   bookmarkCount: number
 * }
 *
 * @error 401 { error: 'Unauthorized' }
 * @error 500 { error: 'Failed to fetch bookmarks' }
 */
export async function GET() {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const [bookmarksResult, tier] = await Promise.all([
      supabase
        .from('session_bookmarks')
        .select('id, session_id, note, created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(100),
      getUserTier(supabase, user.id),
    ]);

    if (bookmarksResult.error) {
      console.error('Failed to fetch bookmarks:', bookmarksResult.error.message);
      return NextResponse.json(
        { error: 'Failed to fetch bookmarks' },
        { status: 500 }
      );
    }

    const bookmarks = bookmarksResult.data || [];
    const bookmarkLimit = TIERS[tier]?.limits.bookmarks ?? 5;

    return NextResponse.json(
      {
        bookmarks,
        tier,
        // WHY: -1 means unlimited (Power tier). Expose to client so UI can
        // display the correct "X of Y bookmarks used" counter.
        bookmarkLimit,
        bookmarkCount: bookmarks.length,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      'Bookmarks GET error:',
      isDev ? error : error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json(
      { error: 'Failed to fetch bookmarks' },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// POST /api/bookmarks
// ---------------------------------------------------------------------------

/**
 * POST /api/bookmarks
 *
 * Creates a new session bookmark. Enforces the user's tier limit on total bookmarks.
 *
 * Tier limits:
 * - Free:  5 bookmarks
 * - Pro:   50 bookmarks
 * - Power: unlimited (-1)
 *
 * @auth Required - Supabase Auth JWT via cookie
 * @rateLimit 30 requests per minute
 *
 * @body {
 *   session_id: string (UUID),
 *   note?: string  // Optional annotation, max 500 chars
 * }
 *
 * @returns 201 { bookmark: SessionBookmark }
 *
 * @error 400 { error: string } - Validation failure
 * @error 401 { error: 'Unauthorized' }
 * @error 403 { error: string } - Tier limit reached
 * @error 500 { error: 'Failed to create bookmark' }
 */
export async function POST(request: NextRequest) {
  // Rate limit check - 30 requests per minute
  const { allowed, retryAfter } = await rateLimit(request, RATE_LIMITS.budgetAlerts, 'bookmarks');
  if (!allowed) {
    return rateLimitResponse(retryAfter!);
  }

  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Parse and validate request body
    const rawBody = await request.json();
    const parseResult = CreateBookmarkSchema.safeParse(rawBody);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: parseResult.error.errors.map((e) => e.message).join(', ') },
        { status: 400 }
      );
    }

    // Check tier limit - run tier lookup and count query in parallel
    const [tier, countResult] = await Promise.all([
      getUserTier(supabase, user.id),
      supabase
        .from('session_bookmarks')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id),
    ]);

    const bookmarkLimit = TIERS[tier]?.limits.bookmarks ?? 5;
    const currentCount = countResult.count ?? 0;

    // WHY: -1 represents unlimited (Power tier). Only enforce the limit when
    // it is a positive integer.
    if (bookmarkLimit !== -1 && currentCount >= bookmarkLimit) {
      return NextResponse.json(
        {
          error: tier === 'free'
            ? `You have reached your limit of ${bookmarkLimit} bookmarks on the Free plan. Upgrade to Pro for 50 bookmarks.`
            : `You have reached your limit of ${bookmarkLimit} bookmarks on the ${tier} plan. Upgrade to Power for unlimited bookmarks.`,
        },
        { status: 403 }
      );
    }

    // Insert the new bookmark
    const { data: bookmark, error: insertError } = await supabase
      .from('session_bookmarks')
      .insert({
        user_id: user.id,
        session_id: parseResult.data.session_id,
        note: parseResult.data.note ?? null,
      })
      .select()
      .single();

    if (insertError) {
      // WHY: Unique constraint violation means the session is already bookmarked.
      // Return a friendly 409 rather than a 500.
      if (insertError.code === '23505') {
        return NextResponse.json(
          { error: 'Session is already bookmarked' },
          { status: 409 }
        );
      }
      console.error('Failed to create bookmark:', insertError.message);
      return NextResponse.json(
        { error: 'Failed to create bookmark' },
        { status: 500 }
      );
    }

    return NextResponse.json({ bookmark }, { status: 201 });
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      'Bookmarks POST error:',
      isDev ? error : error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json(
      { error: 'Failed to create bookmark' },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/bookmarks
// ---------------------------------------------------------------------------

/**
 * DELETE /api/bookmarks
 *
 * Removes a session bookmark. RLS ensures users can only delete their own.
 *
 * @auth Required - Supabase Auth JWT via cookie
 * @rateLimit 30 requests per minute
 *
 * @body { session_id: string (UUID) }
 *
 * @returns 200 { success: true }
 *
 * @error 400 { error: string } - Validation failure
 * @error 401 { error: 'Unauthorized' }
 * @error 404 { error: 'Bookmark not found' }
 * @error 500 { error: 'Failed to delete bookmark' }
 */
export async function DELETE(request: NextRequest) {
  // Rate limit check - 30 requests per minute
  const { allowed, retryAfter } = await rateLimit(request, RATE_LIMITS.budgetAlerts, 'bookmarks');
  if (!allowed) {
    return rateLimitResponse(retryAfter!);
  }

  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const rawBody = await request.json();
    const parseResult = DeleteBookmarkSchema.safeParse(rawBody);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: parseResult.error.errors.map((e) => e.message).join(', ') },
        { status: 400 }
      );
    }

    // Verify existence before delete to give a meaningful 404
    const { data: existing } = await supabase
      .from('session_bookmarks')
      .select('id')
      .eq('session_id', parseResult.data.session_id)
      .eq('user_id', user.id)
      .single();

    if (!existing) {
      return NextResponse.json(
        { error: 'Bookmark not found' },
        { status: 404 }
      );
    }

    const { error: deleteError } = await supabase
      .from('session_bookmarks')
      .delete()
      .eq('session_id', parseResult.data.session_id)
      .eq('user_id', user.id);

    if (deleteError) {
      console.error('Failed to delete bookmark:', deleteError.message);
      return NextResponse.json(
        { error: 'Failed to delete bookmark' },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      'Bookmarks DELETE error:',
      isDev ? error : error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json(
      { error: 'Failed to delete bookmark' },
      { status: 500 }
    );
  }
}
