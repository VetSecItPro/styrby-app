/**
 * Pure dispatch logic for relay messages from mobile to the CLI.
 *
 * SECURITY-CRITICAL (CLI-008 + CLI-009): this module owns the schema
 * validation + nonce verification + session-routing logic that decides
 * whether a relay message gets forwarded to the agent or dropped on the
 * floor. Bugs here = either silent message loss (UX) OR — worse — a
 * compromised-account-key attacker bypasses the approval-nonce gate
 * (RCE-class).
 *
 * Extracted from `apiSession.ts` (PR #279) so the security-critical logic
 * could be unit-tested directly. The class-method `handleRelayMessage`
 * now delegates to `classifyRelayMessage()` + dispatches on the returned
 * verdict; effect-side calls (agent.sendPrompt, api.send*) stay in the
 * class.
 *
 * @module api/relayMessageDispatch
 */

import type { z } from 'zod';
import type { RelayMessage } from 'styrby-shared';
import { RelayMessageSchema } from 'styrby-shared';

/**
 * Discriminated-union verdict returned by `classifyRelayMessage`. Each
 * variant fully describes what the caller should do without leaving
 * any decision-making in the class. The class's switch on `verdict.action`
 * is pure dispatch — no further logic.
 */
export type RelayDispatchVerdict =
  | { action: 'drop-schema-invalid'; type: unknown; issues: z.ZodIssue[] }
  | { action: 'drop-nonce-mismatch'; requestId: string }
  | { action: 'drop-wrong-session'; targetSession: string }
  | { action: 'drop-unhandled-command'; commandAction: string }
  | { action: 'drop-unhandled-type'; type: string }
  | { action: 'chat'; sessionId: string; content: string }
  | { action: 'permission-response'; requestId: string; approved: boolean }
  | { action: 'cancel'; sessionId: string }
  | { action: 'end-session'; sessionId: string }
  | { action: 'ping' };

/**
 * Verify-nonce callback. Implemented by `StyrbyApi.verifyAndConsumePermissionNonce`
 * in production; tests pass a stub that returns deterministic true/false.
 */
export type NonceVerifier = (requestId: string, nonce: string) => boolean;

/**
 * Classify an incoming relay message into a verdict.
 *
 * Decision sequence (matches the in-class flow exactly):
 *   1. zod schema validation (rejects oversized strings, wrong types, etc.)
 *   2. For permission_response: nonce verification (closes RCE chain)
 *   3. For chat: session-ID match check
 *   4. Otherwise: dispatch by message type / command action
 *
 * @param sessionId - The session we're handling a message for
 * @param rawMessage - The unverified payload from the relay (may be malformed)
 * @param verifyNonce - Callback that verifies + CONSUMES the permission nonce.
 *                      Side-effecting by design (consumes the nonce on success
 *                      so it can't be replayed). The classifier doesn't care
 *                      about the side effect; it just needs the boolean answer.
 * @returns A verdict describing what action the caller should take.
 */
export function classifyRelayMessage(
  sessionId: string,
  rawMessage: unknown,
  verifyNonce: NonceVerifier,
): RelayDispatchVerdict {
  // ─── Step 1: Schema validation ───────────────────────────────────────
  // SECURITY (CLI-008): without this, a malicious peer could blast oversized
  // strings (memory DoS), inject unexpected types, or send fields the dispatch
  // logic doesn't expect. The schema enforces hard length caps and shape.
  const parsed = RelayMessageSchema.safeParse(rawMessage);
  if (!parsed.success) {
    return {
      action: 'drop-schema-invalid',
      type: (rawMessage as { type?: unknown })?.type,
      issues: parsed.error.issues.slice(0, 5),
    };
  }
  const message: RelayMessage = parsed.data;

  // ─── Step 2: Nonce verification on permission_response ───────────────
  // SECURITY (CLI-009): closes the compromised-account-key -> approve-all
  // -> RCE chain. An attacker with only the API key (no live mobile session)
  // cannot fabricate a valid nonce, so the response is rejected.
  if (message.type === 'permission_response') {
    const { request_id, request_nonce } = message.payload;
    const ok = verifyNonce(request_id, request_nonce);
    if (!ok) {
      return { action: 'drop-nonce-mismatch', requestId: request_id };
    }
    // Nonce verified — consumed by verifyNonce side effect. Continue to
    // dispatch.
  }

  // ─── Step 3: Type-specific routing ───────────────────────────────────
  switch (message.type) {
    case 'chat': {
      const { content, session_id } = message.payload;

      // Cross-session protection: silently drop chat messages targeted at
      // a different session. Caller logs at debug.
      if (session_id && session_id !== sessionId) {
        return { action: 'drop-wrong-session', targetSession: session_id };
      }

      return { action: 'chat', sessionId, content };
    }

    case 'permission_response': {
      // Already nonce-verified above. Forward to agent.
      const { request_id, approved } = message.payload;
      return { action: 'permission-response', requestId: request_id, approved };
    }

    case 'command': {
      const { action: commandAction, params } = message.payload;

      // Cross-session protection (audit 2026-06-09 HIGH fix #9): a
      // cancel/interrupt/end_session command carries the targeted session in
      // params.session_id. Without this guard the command fanned out to EVERY
      // active session on the daemon — cancelling session A also killed session
      // B. Mirror the chat path (step 3 above): if a session_id is present and
      // doesn't match the session we're handling, drop it. Commands with no
      // session_id keep the legacy behavior of targeting the current session
      // (backward compatibility for single-session clients).
      const targetSession = params?.['session_id'];
      if (typeof targetSession === 'string' && targetSession !== sessionId) {
        return { action: 'drop-wrong-session', targetSession };
      }

      switch (commandAction) {
        case 'cancel':
        case 'interrupt':
          return { action: 'cancel', sessionId };
        case 'end_session':
          return { action: 'end-session', sessionId };
        case 'ping':
          return { action: 'ping' };
        default:
          return { action: 'drop-unhandled-command', commandAction };
      }
    }

    default:
      // Other relay types (ack, cost_update, etc.) — known-but-unhandled.
      return { action: 'drop-unhandled-type', type: message.type };
  }
}
