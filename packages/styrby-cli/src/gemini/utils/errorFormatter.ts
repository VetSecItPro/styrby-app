/**
 * Gemini Error Formatter
 *
 * Pure helpers that normalize raw Gemini-CLI / ACP errors into user-facing
 * strings shown both in the terminal UI and forwarded to the mobile app.
 *
 * WHY split out: the original `runGemini.ts` had ~70 lines of nested
 * if/else conditions inside its main loop's catch block, which was both
 * untested AND impossible to test (it required throwing arbitrary errors
 * through a real Gemini subprocess). This module is fully pure and unit-
 * testable.
 *
 * Categories handled:
 *   - 404 / model-not-found
 *   - empty response / internal -32603
 *   - 429 rate limit (multiple shapes)
 *   - quota / capacity exhausted (with optional reset-time extraction)
 *   - authentication required (Workspace project setup)
 *   - empty error object (CLI not installed)
 *   - generic fallback
 */

/**
 * Categorized error kind for branching in callers (for analytics, retries,
 * UI styling, etc).
 */
export type GeminiErrorKind =
  | 'abort'
  | 'model-not-found'
  | 'empty-response'
  | 'rate-limit'
  | 'quota-exceeded'
  | 'auth-required'
  | 'cli-missing'
  | 'unknown';

export interface FormattedGeminiError {
  /** Human-readable message safe to surface in UI / push to mobile. */
  message: string;
  /** Stable category for branching/analytics. */
  kind: GeminiErrorKind;
}

/**
 * Extract a quota-reset suffix like " Quota resets in 3h20m35s." from any
 * Gemini error string that contains the phrase "reset after Xh Ym Zs".
 *
 * @param haystack - Combined error text (details + message + string repr)
 * @returns The suffix sentence (with leading space), or '' if no match.
 */
export function extractResetTimeSuffix(haystack: string): string {
  const resetTimeMatch = haystack.match(/reset after (\d+h)?(\d+m)?(\d+s)?/i);
  if (!resetTimeMatch) return '';
  const parts = resetTimeMatch.slice(1).filter(Boolean).join('');
  if (!parts) return '';
  return ` Quota resets in ${parts}.`;
}

/**
 * Classify and format an arbitrary error thrown by the Gemini backend during
 * `sendPrompt`/`waitForResponseComplete`.
 *
 * Behavior matches the pre-refactor inline logic in `runGemini.ts` exactly.
 *
 * @param error - The unknown thrown value (Error, JSON-RPC error object, etc).
 * @param ctx - Caller-supplied context for richer messages (currently the
 *   active model name for "model not found" errors).
 * @returns A formatted message + classification.
 */
export function formatGeminiError(
  error: unknown,
  ctx: { displayedModel?: string } = {}
): FormattedGeminiError {
  if (error instanceof Error && error.name === 'AbortError') {
    return { message: 'Aborted by user', kind: 'abort' };
  }

  if (typeof error === 'object' && error !== null) {
    const errObj = error as Record<string, any>;
    const errorDetails: string =
      errObj.data?.details || errObj.details || '';
    const errorCode = errObj.code || errObj.status || errObj.response?.status;
    const errorMessage: string =
      errObj.message || errObj.error?.message || '';
    const errorString = String(error);
    const haystack = errorDetails + errorMessage + errorString;

    // 404 / model not found
    if (
      errorCode === 404 ||
      errorDetails.includes('notFound') ||
      errorDetails.includes('404') ||
      errorMessage.includes('not found') ||
      errorMessage.includes('404')
    ) {
      const currentModel = ctx.displayedModel || 'gemini-2.5-pro';
      return {
        message: `Model "${currentModel}" not found. Available models: gemini-2.5-pro, gemini-2.5-flash, gemini-2.5-flash-lite`,
        kind: 'model-not-found',
      };
    }

    // Empty response / internal -32603 after retries exhausted
    if (
      errorCode === -32603 ||
      errorDetails.includes('empty response') ||
      errorDetails.includes('Model stream ended')
    ) {
      return {
        message:
          'Gemini API returned empty response after retries. This is a temporary issue - please try again.',
        kind: 'empty-response',
      };
    }

    // 429 / rate limit (multiple possible shapes)
    if (
      errorCode === 429 ||
      errorDetails.includes('429') ||
      errorMessage.includes('429') ||
      errorString.includes('429') ||
      errorDetails.includes('rateLimitExceeded') ||
      errorDetails.includes('RESOURCE_EXHAUSTED') ||
      errorMessage.includes('Rate limit exceeded') ||
      errorMessage.includes('Resource exhausted') ||
      errorString.includes('rateLimitExceeded') ||
      errorString.includes('RESOURCE_EXHAUSTED')
    ) {
      return {
        message:
          'Gemini API rate limit exceeded. Please wait a moment and try again. The API will retry automatically.',
        kind: 'rate-limit',
      };
    }

    // Quota / capacity exhausted
    if (
      errorDetails.includes('quota') ||
      errorMessage.includes('quota') ||
      errorString.includes('quota') ||
      errorDetails.includes('exhausted') ||
      errorDetails.includes('capacity')
    ) {
      const resetTimeMsg = extractResetTimeSuffix(haystack);
      return {
        message: `Gemini quota exceeded.${resetTimeMsg} Try using a different model (gemini-2.5-flash-lite) or wait for quota reset.`,
        kind: 'quota-exceeded',
      };
    }

    // Auth required (Workspace accounts need project ID)
    if (
      errorMessage.includes('Authentication required') ||
      errorDetails.includes('Authentication required') ||
      errorCode === -32000
    ) {
      return {
        message:
          `Authentication required. For Google Workspace accounts, you need to set a Google Cloud Project:\n` +
          `  happy gemini project set <your-project-id>\n` +
          `Or use a different Google account: happy connect gemini\n` +
          `Guide: https://goo.gle/gemini-cli-auth-docs#workspace-gca`,
        kind: 'auth-required',
      };
    }

    // Empty error object => CLI binary missing
    if (Object.keys(error).length === 0) {
      return {
        message:
          'Failed to start Gemini. Is "gemini" CLI installed? Run: npm install -g @google/gemini-cli',
        kind: 'cli-missing',
      };
    }

    // Generic object error - prefer details > message > raw .message
    if (errObj.message || errorMessage) {
      return {
        message: errorDetails || errorMessage || errObj.message,
        kind: 'unknown',
      };
    }
  }

  if (error instanceof Error) {
    return { message: error.message, kind: 'unknown' };
  }

  return { message: 'Process error occurred', kind: 'unknown' };
}

/**
 * Classify a `sendPrompt` error to decide whether the caller should retry,
 * surface a quota error immediately, or rethrow.
 *
 * Mirrors the original retry-loop classification in `runGemini.ts`.
 */
export interface PromptRetryClassification {
  /** True if this looks like a transient empty/internal error worth retrying. */
  isRetryable: boolean;
  /** True if quota is exhausted - must NOT retry; surface to user. */
  isQuotaError: boolean;
  /** Optional " Quota resets in ..." suffix when `isQuotaError`. */
  quotaResetSuffix: string;
  /** The raw details string we extracted (for logging). */
  details: string;
}

/**
 * Inspect an error thrown by `geminiBackend.sendPrompt` and classify it for
 * the in-loop retry handler.
 *
 * @param error - Unknown thrown value from sendPrompt / waitForResponseComplete.
 */
export function classifyPromptError(error: unknown): PromptRetryClassification {
  const errObj = (error as any) || {};
  const details: string =
    errObj?.data?.details || errObj?.details || errObj?.message || '';
  const errorCode = errObj?.code;

  const isQuotaError =
    details.includes('exhausted') ||
    details.includes('quota') ||
    details.includes('capacity');

  const isEmptyResponseError =
    details.includes('empty response') ||
    details.includes('Model stream ended');
  const isInternalError = errorCode === -32603;
  const isRetryable = !isQuotaError && (isEmptyResponseError || isInternalError);

  const quotaResetSuffix = isQuotaError ? extractResetTimeSuffix(details) : '';

  return { isRetryable, isQuotaError, quotaResetSuffix, details };
}
