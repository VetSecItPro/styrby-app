/**
 * GET /api/v1/sessions/[id]/checkpoints
 *
 * Lists all checkpoints for a session owned by the authenticated user.
 *
 * @auth Required - API key via Authorization: Bearer sk_live_xxx
 * @rateLimit 100 requests per minute per key
 *
 * @returns 200 { checkpoints: SessionCheckpoint[] }
 * @error 400 { error: 'Invalid session ID' }
 * @error 404 { error: 'Session not found' }
 * @error 500 { error: 'Failed to fetch checkpoints' }
 *
 * POST /api/v1/sessions/[id]/checkpoints
 *
 * Creates a named checkpoint for a session at the current message position.
 *
 * @auth Required - API key via Authorization: Bearer sk_live_xxx
 * @rateLimit 100 requests per minute per key
 *
 * @body {
 *   name: string,                          // 1–80 chars, unique within session
 *   description?: string,                  // optional longer note
 *   messageSequenceNumber: number,         // the message position to bookmark
 *   contextSnapshot?: { totalTokens: number; fileCount: number }
 * }
 *
 * @returns 201 { checkpoint: SessionCheckpoint }
 * @error 400 { error: string }             // validation failure
 * @error 404 { error: 'Session not found' }
 * @error 409 { error: 'Checkpoint name already exists' }
 * @error 500 { error: 'Failed to create checkpoint' }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { withApiAuth, addRateLimitHeaders, type ApiAuthContext } from '@/middleware/api-auth';
import type { SessionCheckpoint } from '@styrby/shared';

// ============================================================================
// Constants
// ============================================================================

/** Maximum length for a checkpoint name */
const MAX_NAME_LENGTH = 80;

/** UUID validation regex */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ============================================================================
// Supabase Client
// ============================================================================

/**
 * Create an admin Supabase client that bypasses RLS for cross-table lookups.
 *
 * WHY: We use the service role key here because the checkpoint endpoint needs
 * to verify session ownership before performing the checkpoint operation.
 * Using service role + explicit user_id filter is equivalent to RLS for our
 * ownership check pattern.
 */
function createApiAdminClient() {
  return createServerClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      cookies: {
        getAll() { return []; },
        setAll() {},
      },
    }
  );
}

// ============================================================================
// Row → Type Mapping
// ============================================================================

/**
 * Maps a Supabase database row to a typed SessionCheckpoint.
 *
 * @param row - Raw row from session_checkpoints table
 * @returns Typed SessionCheckpoint
 */
function rowToCheckpoint(row: Record<string, unknown>): SessionCheckpoint {
  const snapshot = (row.context_snapshot ?? {}) as Record<string, unknown>;
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? undefined,
    messageSequenceNumber: (row.message_sequence_number as number) ?? 0,
    contextSnapshot: {
      totalTokens: (snapshot.totalTokens as number) ?? 0,
      fileCount: (snapshot.fileCount as number) ?? 0,
    },
    createdAt: row.created_at as string,
  };
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validates a checkpoint name.
 *
 * @param name - Name to validate
 * @returns Error message or null if valid
 */
function validateName(name: unknown): string | null {
  if (typeof name !== 'string' || name.trim().length === 0) {
    return 'name is required and must be a non-empty string';
  }
  if (name.length > MAX_NAME_LENGTH) {
    return `name must be ${MAX_NAME_LENGTH} characters or fewer`;
  }
  if (!/^[a-zA-Z0-9 \-_.]+$/.test(name)) {
    return 'name may only contain letters, numbers, spaces, hyphens, underscores, and dots';
  }
  return null;
}

// ============================================================================
// GET Handler
// ============================================================================

/**
 * GET handler: list all checkpoints for the session.
 */
async function getHandler(
  request: NextRequest,
  context: ApiAuthContext
): Promise<NextResponse> {
  const { userId, keyId } = context;

  const url = new URL(request.url);
  const segments = url.pathname.split('/');
  // Path: /api/v1/sessions/[id]/checkpoints
  const sessionId = segments[segments.length - 2];

  if (!sessionId || !UUID_REGEX.test(sessionId)) {
    return NextResponse.json({ error: 'Invalid session ID' }, { status: 400 });
  }

  const supabase = createApiAdminClient();

  // Verify session ownership
  const { data: session, error: sessionError } = await supabase
    .from('sessions')
    .select('id')
    .eq('id', sessionId)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .single();

  if (sessionError || !session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  const { data: rows, error } = await supabase
    .from('session_checkpoints')
    .select('*')
    .eq('session_id', sessionId)
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[checkpoints GET] Supabase error:', error.message);
    return NextResponse.json({ error: 'Failed to fetch checkpoints' }, { status: 500 });
  }

  const checkpoints: SessionCheckpoint[] = (rows ?? []).map(
    (r) => rowToCheckpoint(r as Record<string, unknown>)
  );

  const response = NextResponse.json({ checkpoints });
  return addRateLimitHeaders(response, keyId);
}

// ============================================================================
// POST Handler
// ============================================================================

/**
 * POST handler: create a new checkpoint for the session.
 */
async function postHandler(
  request: NextRequest,
  context: ApiAuthContext
): Promise<NextResponse> {
  const { userId, keyId } = context;

  const url = new URL(request.url);
  const segments = url.pathname.split('/');
  const sessionId = segments[segments.length - 2];

  if (!sessionId || !UUID_REGEX.test(sessionId)) {
    return NextResponse.json({ error: 'Invalid session ID' }, { status: 400 });
  }

  // Parse request body
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { name, description, messageSequenceNumber, contextSnapshot } = body;

  // Validate name
  const nameError = validateName(name);
  if (nameError) {
    return NextResponse.json({ error: nameError }, { status: 400 });
  }

  // Validate messageSequenceNumber
  if (typeof messageSequenceNumber !== 'number' || !Number.isInteger(messageSequenceNumber) || messageSequenceNumber < 0) {
    return NextResponse.json(
      { error: 'messageSequenceNumber must be a non-negative integer' },
      { status: 400 }
    );
  }

  // Validate optional description
  if (description !== undefined && description !== null && typeof description !== 'string') {
    return NextResponse.json({ error: 'description must be a string' }, { status: 400 });
  }

  const supabase = createApiAdminClient();

  // Verify session ownership
  const { data: session, error: sessionError } = await supabase
    .from('sessions')
    .select('id')
    .eq('id', sessionId)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .single();

  if (sessionError || !session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  const snapshot = contextSnapshot && typeof contextSnapshot === 'object'
    ? contextSnapshot as { totalTokens?: number; fileCount?: number }
    : {};

  // Generate UUID on the server (Supabase will also do this via gen_random_uuid()
  // but we generate here so we can return the ID immediately)
  const { randomUUID } = await import('node:crypto');
  const checkpointId = randomUUID();

  const { data: inserted, error: insertError } = await supabase
    .from('session_checkpoints')
    .insert({
      id: checkpointId,
      session_id: sessionId,
      user_id: userId,
      name: (name as string).trim(),
      description: description ?? null,
      message_sequence_number: messageSequenceNumber,
      context_snapshot: {
        totalTokens: snapshot.totalTokens ?? 0,
        fileCount: snapshot.fileCount ?? 0,
      },
    })
    .select()
    .single();

  if (insertError) {
    // Unique constraint on (session_id, name)
    if (insertError.code === '23505') {
      return NextResponse.json(
        { error: `Checkpoint name "${name as string}" already exists in this session` },
        { status: 409 }
      );
    }
    console.error('[checkpoints POST] Supabase error:', insertError.message);
    return NextResponse.json({ error: 'Failed to create checkpoint' }, { status: 500 });
  }

  const checkpoint = rowToCheckpoint(inserted as Record<string, unknown>);
  const response = NextResponse.json({ checkpoint }, { status: 201 });
  return addRateLimitHeaders(response, keyId);
}

// ============================================================================
// DELETE Handler
// ============================================================================

/**
 * DELETE /api/v1/sessions/[id]/checkpoints?name=<name>  OR  ?checkpointId=<uuid>
 *
 * Deletes a checkpoint by name or ID.
 *
 * @auth Required - API key via Authorization: Bearer sk_live_xxx
 *
 * @returns 200 { deleted: true }
 * @error 400 { error: string }
 * @error 404 { error: 'Checkpoint not found' }
 * @error 500 { error: 'Failed to delete checkpoint' }
 */
async function deleteHandler(
  request: NextRequest,
  context: ApiAuthContext
): Promise<NextResponse> {
  const { userId, keyId } = context;

  const url = new URL(request.url);
  const segments = url.pathname.split('/');
  const sessionId = segments[segments.length - 2];

  if (!sessionId || !UUID_REGEX.test(sessionId)) {
    return NextResponse.json({ error: 'Invalid session ID' }, { status: 400 });
  }

  const checkpointId = url.searchParams.get('checkpointId');
  const name = url.searchParams.get('name');

  if (!checkpointId && !name) {
    return NextResponse.json(
      { error: 'Provide checkpointId or name query parameter' },
      { status: 400 }
    );
  }

  const supabase = createApiAdminClient();

  // Build the delete query
  let query = supabase
    .from('session_checkpoints')
    .delete()
    .eq('session_id', sessionId)
    .eq('user_id', userId);

  if (checkpointId) {
    if (!UUID_REGEX.test(checkpointId)) {
      return NextResponse.json({ error: 'Invalid checkpointId' }, { status: 400 });
    }
    query = query.eq('id', checkpointId);
  } else {
    query = query.eq('name', name!);
  }

  const { error, count } = await query;

  if (error) {
    console.error('[checkpoints DELETE] Supabase error:', error.message);
    return NextResponse.json({ error: 'Failed to delete checkpoint' }, { status: 500 });
  }

  if (count === 0) {
    return NextResponse.json({ error: 'Checkpoint not found' }, { status: 404 });
  }

  const response = NextResponse.json({ deleted: true });
  return addRateLimitHeaders(response, keyId);
}

// ============================================================================
// Exports
// ============================================================================

export const GET = withApiAuth(getHandler);
export const POST = withApiAuth(postHandler);
export const DELETE = withApiAuth(deleteHandler);
