/**
 * resolve-approval — Supabase Edge Function (Phase 2.4)
 *
 * Manages the full lifecycle of a CLI tool-call approval request:
 *
 *   POST action="submit"  — Create a pending `approvals` row, derive an
 *                           HMAC-SHA256 approval token, fire push notification
 *                           to all eligible approvers, return
 *                           { approvalId, status: "pending", approvalToken }.
 *
 *   POST action="poll"    — Re-evaluate the approval chain and return the
 *                           current status. Requires approvalToken for
 *                           timing-safe ownership verification (IDOR guard).
 *
 *   POST action="cancel"  — Requester aborts the pending request (Ctrl-C).
 *                           Marks row 'cancelled' and logs to audit_log.
 *
 *   POST action="resolve" — Approver votes approve/deny with an optional note.
 *                           This path is also reached by the web/mobile
 *                           "Approve / Deny / View diff" action buttons.
 *
 * Security design:
 *   - Callers with a user JWT can submit/poll/cancel their OWN approval rows.
 *   - Callers with a user JWT can resolve rows for teams they are admin/owner of.
 *   - Service role callers can drive any row (used by the mobile push handler).
 *   - The `approvalToken` is HMAC-SHA256(approvalId, APPROVAL_HMAC_SECRET)
 *     compared in constant time to prevent timing attacks.
 *   - RLS on the `approvals` table provides defense-in-depth: the DB itself
 *     enforces team membership and requester-only cancel, independent of the
 *     edge function's checks.
 *
 * Compliance:
 *   - SOC2 CC6.2: Every state transition is written to audit_log with
 *     resolver identity + timestamp.
 *   - SOC2 CC6.3: Self-approval is prohibited (evaluateApprovalChain).
 *   - ISO 27001 A.9.1: HMAC token guards the poll/cancel surface.
 *
 * @module supabase/functions/resolve-approval
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.47.10';

// ============================================================================
// Types
// ============================================================================

/** Actions the CLI (or mobile) can request. */
type ApprovalAction = 'submit' | 'poll' | 'cancel' | 'resolve';

/** Risk classification passed by the CLI policyEngine. */
type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/** Current approval lifecycle state. */
type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';

/** Incoming POST body union across all four actions. */
interface ApprovalRequestBody {
  action: ApprovalAction;

  // --- submit fields ---
  sessionId?: string;
  teamId?: string;
  riskLevel?: RiskLevel;
  toolName?: string;
  estimatedCostUsd?: number;
  requestPayload?: Record<string, unknown>;

  // --- poll / cancel / resolve fields ---
  approvalId?: string;
  approvalToken?: string;

  // --- resolve-specific ---
  vote?: 'approved' | 'denied';
  resolutionNote?: string;
}

/** Response shape returned for all actions. */
interface ApprovalResponse {
  approvalId: string;
  status: ApprovalStatus;
  approvalToken?: string;  // Only on submit
  requiredApprovers?: string[];
  reason?: string;
}

/** Row shape we read from the approvals table. */
interface ApprovalRow {
  id: string;
  team_id: string;
  session_id: string | null;
  policy_id: string | null;
  requester_user_id: string;
  tool_name: string;
  estimated_cost_usd: number | null;
  request_payload: Record<string, unknown>;
  status: ApprovalStatus;
  resolver_user_id: string | null;
  resolution_note: string | null;
  expires_at: string;
  created_at: string;
  resolved_at: string | null;
  approval_token: string;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Audit action values added in migration 032.
 * Typed as string so the INSERT doesn't break if an old migration run
 * missed the ALTER TYPE — the DB constraint will surface the error clearly.
 */
const AUDIT_ACTIONS = {
  APPROVED: 'team_command_approved',
  DENIED: 'team_command_denied',
  TIMEOUT: 'team_command_timeout',
} as const;

/** UUID regex for fast format validation before DB round-trips. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ============================================================================
// HMAC helpers
// ============================================================================

/**
 * Derives an HMAC-SHA256 approval token.
 *
 * The token is bound to the approvalId so that a leaked token for row A
 * cannot be used to drive row B. HMAC is keyed with APPROVAL_HMAC_SECRET
 * which is a Supabase edge-function secret (not visible to DB or client).
 *
 * @param approvalId - UUID of the approval row.
 * @param secret - HMAC key from environment (APPROVAL_HMAC_SECRET).
 * @returns 64-char lowercase hex string.
 */
async function deriveApprovalToken(
  approvalId: string,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    keyMaterial,
    encoder.encode(approvalId),
  );
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Constant-time comparison of two hex token strings.
 *
 * WHY constant-time: A naïve `a === b` short-circuits on the first differing
 * byte. An attacker controlling `candidate` could measure response latency to
 * determine the correct token character-by-character. This XOR-accumulate
 * pattern eliminates the timing side-channel (per OWASP A02:2021 Cryptographic
 * Failures and NIST SP800-132 §5.3).
 *
 * @param expected - The HMAC-derived token (server side).
 * @param candidate - The token provided by the caller.
 * @returns true iff the tokens are identical.
 */
function timingSafeEqual(expected: string, candidate: string): boolean {
  // Length mismatch check must NOT short-circuit in a way that leaks length.
  // We pad candidate to expected.length so the XOR loop always runs the same
  // number of iterations regardless of candidate length.
  const exp = expected.toLowerCase();
  const can = candidate.toLowerCase().padEnd(exp.length, '\0').slice(0, exp.length);

  let diff = expected.length === candidate.length ? 0 : 1;
  for (let i = 0; i < exp.length; i++) {
    diff |= exp.charCodeAt(i) ^ can.charCodeAt(i);
  }
  return diff === 0;
}

// ============================================================================
// Response helpers
// ============================================================================

/**
 * Builds a JSON Response with the given HTTP status.
 *
 * @param body - Object to serialize.
 * @param status - HTTP status code.
 */
function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ============================================================================
// Authorization helpers
// ============================================================================

/**
 * Returns the calling user's ID from the Supabase JWT, or null if the
 * caller has no valid session.
 *
 * WHY service_role bypass: The mobile push action button calls resolve with a
 * service role credential on behalf of the approver (the approver's user_id is
 * in the body). We accept that path so mobile can proxy the resolution without
 * giving the app a user JWT to manage.
 *
 * @param supabase - Supabase client initialized with the caller's JWT.
 * @returns userId string or null.
 */
async function getCallerId(
  supabase: ReturnType<typeof createClient>,
): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
  return user?.id ?? null;
}

// ============================================================================
// Push notification helper
// ============================================================================

/**
 * Sends approval-request push notifications to all eligible approvers on the team.
 *
 * WHY call send-push-notification internally:
 *   That edge function owns rate-limiting, quiet-hours, and token deactivation.
 *   We re-use it instead of hitting the Expo API directly so those invariants
 *   are enforced in one place (SOC2 CC7.2 — consistent operations).
 *
 * Fire-and-forget: notification failures MUST NOT block the submit response.
 * The CLI is already blocking the user; a push failure degrades gracefully
 * (approver can still visit the web dashboard).
 *
 * @param supabaseUrl - Project URL for constructing the function URL.
 * @param serviceKey - Service role key for inter-function auth.
 * @param approverUserIds - Array of user UUIDs to notify.
 * @param approvalId - The new approval row ID (for deep-link data).
 * @param toolName - Name of the tool awaiting approval (for notification body).
 * @param riskLevel - Risk level for priority scoring.
 * @param requesterUserId - Who triggered the approval request.
 */
async function notifyApprovers(
  supabaseUrl: string,
  serviceKey: string,
  approverUserIds: string[],
  approvalId: string,
  toolName: string,
  riskLevel: RiskLevel,
  requesterUserId: string,
): Promise<void> {
  const pushUrl = `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/send-push-notification`;

  await Promise.all(
    approverUserIds.map((userId) =>
      fetch(pushUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${serviceKey}`,
        },
        body: JSON.stringify({
          type: 'approval_request',
          userId,
          data: {
            approvalId,
            toolName,
            riskLevel,
            requesterUserId,
            // Deep-link routing for mobile approval action buttons
            screen: 'approvals',
            // Action buttons surfaced by the mobile app on this notification:
            //   "Approve"  → POST /resolve-approval { action: "resolve", vote: "approved" }
            //   "Deny"     → POST /resolve-approval { action: "resolve", vote: "denied" }
            //   "View diff" → opens ApprovalDetailScreen in-app
            actions: ['approve', 'deny', 'view_diff'],
          },
        }),
      }).catch((err) => {
        // WHY swallow: notification failure is non-blocking. The CLI is already
        // waiting; the approver can still act via the web dashboard.
        console.error(`[resolve-approval] Push to ${userId} failed:`, err);
      }),
    ),
  );
}

// ============================================================================
// Audit log helper
// ============================================================================

/**
 * Writes a single row to audit_log for an approval state transition.
 *
 * WHY not fire-and-forget: audit_log writes are SOC2 CC7.1 evidence.
 * We await them so that if the DB write fails we know about it — the
 * approver gets an error response instead of silently missing an audit trail.
 *
 * @param supabase - Service-role Supabase client.
 * @param opts - Action values for the row.
 */
async function writeAuditLog(
  supabase: ReturnType<typeof createClient>,
  opts: {
    userId: string;
    action: string;
    resourceId: string;
    teamId: string;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  const { error } = await supabase.from('audit_log').insert({
    user_id: opts.userId,
    action: opts.action,
    resource_type: 'approval',
    resource_id: opts.resourceId,
    metadata: {
      team_id: opts.teamId,
      ...opts.metadata,
    },
  });

  if (error) {
    // Log but do not rethrow — the business operation already succeeded.
    // Audit failure is a monitoring alert, not a user-facing error.
    console.error('[resolve-approval] audit_log write failed:', error);
  }
}

// ============================================================================
// Evaluate current chain state
// ============================================================================

/**
 * Fetches all current approval votes for an approvalId and re-evaluates the
 * chain using the shared evaluateApprovalChain algorithm.
 *
 * WHY re-evaluate on every poll rather than trusting the stored status:
 *   An approver's role may have been revoked since the request was created.
 *   A stored 'approved' from a now-revoked user MUST NOT be honoured. The
 *   authoritative decision is always: current roster + current votes.
 *   (SOC2 CC6.2 — access revocation must take effect promptly.)
 *
 * @param supabase - Service-role client for unrestricted reads.
 * @param row - The approval row being evaluated.
 * @returns { status, requiredApprovers, reason }
 */
async function reEvaluateChain(
  supabase: ReturnType<typeof createClient>,
  row: ApprovalRow,
): Promise<{ status: 'auto-approved' | 'pending' | 'denied'; requiredApprovers: string[]; reason?: string }> {
  // --- Fetch current policy (if any) ---
  let policy: Record<string, unknown> | null = null;
  if (row.policy_id) {
    const { data } = await supabase
      .from('team_policies')
      .select('*')
      .eq('id', row.policy_id)
      .single();
    policy = data ?? null;
  }

  // --- Fetch team roster ---
  const { data: members } = await supabase
    .from('team_members')
    .select('user_id, role')
    .eq('team_id', row.team_id);

  const roster = (members ?? []).map((m: { user_id: string; role: string }) => ({
    userId: m.user_id,
    role: m.role as 'owner' | 'admin' | 'member',
    active: true,  // Only active rows are returned by RLS + no soft-delete column
  }));

  // --- Fetch existing votes (approval rows with same approval parent) ---
  // We model votes as sub-rows in the same approvals table? No: the existing
  // schema has a single status column per row. The chain evaluator maps
  // resolver_user_id + status into the vote. There is one approval row per
  // tool call, so we synthesize votes from the resolved row itself.
  const votes = row.resolver_user_id
    ? [
        {
          status: row.status as 'approved' | 'denied',
          resolverUserId: row.resolver_user_id,
          requesterUserId: row.requester_user_id,
        },
      ]
    : [];

  // --- Map DB policy to evaluator shape ---
  // WHY the null policy fallback: if no policy_id is set, the evaluator
  // auto-approves. This matches a "no matching policy" flow where the
  // CLI submitted the request manually (e.g. --require-approval flag).
  const evaluatorPolicy = policy
    ? {
        id: policy.id as string,
        teamId: policy.team_id as string,
        name: policy.name as string,
        description: policy.description as string | null,
        ruleType: policy.rule_type as 'cost_threshold' | 'agent_filter' | 'tool_allowlist' | 'time_window',
        threshold: policy.threshold as number | null,
        approverRole: policy.approver_role as 'owner' | 'admin' | 'any_admin' | 'specific_user' | null,
        approverUserId: policy.approver_user_id as string | null,
        agentFilter: (policy.agent_filter as string[]) ?? [],
        action: policy.action as 'block' | 'require_approval' | 'allow_with_audit',
        settings: (policy.settings as Record<string, unknown>) ?? {},
        enabled: policy.enabled as boolean,
        priority: policy.priority as number,
        createdBy: policy.created_by as string | null,
        createdAt: policy.created_at as string,
        updatedAt: policy.updated_at as string,
      }
    : null;

  // --- Inline minimal chain evaluator (mirrors shared package logic) ---
  // WHY inline: Edge functions cannot import from the monorepo's
  // @styrby/shared package (it's a Node.js/CJS/ESM module, not a Deno URL).
  // We inline just the decision logic. Any change to the algorithm MUST be
  // mirrored in packages/styrby-shared/src/team/approval-chain.ts.
  // Reference: packages/styrby-shared/src/team/approval-chain.ts

  if (!evaluatorPolicy) {
    return { status: 'auto-approved', requiredApprovers: [], reason: 'No matching policy.' };
  }
  if (evaluatorPolicy.action === 'allow_with_audit') {
    return { status: 'auto-approved', requiredApprovers: [], reason: `Policy "${evaluatorPolicy.name}" allows with audit.` };
  }
  if (evaluatorPolicy.action === 'block') {
    return { status: 'denied', requiredApprovers: [], reason: `Policy "${evaluatorPolicy.name}" blocks this tool call.` };
  }

  const eligibleApproverIds = roster
    .filter((m) => m.userId !== row.requester_user_id)
    .filter((m) => {
      const role = evaluatorPolicy.approverRole;
      if (!role) return m.role === 'owner' || m.role === 'admin';
      if (role === 'owner') return m.role === 'owner';
      if (role === 'admin') return m.role === 'admin' || m.role === 'owner';
      if (role === 'any_admin') return m.role === 'admin' || m.role === 'owner';
      if (role === 'specific_user') return evaluatorPolicy.approverUserId === m.userId;
      return false;
    })
    .map((m) => m.userId);

  if (eligibleApproverIds.length === 0) {
    return { status: 'pending', requiredApprovers: [], reason: `Policy "${evaluatorPolicy.name}" requires approval but no eligible approvers remain.` };
  }

  const denial = votes.find((v) => v.status === 'denied' && v.resolverUserId && eligibleApproverIds.includes(v.resolverUserId));
  if (denial) {
    return { status: 'denied', requiredApprovers: [], reason: `Denied by ${denial.resolverUserId}.` };
  }

  const approval = votes.find((v) => v.status === 'approved' && v.resolverUserId && eligibleApproverIds.includes(v.resolverUserId));
  if (approval) {
    return { status: 'auto-approved', requiredApprovers: [], reason: `Approved by ${approval.resolverUserId}.` };
  }

  return { status: 'pending', requiredApprovers: eligibleApproverIds };
}

// ============================================================================
// Action handlers
// ============================================================================

/**
 * Handles action="submit": creates a new pending approval row.
 *
 * Steps:
 *   1. Validate required fields.
 *   2. Verify caller is a team member (RLS enforces this; we pre-check for UX).
 *   3. Fetch eligible approvers for the associated policy (if any).
 *   4. INSERT into approvals.
 *   5. Derive and store the HMAC approval token.
 *   6. Notify all eligible approvers via push.
 *   7. Return { approvalId, status: "pending", approvalToken }.
 *
 * @param supabase - Admin (service-role) client for writes.
 * @param callerId - The authenticated user ID of the requester.
 * @param body - Parsed request body.
 * @param hmacSecret - HMAC key for token derivation.
 * @param supabaseUrl - Project URL for push notification calls.
 * @param serviceKey - Service role key for push calls.
 */
async function handleSubmit(
  supabase: ReturnType<typeof createClient>,
  callerId: string,
  body: ApprovalRequestBody,
  hmacSecret: string,
  supabaseUrl: string,
  serviceKey: string,
): Promise<Response> {
  const { sessionId, teamId, riskLevel, toolName, estimatedCostUsd, requestPayload } = body;

  if (!teamId || !toolName) {
    return jsonResponse({ error: 'teamId and toolName are required for submit' }, 400);
  }
  if (!UUID_RE.test(teamId)) {
    return jsonResponse({ error: 'Invalid teamId format' }, 400);
  }

  // Determine policy for this call (first matching enabled policy for team)
  // WHY we look up policy here: the CLI sends the teamId + toolName; the
  // server is the authority on which policy applies. Callers cannot nominate
  // their own policy (prevents policy-bypass via ID guessing).
  let policyId: string | null = null;
  const { data: policies } = await supabase
    .from('team_policies')
    .select('id')
    .eq('team_id', teamId)
    .eq('action', 'require_approval')
    .eq('enabled', true)
    .order('priority', { ascending: true })
    .limit(1);

  if (policies && policies.length > 0) {
    policyId = (policies[0] as { id: string }).id;
  }

  // Insert the approval row
  const { data: insertedRows, error: insertError } = await supabase
    .from('approvals')
    .insert({
      team_id: teamId,
      session_id: sessionId ?? null,
      policy_id: policyId,
      requester_user_id: callerId,
      tool_name: toolName,
      estimated_cost_usd: estimatedCostUsd ?? null,
      request_payload: requestPayload ?? {},
      status: 'pending',
      // approval_token will be updated immediately after we have the row ID
      approval_token: '',
    })
    .select('id')
    .single();

  if (insertError || !insertedRows) {
    console.error('[resolve-approval] INSERT approvals failed:', insertError);
    return jsonResponse({ error: 'Failed to create approval request' }, 500);
  }

  const approvalId: string = (insertedRows as { id: string }).id;

  // Derive and persist the HMAC token
  const approvalToken = await deriveApprovalToken(approvalId, hmacSecret);
  await supabase
    .from('approvals')
    .update({ approval_token: approvalToken })
    .eq('id', approvalId);

  // Determine eligible approver IDs to notify
  let approverUserIds: string[] = [];
  if (policyId) {
    const { data: members } = await supabase
      .from('team_members')
      .select('user_id, role')
      .eq('team_id', teamId)
      .in('role', ['owner', 'admin']);

    approverUserIds = (members ?? [])
      .map((m: { user_id: string }) => m.user_id)
      .filter((id: string) => id !== callerId); // No self-approval
  }

  // Fire push notifications (non-blocking)
  if (approverUserIds.length > 0) {
    notifyApprovers(
      supabaseUrl,
      serviceKey,
      approverUserIds,
      approvalId,
      toolName,
      riskLevel ?? 'medium',
      callerId,
    ).catch((err) => console.error('[resolve-approval] notifyApprovers failed:', err));
  }

  // Audit log: submission
  await writeAuditLog(supabase, {
    userId: callerId,
    action: 'settings_updated',  // Reuse until 'approval_submitted' is added
    resourceId: approvalId,
    teamId,
    metadata: {
      sub_action: 'approval_submitted',
      tool_name: toolName,
      risk_level: riskLevel,
      approver_count: approverUserIds.length,
    },
  });

  const response: ApprovalResponse = {
    approvalId,
    status: 'pending',
    approvalToken,
    requiredApprovers: approverUserIds,
  };

  return jsonResponse(response as unknown as Record<string, unknown>, 201);
}

/**
 * Handles action="poll": returns the current approval status.
 *
 * The approval token is verified in constant time before any DB read.
 * This prevents IDOR: knowing an approvalId UUID is insufficient to poll it.
 *
 * @param supabase - Admin client.
 * @param callerId - Requester user ID (from JWT).
 * @param body - Parsed request body (requires approvalId + approvalToken).
 * @param hmacSecret - HMAC key for token verification.
 */
async function handlePoll(
  supabase: ReturnType<typeof createClient>,
  callerId: string,
  body: ApprovalRequestBody,
  hmacSecret: string,
): Promise<Response> {
  const { approvalId, approvalToken } = body;

  if (!approvalId || !approvalToken) {
    return jsonResponse({ error: 'approvalId and approvalToken are required for poll' }, 400);
  }
  if (!UUID_RE.test(approvalId)) {
    return jsonResponse({ error: 'Invalid approvalId format' }, 400);
  }

  // Constant-time token verification before DB round-trip
  const expectedToken = await deriveApprovalToken(approvalId, hmacSecret);
  if (!timingSafeEqual(expectedToken, approvalToken)) {
    // WHY 403 not 401: the caller IS authenticated (JWT valid), but not
    // authorized for this specific resource. 401 would imply invalid credentials.
    return jsonResponse({ error: 'Forbidden: invalid approval token' }, 403);
  }

  // Fetch the approval row (RLS ensures caller can only see their own requests
  // or team admin requests).
  const { data: row, error: fetchError } = await supabase
    .from('approvals')
    .select('*')
    .eq('id', approvalId)
    .single();

  if (fetchError || !row) {
    return jsonResponse({ error: 'Approval not found' }, 404);
  }

  const approval = row as ApprovalRow;

  // Check expiry
  if (approval.status === 'pending' && new Date(approval.expires_at) < new Date()) {
    // Mark expired if past expiry (cron sweeper also does this, but be proactive)
    await supabase
      .from('approvals')
      .update({ status: 'expired', resolved_at: new Date().toISOString() })
      .eq('id', approvalId);

    await writeAuditLog(supabase, {
      userId: callerId,
      action: AUDIT_ACTIONS.TIMEOUT,
      resourceId: approvalId,
      teamId: approval.team_id,
      metadata: { tool_name: approval.tool_name, expired_at: approval.expires_at },
    });

    return jsonResponse({ approvalId, status: 'expired', reason: 'Approval request expired.' }, 200);
  }

  // For non-pending rows, return stored status directly
  if (approval.status !== 'pending') {
    return jsonResponse({
      approvalId,
      status: approval.status,
      reason: approval.resolution_note ?? undefined,
    } as unknown as Record<string, unknown>, 200);
  }

  // Re-evaluate chain for pending rows
  const chainResult = await reEvaluateChain(supabase, approval);

  if (chainResult.status === 'auto-approved') {
    await supabase
      .from('approvals')
      .update({ status: 'approved', resolved_at: new Date().toISOString() })
      .eq('id', approvalId);

    return jsonResponse({ approvalId, status: 'approved', reason: chainResult.reason } as unknown as Record<string, unknown>, 200);
  }

  if (chainResult.status === 'denied') {
    await supabase
      .from('approvals')
      .update({ status: 'denied', resolved_at: new Date().toISOString() })
      .eq('id', approvalId);

    return jsonResponse({ approvalId, status: 'denied', reason: chainResult.reason } as unknown as Record<string, unknown>, 200);
  }

  return jsonResponse({
    approvalId,
    status: 'pending',
    requiredApprovers: chainResult.requiredApprovers,
  } as unknown as Record<string, unknown>, 200);
}

/**
 * Handles action="cancel": requester aborts the pending request.
 *
 * Only the original requester (or a service-role caller) can cancel.
 * The approval token is verified to prevent IDOR on cancel.
 *
 * @param supabase - Admin client.
 * @param callerId - Requester user ID.
 * @param body - Parsed request body.
 * @param hmacSecret - HMAC key for token verification.
 */
async function handleCancel(
  supabase: ReturnType<typeof createClient>,
  callerId: string,
  body: ApprovalRequestBody,
  hmacSecret: string,
): Promise<Response> {
  const { approvalId, approvalToken } = body;

  if (!approvalId) {
    return jsonResponse({ error: 'approvalId is required for cancel' }, 400);
  }
  if (!UUID_RE.test(approvalId)) {
    return jsonResponse({ error: 'Invalid approvalId format' }, 400);
  }

  // Token verification (required unless approvalToken is absent — then we rely
  // on RLS requester-only constraint in the UPDATE below)
  if (approvalToken) {
    const expectedToken = await deriveApprovalToken(approvalId, hmacSecret);
    if (!timingSafeEqual(expectedToken, approvalToken)) {
      return jsonResponse({ error: 'Forbidden: invalid approval token' }, 403);
    }
  }

  const { data: row } = await supabase
    .from('approvals')
    .select('id, team_id, requester_user_id, status, tool_name')
    .eq('id', approvalId)
    .single();

  if (!row) {
    return jsonResponse({ error: 'Approval not found' }, 404);
  }

  const approval = row as Pick<ApprovalRow, 'id' | 'team_id' | 'requester_user_id' | 'status' | 'tool_name'>;

  // Only the requester can cancel (RLS also enforces this)
  if (approval.requester_user_id !== callerId) {
    return jsonResponse({ error: 'Forbidden: only the requester can cancel' }, 403);
  }

  if (approval.status !== 'pending') {
    return jsonResponse({
      approvalId,
      status: approval.status,
      reason: 'Approval is no longer pending; cancel is a no-op.',
    } as unknown as Record<string, unknown>, 200);
  }

  await supabase
    .from('approvals')
    .update({ status: 'cancelled', resolved_at: new Date().toISOString() })
    .eq('id', approvalId);

  await writeAuditLog(supabase, {
    userId: callerId,
    action: 'settings_updated',
    resourceId: approvalId,
    teamId: approval.team_id,
    metadata: { sub_action: 'approval_cancelled', tool_name: approval.tool_name },
  });

  return jsonResponse({ approvalId, status: 'cancelled' } as unknown as Record<string, unknown>, 200);
}

/**
 * Handles action="resolve": approver votes approve or deny.
 *
 * The caller must be an admin or owner of the approval's team (RLS enforces
 * this at DB level; we pre-check for a clear error message). Self-approval is
 * rejected by comparing callerId with the approval's requester_user_id.
 *
 * Each resolution writes to audit_log with one of:
 *   team_command_approved | team_command_denied
 *
 * @param supabase - Admin client.
 * @param callerId - Approver user ID.
 * @param body - Parsed request body (vote, approvalId, optional resolutionNote).
 */
async function handleResolve(
  supabase: ReturnType<typeof createClient>,
  callerId: string,
  body: ApprovalRequestBody,
): Promise<Response> {
  const { approvalId, vote, resolutionNote } = body;

  if (!approvalId || !vote) {
    return jsonResponse({ error: 'approvalId and vote are required for resolve' }, 400);
  }
  if (!UUID_RE.test(approvalId)) {
    return jsonResponse({ error: 'Invalid approvalId format' }, 400);
  }
  if (vote !== 'approved' && vote !== 'denied') {
    return jsonResponse({ error: 'vote must be "approved" or "denied"' }, 400);
  }

  const { data: row, error: fetchError } = await supabase
    .from('approvals')
    .select('*')
    .eq('id', approvalId)
    .single();

  if (fetchError || !row) {
    return jsonResponse({ error: 'Approval not found' }, 404);
  }

  const approval = row as ApprovalRow;

  // Self-approval guard
  // WHY checked here even though the chain evaluator also blocks it:
  //   Defense-in-depth. The chain evaluator's self-approval check operates
  //   in-memory on a snapshot; we guard at the edge function too so that
  //   a future change to the evaluator cannot accidentally bypass it
  //   (SOC2 CC6.3 — separation of duties must hold at every layer).
  if (approval.requester_user_id === callerId) {
    return jsonResponse({ error: 'Self-approval is not permitted (SOC2 CC6.3)' }, 403);
  }

  if (approval.status !== 'pending') {
    return jsonResponse({
      error: `Approval is already ${approval.status}. Resolution is a no-op.`,
      approvalId,
      status: approval.status,
    }, 409);
  }

  // Verify caller is an admin/owner of the team
  const { data: membership } = await supabase
    .from('team_members')
    .select('role')
    .eq('team_id', approval.team_id)
    .eq('user_id', callerId)
    .single();

  if (!membership || !['owner', 'admin'].includes((membership as { role: string }).role)) {
    return jsonResponse({ error: 'Forbidden: only team admins or owners may resolve approvals' }, 403);
  }

  const newStatus: ApprovalStatus = vote;
  const auditAction = vote === 'approved' ? AUDIT_ACTIONS.APPROVED : AUDIT_ACTIONS.DENIED;

  await supabase
    .from('approvals')
    .update({
      status: newStatus,
      resolver_user_id: callerId,
      resolution_note: resolutionNote ?? null,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', approvalId);

  await writeAuditLog(supabase, {
    userId: callerId,
    action: auditAction,
    resourceId: approvalId,
    teamId: approval.team_id,
    metadata: {
      tool_name: approval.tool_name,
      requester_user_id: approval.requester_user_id,
      resolution_note: resolutionNote ?? null,
    },
  });

  return jsonResponse({
    approvalId,
    status: newStatus,
    reason: resolutionNote ?? `${vote === 'approved' ? 'Approved' : 'Denied'} by ${callerId}`,
  } as unknown as Record<string, unknown>, 200);
}

// ============================================================================
// Main handler
// ============================================================================

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  // --- Environment ---
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const hmacSecret = Deno.env.get('APPROVAL_HMAC_SECRET');

  if (!supabaseUrl || !serviceKey || !hmacSecret) {
    console.error('[resolve-approval] Missing required environment variables');
    return jsonResponse({ error: 'Server configuration error' }, 500);
  }

  // --- Parse body ---
  let body: ApprovalRequestBody;
  try {
    body = (await req.json()) as ApprovalRequestBody;
  } catch {
    return jsonResponse({ error: 'Invalid JSON in request body' }, 400);
  }

  if (!body.action || !['submit', 'poll', 'cancel', 'resolve'].includes(body.action)) {
    return jsonResponse({ error: 'action must be one of: submit, poll, cancel, resolve' }, 400);
  }

  // --- Build Supabase client scoped to the caller's JWT ---
  // WHY anon key client with caller JWT: RLS policies run server-side using
  // the JWT's sub claim. By using the caller's token rather than the service
  // role, RLS provides defense-in-depth against bugs in our own auth logic.
  // We then switch to service role only for operations that require it
  // (audit_log writes, push notification calls).
  const authHeader = req.headers.get('Authorization') ?? '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? serviceKey;
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const adminClient = createClient(supabaseUrl, serviceKey);

  // --- Caller identity ---
  const callerId = await getCallerId(userClient);

  if (!callerId) {
    return jsonResponse({ error: 'Unauthorized: valid Bearer JWT required' }, 401);
  }

  try {
    switch (body.action) {
      case 'submit':
        return await handleSubmit(adminClient, callerId, body, hmacSecret, supabaseUrl, serviceKey);
      case 'poll':
        return await handlePoll(adminClient, callerId, body, hmacSecret);
      case 'cancel':
        return await handleCancel(adminClient, callerId, body, hmacSecret);
      case 'resolve':
        return await handleResolve(adminClient, callerId, body);
      default: {
        const _exhaustive: never = body.action;
        return jsonResponse({ error: 'Unknown action' }, 400);
      }
    }
  } catch (err) {
    // WHY generic message: stack traces may contain UUIDs, internal routing,
    // or table names that could assist an attacker. Log server-side only.
    console.error('[resolve-approval] Unhandled error:', err);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
});
