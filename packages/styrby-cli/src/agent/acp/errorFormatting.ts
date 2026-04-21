/**
 * Error formatting helpers for ACP backend.
 *
 * WHY: Errors thrown by the ACP SDK and JSON-RPC layer come in many shapes
 * (Error instances, plain objects with `code`/`message`, raw strings). The
 * mobile UI needs a stable string representation so users see useful detail
 * rather than `[object Object]`. Centralizing the extraction keeps that
 * normalization logic out of `sendPrompt` and unit-testable in isolation.
 */

/**
 * Extract a stable error-detail string from an unknown caught value.
 *
 * Priority:
 * 1. {@link Error} instances → `error.message`
 * 2. Objects with a `code` field → JSON of `{ code, message }`
 * 3. Objects with a string `message` → that message
 * 4. Anything else → `String(error)`
 *
 * @param error - The caught value (typed `unknown` from a `catch` clause).
 * @returns A non-empty string suitable for surfacing to the UI / status emit.
 */
export function extractSendPromptErrorDetail(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'object' && error !== null) {
    const errObj = error as Record<string, unknown>;
    const fallbackMessage =
      (typeof errObj.message === 'string' ? errObj.message : undefined) ||
      String(error);
    if (errObj.code !== undefined) {
      return JSON.stringify({ code: errObj.code, message: fallbackMessage });
    }
    if (typeof errObj.message === 'string') {
      return errObj.message;
    }
    return String(error);
  }
  return String(error);
}
