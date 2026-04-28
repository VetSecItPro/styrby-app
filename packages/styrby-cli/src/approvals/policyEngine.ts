/**
 * CLI policy engine (Phase 2.1).
 *
 * Called by the CLI before executing a tool call that may be governed
 * by a team policy. Polls the Supabase `resolve-approval` edge function
 * until the approval terminates or timeout elapses.
 *
 * Responsibilities:
 *   - Submit the approval request (if not already created server-side).
 *   - Poll every 5 s for up to 60 s.
 *   - Emit the correct exit code for the CLI runner to interpret.
 *   - Clean up (cancel the pending row) on SIGINT so we never leave
 *     orphaned `pending` approvals blocking other tool calls.
 *
 * The *decision logic* lives in `styrby-shared` (team/approval-chain)
 * and is used here only for the client-side pre-check — "this call will
 * require approval from X, Y, Z" — rendered in the terminal before we
 * submit. The authoritative decision always comes from the edge
 * function and the DB.
 *
 * @module approvals/policyEngine
 */

import {
  evaluateApprovalChain,
  POLICY_ENGINE_EXIT_CODES,
  type Approval,
  type ApprovalChainResult,
  type PolicyEngineExitCode,
  type RosterMember,
  type TeamPolicy,
} from 'styrby-shared';

// ============================================================================
// Public API
// ============================================================================

/** Risk classification for the tool call. Passed through to the server. */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/** Inputs to {@link runPolicyEngine}. */
export interface PolicyEngineInput {
  /** Active Styrby session id. */
  sessionId: string;

  /**
   * Team ID that owns this session.
   *
   * Required by the `resolve-approval` edge function (`handleSubmit`)
   * to associate the pending approval row with a team and look up the
   * correct policy + eligible approvers. Callers obtain this from the
   * session's `team_id` column or from the authenticated user's primary team.
   */
  teamId: string;

  /** Tool-call risk classification. */
  riskLevel: RiskLevel;

  /** Tool being invoked (e.g., 'Bash'). Pass-through to the server. */
  toolName: string;

  /** Estimated USD cost of the call, if known. */
  estimatedCostUsd?: number;

  /** Arbitrary payload describing the call (parsed by server policies). */
  requestPayload?: Record<string, unknown>;

  /** Supabase project URL (required). */
  supabaseUrl: string;

  /** User-scoped Supabase JWT (required). */
  authToken: string;

  /**
   * Optional — pre-fetched policy + roster + requester used for the
   * client-side pre-check ("will require approval from X, Y, Z"). When
   * omitted, the pre-check is skipped and we go straight to polling.
   */
  preCheck?: {
    policy: TeamPolicy | null;
    roster: ReadonlyArray<RosterMember>;
    requesterUserId: string;
  };

  // -------- Test seams (all optional) ---------------------------------------

  /**
   * Override for `fetch`. Defaults to `globalThis.fetch`. Tests swap this
   * out to stub the edge function.
   */
  fetchImpl?: typeof fetch;

  /**
   * Override poll interval (ms). Defaults to 5000 ms. Tests reduce this
   * to run quickly.
   */
  pollIntervalMs?: number;

  /** Override timeout (ms). Defaults to 60_000 ms. */
  timeoutMs?: number;

  /**
   * AbortSignal the caller can raise to cancel early. We always register
   * a SIGINT handler too, but tests use this to drive cancellation
   * deterministically.
   */
  signal?: AbortSignal;

  /**
   * Stream of status messages — one line per poll / decision. Tests pass
   * a recorder; real CLI passes stderr or the TUI.
   */
  onStatus?: (message: string) => void;
}

/** Result of {@link runPolicyEngine}. */
export interface PolicyEngineResult {
  exitCode: PolicyEngineExitCode;
  status: 'approved' | 'denied' | 'timeout' | 'cancelled';
  approvalId?: string;
  reason?: string;
}

// ============================================================================
// Implementation
// ============================================================================

const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Run the policy engine for one tool call.
 *
 * @param input - See {@link PolicyEngineInput}.
 * @returns Terminal status + CLI exit code.
 *
 * @example
 *   const result = await runPolicyEngine({
 *     sessionId, riskLevel: 'high', toolName: 'Bash',
 *     supabaseUrl, authToken,
 *   });
 *   process.exit(result.exitCode);
 */
export async function runPolicyEngine(
  input: PolicyEngineInput,
): Promise<PolicyEngineResult> {
  const {
    sessionId,
    teamId,
    riskLevel,
    toolName,
    estimatedCostUsd,
    requestPayload,
    supabaseUrl,
    authToken,
    preCheck,
    fetchImpl = globalThis.fetch,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal: externalSignal,
    onStatus = () => {},
  } = input;

  // --- Client-side pre-check (optional) ------------------------------------
  // WHY this is ONLY advisory: the server re-evaluates the chain on every
  //   vote. The terminal message is UX — never relied on for security.
  if (preCheck) {
    const pre = evaluateApprovalChain({
      policy: preCheck.policy,
      approvals: [],
      roster: preCheck.roster,
      requesterUserId: preCheck.requesterUserId,
    });
    emitPreCheckMessage(onStatus, pre);
  }

  // --- Wire up cancellation (SIGINT + external signal) ---------------------
  const controller = new AbortController();
  const onSigint = () => {
    onStatus('Cancellation requested (SIGINT). Cleaning up...');
    controller.abort(new Error('SIGINT'));
  };
  const onExternalAbort = () => controller.abort(externalSignal?.reason);

  // WHY we guard with `once`: repeated SIGINTs shouldn't multiply handlers.
  process.once('SIGINT', onSigint);
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  let approvalId: string | undefined;
  // WHY we store approvalToken separately from approvalId:
  //   The `resolve-approval` edge function uses HMAC-SHA256 token verification
  //   on poll and cancel to prevent IDOR — knowing an approvalId UUID alone is
  //   insufficient to drive the row. The token is returned by submit and must
  //   be forwarded on every subsequent call (ISO 27001 A.9.1).
  let approvalToken: string | undefined;

  try {
    // --- Submit the approval request --------------------------------------
    // The `resolve-approval` edge function is ACTIVE on Supabase (verified
    // 2026-04-28). It requires `teamId` to associate the row with a team and
    // look up the correct policy. On success it returns `{ approvalId,
    // approvalToken, status }` where approvalToken is HMAC-SHA256(approvalId)
    // and MUST be forwarded on all poll/cancel calls.
    //
    // FAIL-CLOSED policy (OWASP A01 — Broken Access Control):
    //   Any non-2xx response from the edge function, or a network error,
    //   results in an explicit DENY rather than a silent pass-through.
    //   This ensures that if the endpoint is unreachable (503, 404, cold-start
    //   timeout), tool calls are blocked rather than accidentally allowed.
    let submitResult: ResolveApprovalResponse;
    try {
      submitResult = await postResolveApproval(fetchImpl, {
        supabaseUrl,
        authToken,
        body: {
          sessionId,
          teamId,
          riskLevel,
          toolName,
          estimatedCostUsd,
          requestPayload: requestPayload ?? {},
          action: 'submit',
        },
        signal: controller.signal,
      });
    } catch (err) {
      // Fail closed: any submit failure (network error, 4xx/5xx) is treated
      // as an explicit denial rather than a pass-through.
      const reason =
        err instanceof Error
          ? `policy engine unavailable — defaulting to deny (${err.message})`
          : 'policy engine unavailable — defaulting to deny';
      onStatus(`[policyEngine] Submit failed: ${reason}`);
      return {
        exitCode: POLICY_ENGINE_EXIT_CODES.DENIED,
        status: 'denied',
        approvalId: undefined,
        reason,
      };
    }

    approvalId = submitResult.approvalId;
    approvalToken = submitResult.approvalToken;

    if (submitResult.status === 'approved' || submitResult.status === 'denied') {
      // Server can short-circuit (e.g., policy action = 'block').
      return terminalResult(submitResult.status, approvalId, submitResult.reason);
    }

    // --- Poll loop ---------------------------------------------------------
    const deadline = Date.now() + timeoutMs;
    while (!controller.signal.aborted) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        onStatus(`Approval timed out after ${timeoutMs} ms.`);
        await safeCancel(fetchImpl, supabaseUrl, authToken, approvalId, approvalToken);
        return {
          exitCode: POLICY_ENGINE_EXIT_CODES.TIMEOUT,
          status: 'timeout',
          approvalId,
          reason: 'Timeout waiting for approval.',
        };
      }

      const waitMs = Math.min(pollIntervalMs, remaining);
      await sleep(waitMs, controller.signal);

      if (controller.signal.aborted) break;

      // Fail-closed on poll errors: a transient network failure during polling
      // is treated as a denial rather than an optimistic pass-through.
      let poll: ResolveApprovalResponse;
      try {
        poll = await postResolveApproval(fetchImpl, {
          supabaseUrl,
          authToken,
          body: { approvalId, approvalToken, action: 'poll' },
          signal: controller.signal,
        });
      } catch (err) {
        const reason =
          err instanceof Error
            ? `policy engine unavailable during poll — defaulting to deny (${err.message})`
            : 'policy engine unavailable during poll — defaulting to deny';
        onStatus(`[policyEngine] Poll failed: ${reason}`);
        await safeCancel(fetchImpl, supabaseUrl, authToken, approvalId, approvalToken);
        return {
          exitCode: POLICY_ENGINE_EXIT_CODES.DENIED,
          status: 'denied',
          approvalId,
          reason,
        };
      }

      if (poll.status === 'approved' || poll.status === 'denied') {
        return terminalResult(poll.status, approvalId, poll.reason);
      }
      onStatus(`Approval still ${poll.status}. Polling again in ${waitMs} ms.`);
    }

    // --- Cancelled ---------------------------------------------------------
    await safeCancel(fetchImpl, supabaseUrl, authToken, approvalId, approvalToken);
    return {
      exitCode: POLICY_ENGINE_EXIT_CODES.CANCELLED,
      status: 'cancelled',
      approvalId,
      reason: 'Approval cancelled by user.',
    };
  } finally {
    process.removeListener('SIGINT', onSigint);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

// ============================================================================
// Internals
// ============================================================================

/** Payload the `resolve-approval` edge function speaks. */
interface ResolveApprovalRequest {
  // submit fields
  sessionId?: string;
  /** Team ID — required for action="submit" (looked up for policy + approvers). */
  teamId?: string;
  riskLevel?: RiskLevel;
  toolName?: string;
  estimatedCostUsd?: number;
  requestPayload?: Record<string, unknown>;
  // poll / cancel fields
  approvalId?: string;
  /**
   * HMAC-SHA256 token returned by submit.
   *
   * Required for action="poll" and action="cancel" to prevent IDOR:
   * knowing the approvalId UUID alone is insufficient to drive the row
   * (ISO 27001 A.9.1 — timing-safe ownership verification).
   */
  approvalToken?: string;
  action: 'submit' | 'poll' | 'cancel';
}

/** Shape of the edge-function response. */
interface ResolveApprovalResponse {
  approvalId: string;
  status: Approval['status'];
  /**
   * HMAC-SHA256 approval token, returned only on action="submit".
   *
   * Must be forwarded on all subsequent poll and cancel calls to satisfy
   * the edge function's IDOR guard.
   */
  approvalToken?: string;
  reason?: string;
}

async function postResolveApproval(
  fetchImpl: typeof fetch,
  opts: {
    supabaseUrl: string;
    authToken: string;
    body: ResolveApprovalRequest;
    signal: AbortSignal;
  },
): Promise<ResolveApprovalResponse> {
  const url = `${opts.supabaseUrl.replace(/\/+$/, '')}/functions/v1/resolve-approval`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${opts.authToken}`,
    },
    body: JSON.stringify(opts.body),
    signal: opts.signal,
  });

  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(
      `resolve-approval HTTP ${res.status}: ${text || res.statusText}`,
    );
  }

  return (await res.json()) as ResolveApprovalResponse;
}

async function safeCancel(
  fetchImpl: typeof fetch,
  supabaseUrl: string,
  authToken: string,
  approvalId: string | undefined,
  approvalToken: string | undefined,
): Promise<void> {
  if (!approvalId) return;
  // WHY we swallow errors here: we are already on the exit path. Failing
  //   to cancel a row is noisy but not fatal — the cron sweeper defined
  //   in migration 021 will mark it 'expired' within 15 minutes.
  // WHY we pass approvalToken: the edge function verifies it in constant time
  //   for cancel operations. Omitting it would cause a 403 from the server,
  //   leaving an orphaned 'pending' row that only the cron sweeper can clean up.
  try {
    await postResolveApproval(fetchImpl, {
      supabaseUrl,
      authToken,
      body: { approvalId, approvalToken, action: 'cancel' },
      signal: neverAbort,
    });
  } catch {
    // intentional swallow — best-effort cleanup
  }
}

/** A never-aborting signal so cleanup fetches don't inherit the aborted parent. */
const neverAbort: AbortSignal = new AbortController().signal;

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/**
 * Sleep that resolves early when `signal` aborts. Tests advance fake
 * timers and immediately abort to simulate SIGINT mid-wait.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function terminalResult(
  status: 'approved' | 'denied',
  approvalId: string | undefined,
  reason?: string,
): PolicyEngineResult {
  return {
    exitCode:
      status === 'approved'
        ? POLICY_ENGINE_EXIT_CODES.APPROVED
        : POLICY_ENGINE_EXIT_CODES.DENIED,
    status,
    approvalId,
    reason,
  };
}

function emitPreCheckMessage(
  onStatus: (m: string) => void,
  result: ApprovalChainResult,
): void {
  if (result.status === 'auto-approved') {
    onStatus('Pre-check: no approval required for this call.');
    return;
  }
  if (result.status === 'denied') {
    onStatus(`Pre-check: this call will be denied (${result.reason}).`);
    return;
  }
  if (result.requiredApprovers.length === 0) {
    onStatus(
      'Pre-check: approval required but no eligible approvers are available. ' +
        'An admin must fix the policy.',
    );
    return;
  }
  onStatus(
    `Pre-check: this call will require approval from one of ${result.requiredApprovers.join(', ')}.`,
  );
}
