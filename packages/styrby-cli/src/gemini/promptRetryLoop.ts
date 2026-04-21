/**
 * Gemini sendPrompt Retry Loop
 *
 * The Gemini ACP backend occasionally returns transient errors that succeed
 * on a second/third attempt:
 *   - "empty response" / "Model stream ended"
 *   - JSON-RPC internal error -32603
 *
 * This module wraps `geminiBackend.sendPrompt` (+ optional
 * `waitForResponseComplete`) with the standard 3-attempt exponential delay
 * loop that `runGemini.ts` used inline.
 *
 * Quota errors are NEVER retried — the caller passes a `onQuotaError`
 * hook so it can surface the (formatted) message and decide what to do.
 */

import { logger } from '@/ui/logger';
import type { AgentBackend } from '@/agent';
import { classifyPromptError } from '@/gemini/utils/errorFormatter';

export interface SendWithRetryArgs {
  backend: AgentBackend;
  acpSessionId: string;
  prompt: string;
  /** Max total attempts including the initial one. Defaults to 3. */
  maxRetries?: number;
  /** Base delay between attempts in ms (linearly scaled by attempt). Defaults to 2000. */
  retryDelayMs?: number;
  /**
   * Called when classifier flags a quota error. Caller surfaces UI/mobile
   * messages then we re-throw so the outer catch handles cleanup as before.
   */
  onQuotaError: (info: { quotaResetSuffix: string }) => void;
  /**
   * Called between retry attempts so the caller can render a "retrying X/Y"
   * status banner.
   */
  onRetryAttempt: (info: { attempt: number; max: number; details: string }) => void;
  /** Optional sleep override for tests. Defaults to setTimeout-based promise. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Send a prompt with retry-on-transient-failure semantics.
 *
 * Mirrors the original loop in `runGemini.ts` exactly: only "empty response"
 * and -32603 errors are retried, quota errors are forwarded to the caller
 * and rethrown immediately, and we wait for `waitForResponseComplete` (when
 * available) inside each successful attempt before declaring success.
 *
 * @returns void on success. Throws the most-recent error on terminal failure.
 */
export async function sendPromptWithRetry(args: SendWithRetryArgs): Promise<void> {
  const {
    backend,
    acpSessionId,
    prompt,
    maxRetries = 3,
    retryDelayMs = 2000,
    onQuotaError,
    onRetryAttempt,
    sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  } = args;

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await backend.sendPrompt(acpSessionId, prompt);
      logger.debug('[gemini] Prompt sent successfully');

      if (backend.waitForResponseComplete) {
        // WHY: Wait for full streaming completion (chunks + final idle) so we
        // never declare task_complete before the model is actually done.
        await backend.waitForResponseComplete(120000);
        logger.debug('[gemini] Response complete');
      }

      return; // Success
    } catch (promptError) {
      lastError = promptError;
      const cls = classifyPromptError(promptError);

      if (cls.isQuotaError) {
        onQuotaError({ quotaResetSuffix: cls.quotaResetSuffix });
        throw promptError; // Don't retry quota errors
      }

      if (cls.isRetryable && attempt < maxRetries) {
        logger.debug(`[gemini] Retryable error on attempt ${attempt}/${maxRetries}: ${cls.details}`);
        onRetryAttempt({ attempt, max: maxRetries, details: cls.details });
        await sleep(retryDelayMs * attempt);
        continue;
      }

      // Not retryable or max retries reached
      throw promptError;
    }
  }

  // Should be unreachable — the loop either returns or throws.
  // Rethrow last error defensively.
  throw lastError ?? new Error('sendPromptWithRetry: exhausted without success or error');
}
