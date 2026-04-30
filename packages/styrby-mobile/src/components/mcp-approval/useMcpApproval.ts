/**
 * useMcpApproval — state hook for the MCP approval screen
 *
 * Handles three concerns:
 *   1. Loading the request audit_log row by `resource_id = approvalId`.
 *   2. Submitting the user's decision via {@link writeMcpApprovalDecision},
 *      with biometric gating for `risk='high'`/`risk='critical'` approvals.
 *   3. Tracking the live countdown until the CLI's poll loop times out.
 *
 * Pulled out of the route handler so the component layer stays thin and
 * testable without a fully-mounted Expo router. Mirrors the
 * `useApprovalActions` co-location pattern from the legacy team-review
 * approval UX (see packages/styrby-mobile/src/components/approvals/).
 *
 * @module components/mcp-approval/useMcpApproval
 */

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import {
  writeMcpApprovalDecision,
  type WriteMcpApprovalDecisionInput,
} from '@/services/mcp-approval';
import type { RiskLevel } from '@/components/approvals/ApprovalRequestCard';

// ============================================================================
// Constants
// ============================================================================

/**
 * Risk levels that trigger the biometric prompt before approve.
 *
 * WHY high+critical only: low/medium correspond to read-only or sandboxed
 * MCP tool calls (file read, lint, format). High/critical map to writes,
 * shell exec, or network egress — exactly the surfaces where a stolen-phone
 * attacker should hit a hardware authenticator. Matches the legacy team
 * approval UX threshold so users have a single mental model across both
 * approval streams.
 */
const BIOMETRIC_GATED_RISK: ReadonlyArray<RiskLevel> = ['high', 'critical'];

/**
 * CLI's default per-request poll timeout (matches packages/styrby-cli's
 * server.ts → DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000).
 *
 * WHY duplicated here instead of imported: importing the CLI package into
 * the mobile bundle pulls Node-only deps (node:crypto). The constant is
 * stable across both surfaces; if the CLI default ever changes, this
 * constant must be updated in lockstep — flagged via the comment above.
 */
const CLI_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Tick cadence for the countdown display.
 *
 * WHY 1s: matches the second-resolution display ("4:32") so the visible
 * digit changes exactly when the underlying value crosses a second boundary.
 * Faster ticking would burn battery for no perceptible benefit.
 */
const COUNTDOWN_TICK_MS = 1000;

// ============================================================================
// Types
// ============================================================================

/**
 * The deserialised request payload as displayed on the screen.
 * Mirrors `ApprovalMetadata` from the CLI side — keep field names aligned.
 */
export interface McpApprovalRequest {
  /** Same as the route param. */
  approvalId: string;
  /** The MCP tool action being approved (e.g. 'bash', 'edit'). */
  requestedAction: string;
  /** Human-readable rationale supplied by the agent. */
  reason: string;
  /** Risk classification chosen by the CLI policy engine. */
  risk: RiskLevel;
  /** CLI machine that originated the request (truncated for display). */
  machineId: string;
  /** Free-form context blob (e.g. `{ command: 'npm install' }`). */
  context: Record<string, unknown> | null;
  /** ISO 8601 timestamp from audit_log.created_at. */
  createdAt: string;
}

/**
 * Inputs for {@link useMcpApproval}.
 */
export interface UseMcpApprovalInput {
  /** Approval UUID from the deep link. */
  approvalId: string;
  /**
   * Override for {@link writeMcpApprovalDecision}, used by tests to inject a
   * stub without monkey-patching the module.
   */
  writeDecision?: typeof writeMcpApprovalDecision;
  /**
   * Override for the biometric prompt. Defaults to a dynamic import of
   * expo-local-authentication; tests inject `() => true` for the gated
   * happy path or `() => false` for the cancellation path.
   */
  biometricPrompt?: (reason: string) => Promise<boolean>;
  /** Called after a successful decision write so the screen can dismiss. */
  onResolved?: (decision: 'approved' | 'denied') => void;
}

/**
 * Return value of {@link useMcpApproval}.
 */
export interface UseMcpApprovalResult {
  /** Loaded request data, or null while still fetching. */
  request: McpApprovalRequest | null;
  /** Initial fetch state. */
  isLoading: boolean;
  /** Fetch error message, or null. */
  loadError: string | null;
  /** True while a decision write is in-flight. */
  isSubmitting: boolean;
  /** Submission error message, or null. */
  submitError: string | null;
  /** Seconds remaining before the CLI poll loop times out, or 0 if expired. */
  secondsRemaining: number;
  /**
   * Submit an approve/deny decision. Triggers the biometric gate when the
   * loaded request is high-risk and the decision is 'approved'.
   */
  submit: (
    decision: 'approved' | 'denied',
    userMessage?: string,
  ) => Promise<void>;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Default biometric prompt using expo-local-authentication.
 *
 * WHY dynamic import: the screen module evaluates at app cold-start during
 * deep-link handling. Statically importing expo-local-authentication would
 * pull its native bridge into every route, even ones that never gate.
 * Dynamic import keeps the cost on the gated code path only.
 *
 * WHY fail-closed when hardware is missing: in the absence of biometrics,
 * a high-risk approval would fall through with no second factor. Returning
 * false forces the user to deny (or the CLI to time out) rather than
 * silently waving through the approval.
 *
 * @param reason - User-visible justification shown in the system prompt.
 * @returns true when the biometric check succeeded; false otherwise.
 */
async function defaultBiometricPrompt(reason: string): Promise<boolean> {
  try {
    const LocalAuthentication = await import('expo-local-authentication');
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const isEnrolled = await LocalAuthentication.isEnrolledAsync();
    if (!hasHardware || !isEnrolled) {
      // WHY fail-closed: see function header.
      return false;
    }
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      cancelLabel: 'Cancel',
      disableDeviceFallback: false,
    });
    return result.success === true;
  } catch {
    // WHY swallow: dynamic import failure / native bridge unavailable
    // (Expo Go, dev shell). Same fail-closed posture as above.
    return false;
  }
}

/**
 * Audit_log row shape returned by the SELECT query.
 * Listed inline so we don't depend on a generated database.types module.
 */
interface AuditLogRow {
  id: string;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

/**
 * Type guard that validates the raw audit_log metadata blob has the shape
 * the CLI promises (see `ApprovalMetadata` in approvalHandler.ts).
 *
 * WHY guard instead of cast: metadata is stored in JSONB and could be any
 * shape if the row was tampered with via service-role write. The guard
 * surfaces a clear error to the UI rather than silently rendering undefined.
 */
function isApprovalMetadata(
  meta: Record<string, unknown> | null,
): meta is {
  approval_id: string;
  requested_action: string;
  reason: string;
  risk: RiskLevel;
  machine_id: string;
  context?: Record<string, unknown>;
} {
  if (!meta) return false;
  return (
    typeof meta.approval_id === 'string' &&
    typeof meta.requested_action === 'string' &&
    typeof meta.reason === 'string' &&
    typeof meta.risk === 'string' &&
    typeof meta.machine_id === 'string'
  );
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Manages the MCP approval screen lifecycle.
 *
 * @param input - Approval ID + optional test injection points.
 * @returns Render data + actions for the screen component.
 */
export function useMcpApproval({
  approvalId,
  writeDecision = writeMcpApprovalDecision,
  biometricPrompt = defaultBiometricPrompt,
  onResolved,
}: UseMcpApprovalInput): UseMcpApprovalResult {
  const [request, setRequest] = useState<McpApprovalRequest | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [secondsRemaining, setSecondsRemaining] = useState(0);

  // --- Initial fetch -----------------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    /**
     * Loads the audit_log request row by resource_id and parses metadata.
     * RLS ensures the user can only read their own rows; an empty result
     * means the approval is for someone else (or has been deleted).
     */
    async function load(): Promise<void> {
      setIsLoading(true);
      setLoadError(null);

      const { data, error } = await supabase
        .from('audit_log')
        .select('id, action, resource_type, resource_id, metadata, created_at')
        .eq('resource_id', approvalId)
        .eq('action', 'mcp_approval_requested')
        .limit(1)
        .maybeSingle<AuditLogRow>();

      if (cancelled) return;

      if (error) {
        setLoadError(`Could not load approval request: ${error.message}`);
        setIsLoading(false);
        return;
      }
      if (!data) {
        setLoadError('Approval request not found or already resolved.');
        setIsLoading(false);
        return;
      }
      if (!isApprovalMetadata(data.metadata)) {
        setLoadError('Approval request payload is malformed.');
        setIsLoading(false);
        return;
      }

      const parsed: McpApprovalRequest = {
        approvalId,
        requestedAction: data.metadata.requested_action,
        reason: data.metadata.reason,
        risk: data.metadata.risk,
        machineId: data.metadata.machine_id,
        context: data.metadata.context ?? null,
        createdAt: data.created_at,
      };

      setRequest(parsed);
      setIsLoading(false);
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [approvalId]);

  // --- Countdown ---------------------------------------------------------------

  useEffect(() => {
    if (!request) return;

    const deadlineMs = new Date(request.createdAt).getTime() + CLI_REQUEST_TIMEOUT_MS;

    /**
     * Recomputes the seconds-remaining state. Stops ticking once the value
     * hits zero so we don't keep firing setState forever after expiry.
     */
    const tick = (): void => {
      const remainingMs = deadlineMs - Date.now();
      const remaining = Math.max(0, Math.floor(remainingMs / 1000));
      setSecondsRemaining(remaining);
    };

    tick();
    const interval = setInterval(tick, COUNTDOWN_TICK_MS);
    return () => clearInterval(interval);
  }, [request]);

  // --- Submit ------------------------------------------------------------------

  const submit = useCallback(
    async (decision: 'approved' | 'denied', userMessage?: string): Promise<void> => {
      if (isSubmitting) return; // double-submit guard
      if (!request) {
        setSubmitError('Approval request has not loaded yet.');
        return;
      }

      setIsSubmitting(true);
      setSubmitError(null);

      try {
        // WHY biometric gate only on approve+highRisk: denying never escalates
        // privilege; the worst case for an attacker is wasting the agent's time.
        // Approving a high-risk action lets the agent run shell commands,
        // edit files, or call the network — exactly the surfaces a stolen-phone
        // attacker would target. Match `BIOMETRIC_GATED_RISK` constant above.
        if (decision === 'approved' && BIOMETRIC_GATED_RISK.includes(request.risk)) {
          const ok = await biometricPrompt(
            `Confirm approval of ${request.requestedAction}`,
          );
          if (!ok) {
            setSubmitError('Biometric check failed or cancelled.');
            return;
          }
        }

        const payload: WriteMcpApprovalDecisionInput = {
          approvalId,
          decision,
          ...(userMessage && userMessage.length > 0 ? { userMessage } : {}),
        };

        await writeDecision(payload);
        onResolved?.(decision);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error.';
        setSubmitError(message);
      } finally {
        setIsSubmitting(false);
      }
    },
    [approvalId, biometricPrompt, isSubmitting, onResolved, request, writeDecision],
  );

  return {
    request,
    isLoading,
    loadError,
    isSubmitting,
    submitError,
    secondsRemaining,
    submit,
  };
}
