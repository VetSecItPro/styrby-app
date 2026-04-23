/**
 * GET /api/sessions/[id]/handoff
 *
 * Returns handoff state for a session when the calling device is different
 * from the device that wrote the most recent snapshot within the last 5 min.
 *
 * WHY 5-minute window: If the last snapshot is older than 5 minutes the
 * user likely closed the session intentionally and a "pick up where you
 * left off" prompt would be intrusive. We return 410 GONE so the client
 * dismisses any cached banner.
 *
 * WHY `current_device_id` query param: The API uses the caller's device ID
 * to decide whether a handoff prompt is relevant — if the caller IS the
 * device that wrote the last snapshot, there is nothing to resume.
 *
 * SOC2 CC6.1: Session state transitions are authenticated; RLS ensures
 * users cannot read snapshots for sessions they do not own.
 *
 * @auth Required — Bearer token (Supabase Auth JWT via cookie)
 *
 * @queryParam current_device_id {string} - Caller's stable device ID
 *
 * @returns 200 { available: false }
 *   When no snapshot exists, or the latest snapshot is from this device.
 * @returns 200 {
 *   available: true,
 *   lastDeviceId: string,
 *   lastDeviceKind: string,
 *   cursorPosition: number,
 *   scrollOffset: number,
 *   activeDraft: string | null,
 *   ageMs: number
 * }
 *   When a recent snapshot from a different device is available.
 * @returns 410 { error: 'SNAPSHOT_EXPIRED' }
 *   When the latest snapshot is older than 5 minutes (soft expiry).
 *
 * @error 400 { error: 'VALIDATION_ERROR', message: string }
 * @error 401 { error: 'UNAUTHORIZED', message: string }
 * @error 404 { error: 'NOT_FOUND', message: string }
 * @error 500 { error: 'INTERNAL_ERROR', message: string }
 */

import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import type { HandoffResponse, DeviceKind } from '@styrby/shared/session-handoff';

/** Maximum snapshot age before the handoff banner is suppressed (5 minutes). */
const HANDOFF_MAX_AGE_MS = 5 * 60 * 1_000;

/**
 * UUID v4/v7 validation regex — used to guard session ID path param.
 *
 * WHY: Prevents path-traversal via crafted session IDs. Restricts to
 * hex+hyphen characters only (SEC-PATH-001 pattern from CLI persistence).
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Route context — params are a Promise in Next.js 15 App Router. */
interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const { id: sessionId } = await context.params;

    // Validate session ID format before any DB access.
    if (!UUID_REGEX.test(sessionId)) {
      return NextResponse.json(
        { error: 'VALIDATION_ERROR', message: 'Invalid session ID format' },
        { status: 400 },
      );
    }

    // Extract caller's device ID from query params.
    const url = new URL(request.url);
    const currentDeviceId = url.searchParams.get('current_device_id') ?? '';

    const supabase = await createClient();

    // Authenticate caller.
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: 'UNAUTHORIZED', message: 'Authentication required' },
        { status: 401 },
      );
    }

    // Verify session ownership.
    // WHY explicit check: RLS on session_state_snapshots requires the join
    // through sessions, but we also want a clear 404 vs implicit empty result.
    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .select('id, user_id')
      .eq('id', sessionId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (sessionError || !session) {
      return NextResponse.json(
        { error: 'NOT_FOUND', message: 'Session not found or access denied' },
        { status: 404 },
      );
    }

    // Fetch the latest snapshot for this session (regardless of device).
    // The partial index on (session_id, created_at DESC) makes this a
    // single index scan even on large sessions.
    const { data: snapshot, error: snapshotError } = await supabase
      .from('session_state_snapshots')
      .select('id, device_id, cursor_position, scroll_offset, active_draft, created_at')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (snapshotError) {
      const isDev = process.env.NODE_ENV === 'development';
      console.error('Handoff snapshot query failed:', isDev ? snapshotError : snapshotError.message);
      return NextResponse.json(
        { error: 'INTERNAL_ERROR', message: 'Failed to query snapshot' },
        { status: 500 },
      );
    }

    // No snapshot at all — nothing to hand off.
    if (!snapshot) {
      const body: HandoffResponse = { available: false };
      return NextResponse.json(body);
    }

    const snapshotAgeMs = Date.now() - new Date(snapshot.created_at).getTime();

    // Snapshot is older than the 5-minute window — return 410 GONE so
    // the client can dismiss any cached banner.
    if (snapshotAgeMs > HANDOFF_MAX_AGE_MS) {
      return NextResponse.json(
        { error: 'SNAPSHOT_EXPIRED', message: 'No recent snapshot available' },
        { status: 410 },
      );
    }

    // If the latest snapshot is from this device, there is nothing to resume.
    if (snapshot.device_id === currentDeviceId) {
      const body: HandoffResponse = { available: false };
      return NextResponse.json(body);
    }

    // Look up the device kind for the origin device to produce a friendly label.
    const { data: originDevice } = await supabase
      .from('devices')
      .select('kind')
      .eq('id', snapshot.device_id)
      .maybeSingle();

    const lastDeviceKind: DeviceKind = (originDevice?.kind as DeviceKind) ?? 'web';

    const body: HandoffResponse = {
      available: true,
      lastDeviceId: snapshot.device_id,
      lastDeviceKind,
      cursorPosition: snapshot.cursor_position,
      scrollOffset: snapshot.scroll_offset,
      activeDraft: snapshot.active_draft ?? null,
      ageMs: Math.round(snapshotAgeMs),
    };

    return NextResponse.json(body);
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error('Unexpected error in handoff route:', isDev ? error : (error instanceof Error ? error.message : 'Unknown'));
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
      { status: 500 },
    );
  }
}
