/**
 * Codex permission bridge types.
 *
 * WHY this is a standalone, dependency-free module: {@link CodexMcpClient} and
 * the {@link AgentBackend}-based `CodexBackend` both need the tool-approval
 * contract, but the legacy `CodexPermissionHandler` (in `utils/permissionHandler`)
 * is bound to the pre-Supabase `ApiSessionClient` and is currently quarantined
 * from typechecking. Defining the contract here keeps the live codex path
 * decoupled from that stale plumbing — no seam, no broken import dragged into
 * the typechecked agent layer. The legacy handler still satisfies this
 * interface structurally, so the old `runCodex` path is unaffected.
 *
 * @module codex/permissionBridge
 */

/** Decision returned for a Codex tool-approval request. */
export type CodexPermissionDecision =
  | 'approved'
  | 'approved_for_session'
  | 'denied'
  | 'abort';

/** Result of resolving a Codex tool-approval request. */
export interface CodexPermissionResult {
  decision: CodexPermissionDecision;
  reason?: string;
}

/**
 * Anything that can resolve a Codex tool-approval request.
 *
 * `CodexMcpClient` calls `handleToolCall` when Codex elicits approval for a
 * command; the implementer returns the user's decision (possibly after a relay
 * round-trip to the mobile app).
 */
export interface CodexPermissionBridge {
  handleToolCall(
    toolCallId: string,
    toolName: string,
    input: unknown,
  ): Promise<CodexPermissionResult>;
}
