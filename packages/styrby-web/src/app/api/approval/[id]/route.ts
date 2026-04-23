/**
 * Approval Resolution API Route (Phase 2.4)
 *
 * Provides the web/mobile surface for an approver to review and resolve
 * a pending tool-call approval request.
 *
 * GET  /api/approval/[id] — Fetch the approval request details (approver or
 *                           requester can view).
 * POST /api/approval/[id] — Resolve the approval (vote: "approved" | "denied").
 *                           Caller must be a team admin or owner, NOT the
 *                           original requester (SOC2 CC6.3 separation of duties).
 *
 * This route proxies to the `resolve-approval` Supabase edge function so that
 * all state transitions, audit logging, and the re-evaluation of the approval
 * chain happen in a single authoritative place. The web/mobile clients MUST
 * NOT write directly to the `approvals` table for resolution decisions.
 *
 * WHY a Next.js API route instead of calling the edge function directly:
 *   The mobile app and web dashboard authenticate via Supabase cookies managed
 *   by Next.js middleware. Routing through Next.js lets us validate the session
 *   once at the middleware layer, then forward a trusted JWT to the edge
 *   function — no token management on the client.
 *
 * Security:
 *   - Auth: Supabase session cookie (Next.js middleware enforces)
 *   - Self-approval: rejected by the edge function (SOC2 CC6.3)
 *   - Rate limit: 30 req/min per user (prevents spam-approval attempts)
 *
 * @auth Required - Supabase Auth session cookie
 * @rateLimit 30 requests per minute per user
 *
 * @module api/approval/[id]
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';

// ============================================================================
// Schemas
// ============================================================================

/**
 * Validation schema for POST /api/approval/[id] (resolve action).
 *
 * `vote` is the approver's decision.
 * `resolutionNote` is an optional human-readable justification for the
 * decision. Recommended for denials so the requester understands why.
 */
const ResolveSchema = z.object({
  vote: z.enum(['approved', 'denied'], {
    required_error: '"vote" must be "approved" or "denied"',
  }),
  resolutionNote: z
    .string()
    .max(1000, 'Resolution note must be 1000 characters or less')
    .optional(),
});

// ============================================================================
// Types
// ============================================================================

type RouteContext = {
  /** Next.js route segment params — `id` is the approval UUID. */
  params: Promise<{ id: string }>;
};

// ============================================================================
// Helpers
// ============================================================================

/** UUID regex for fast format validation. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Constructs the URL for the `resolve-approval` Supabase edge function.
 *
 * WHY we read from the environment rather than hardcoding the URL:
 *   The edge function URL changes across local dev (local Supabase) and
 *   production. Environment-driven config ensures the same code works in
 *   both contexts without manual edits.
 *
 * @returns Full URL string for the resolve-approval edge function.
 * @throws Error if NEXT_PUBLIC_SUPABASE_URL is not set.
 */
function getEdgeFunctionUrl(): string {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL environment variable is required.');
  }
  return `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/resolve-approval`;
}

// ============================================================================
// GET /api/approval/[id]
// ============================================================================

/**
 * GET /api/approval/[id]
 *
 * Fetches the approval request row for display in the mobile / web
 * "Approve / Deny / View diff" screen.
 *
 * Accessible to:
 *   - The original requester (to see current status).
 *   - Any admin or owner of the team the approval belongs to.
 *
 * The RLS policy on the `approvals` table enforces this at DB level;
 * callers outside those groups receive a 404 (no rows returned).
 *
 * @auth Required - Supabase Auth session cookie
 *
 * @returns 200 {
 *   approval: {
 *     id: string,
 *     teamId: string,
 *     sessionId: string | null,
 *     toolName: string,
 *     estimatedCostUsd: number | null,
 *     requestPayload: Record<string, unknown>,
 *     status: "pending" | "approved" | "denied" | "expired" | "cancelled",
 *     requesterUserId: string,
 *     resolverUserId: string | null,
 *     resolutionNote: string | null,
 *     expiresAt: string,
 *     createdAt: string,
 *     resolvedAt: string | null,
 *   }
 * }
 * @error 400 { error: "Invalid approval ID format" }
 * @error 401 { error: "Unauthorized" }
 * @error 404 { error: "Approval not found" }
 * @error 500 { error: "Internal server error" }
 */
export async function GET(
  _req: NextRequest,
  { params }: RouteContext,
): Promise<NextResponse> {
  const { id: approvalId } = await params;

  if (!UUID_RE.test(approvalId)) {
    return NextResponse.json({ error: 'Invalid approval ID format' }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Fetch via RLS-enforced client. The RLS policy
  // "approvals_select_requester_or_admin" ensures callers only see rows
  // they are authorized to view.
  const { data: rawRow, error: dbError } = await supabase
    .from('approvals')
    .select(
      'id, team_id, session_id, policy_id, requester_user_id, tool_name, ' +
      'estimated_cost_usd, request_payload, status, resolver_user_id, ' +
      'resolution_note, expires_at, created_at, resolved_at',
    )
    .eq('id', approvalId)
    .single();

  if (dbError || !rawRow) {
    return NextResponse.json({ error: 'Approval not found' }, { status: 404 });
  }

  // WHY explicit cast: Supabase's TypeScript codegen types the return as a
  // union with GenericStringError when no generated types are present. We
  // cast through unknown to the concrete shape we know the query returns.
  const approval = rawRow as unknown as {
    id: string;
    team_id: string;
    session_id: string | null;
    policy_id: string | null;
    requester_user_id: string;
    tool_name: string;
    estimated_cost_usd: number | null;
    request_payload: Record<string, unknown>;
    status: string;
    resolver_user_id: string | null;
    resolution_note: string | null;
    expires_at: string;
    created_at: string;
    resolved_at: string | null;
  };

  // Map snake_case DB row to camelCase response
  return NextResponse.json({
    approval: {
      id: approval.id,
      teamId: approval.team_id,
      sessionId: approval.session_id,
      policyId: approval.policy_id,
      requesterUserId: approval.requester_user_id,
      toolName: approval.tool_name,
      estimatedCostUsd: approval.estimated_cost_usd,
      requestPayload: approval.request_payload,
      status: approval.status,
      resolverUserId: approval.resolver_user_id,
      resolutionNote: approval.resolution_note,
      expiresAt: approval.expires_at,
      createdAt: approval.created_at,
      resolvedAt: approval.resolved_at,
    },
  });
}

// ============================================================================
// POST /api/approval/[id]
// ============================================================================

/**
 * POST /api/approval/[id]
 *
 * Resolves the approval by proxying the vote to the `resolve-approval` edge
 * function. The edge function re-evaluates the approval chain, writes the
 * resolution to the DB, and logs to audit_log.
 *
 * Only team admins and owners may resolve. Self-approval is rejected by the
 * edge function (SOC2 CC6.3 separation of duties).
 *
 * @auth Required - Supabase Auth session cookie
 * @rateLimit 30 requests per minute per user
 *
 * @body {
 *   vote: "approved" | "denied",
 *   resolutionNote?: string   // Optional justification (recommended for denials)
 * }
 *
 * @returns 200 {
 *   approvalId: string,
 *   status: "approved" | "denied",
 *   reason: string,
 * }
 * @error 400 { error: "Validation error message" }
 * @error 401 { error: "Unauthorized" }
 * @error 403 { error: "Forbidden: ..." }
 * @error 404 { error: "Approval not found" }
 * @error 409 { error: "Approval is already <status>. Resolution is a no-op." }
 * @error 429 { error: "Rate limit exceeded" }
 * @error 500 { error: "Internal server error" }
 */
export async function POST(
  req: NextRequest,
  { params }: RouteContext,
): Promise<NextResponse | Response> {
  const { id: approvalId } = await params;

  if (!UUID_RE.test(approvalId)) {
    return NextResponse.json({ error: 'Invalid approval ID format' }, { status: 400 });
  }

  // --- Auth ---
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // --- Rate limit ---
  const rateLimitResult = await rateLimit(req, RATE_LIMITS.standard, 'approval-resolve');
  if (!rateLimitResult.allowed) {
    return rateLimitResponse(rateLimitResult.retryAfter!);
  }

  // --- Parse and validate body ---
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON in request body' }, { status: 400 });
  }

  const parsed = ResolveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join('; ') },
      { status: 400 },
    );
  }

  const { vote, resolutionNote } = parsed.data;

  // --- Forward to edge function ---
  // WHY we get the user's JWT and forward it: The edge function uses the JWT
  // to authenticate the caller's identity via supabase.auth.getUser(). We
  // cannot forward the session cookie directly (different origin), so we
  // exchange it for a JWT here using the server-side Supabase client.
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData?.session?.access_token;

  if (!accessToken) {
    return NextResponse.json({ error: 'Unable to retrieve access token' }, { status: 401 });
  }

  let edgeFunctionUrl: string;
  try {
    edgeFunctionUrl = getEdgeFunctionUrl();
  } catch (err) {
    console.error('[api/approval] Edge function URL unavailable:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }

  let edgeResponse: Response;
  try {
    edgeResponse = await fetch(edgeFunctionUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        action: 'resolve',
        approvalId,
        vote,
        resolutionNote,
      }),
    });
  } catch (err) {
    console.error('[api/approval] Edge function call failed:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }

  // Forward the edge function's response verbatim (status + body)
  const edgeBody = await edgeResponse.json().catch(() => ({
    error: 'Edge function returned invalid JSON',
  }));

  return NextResponse.json(edgeBody, { status: edgeResponse.status });
}
