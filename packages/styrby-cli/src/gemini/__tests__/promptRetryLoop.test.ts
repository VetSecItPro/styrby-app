/**
 * Tests for `sendPromptWithRetry`.
 *
 * Mocks the AgentBackend interface so we can assert:
 *   - Success on first attempt
 *   - Retry on empty-response, succeed on second attempt
 *   - Quota errors NEVER retry, always invoke onQuotaError + rethrow
 *   - Non-retryable errors propagate immediately
 *   - Max retries respected
 *   - waitForResponseComplete is awaited when present
 *   - Sleep delay scales linearly with attempt number
 */
import { describe, it, expect, vi } from 'vitest';
import { sendPromptWithRetry } from '@/gemini/promptRetryLoop';
import type { AgentBackend } from '@/agent';

function makeBackend(impl: Partial<AgentBackend>): AgentBackend {
  // Cast — tests only need the methods we call.
  return impl as AgentBackend;
}

describe('sendPromptWithRetry', () => {
  it('succeeds on first attempt', async () => {
    const sendPrompt = vi.fn().mockResolvedValue(undefined);
    const onRetry = vi.fn();
    const onQuota = vi.fn();
    await sendPromptWithRetry({
      backend: makeBackend({ sendPrompt }),
      acpSessionId: 'sid',
      prompt: 'hi',
      onQuotaError: onQuota,
      onRetryAttempt: onRetry,
      sleep: async () => {},
    });
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
    expect(onQuota).not.toHaveBeenCalled();
  });

  it('awaits waitForResponseComplete when backend provides it', async () => {
    const sendPrompt = vi.fn().mockResolvedValue(undefined);
    const waitForResponseComplete = vi.fn().mockResolvedValue(undefined);
    await sendPromptWithRetry({
      backend: makeBackend({ sendPrompt, waitForResponseComplete }),
      acpSessionId: 'sid',
      prompt: 'hi',
      onQuotaError: () => {},
      onRetryAttempt: () => {},
      sleep: async () => {},
    });
    expect(waitForResponseComplete).toHaveBeenCalledWith(120000);
  });

  it('retries empty-response errors and eventually succeeds', async () => {
    const sendPrompt = vi.fn()
      .mockRejectedValueOnce({ data: { details: 'empty response' } })
      .mockResolvedValueOnce(undefined);
    const onRetry = vi.fn();
    await sendPromptWithRetry({
      backend: makeBackend({ sendPrompt }),
      acpSessionId: 'sid',
      prompt: 'hi',
      onQuotaError: () => {},
      onRetryAttempt: onRetry,
      sleep: async () => {},
    });
    expect(sendPrompt).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith({ attempt: 1, max: 3, details: 'empty response' });
  });

  it('retries -32603 errors', async () => {
    const sendPrompt = vi.fn()
      .mockRejectedValueOnce({ code: -32603, message: 'internal' })
      .mockResolvedValueOnce(undefined);
    await sendPromptWithRetry({
      backend: makeBackend({ sendPrompt }),
      acpSessionId: 'sid',
      prompt: 'hi',
      onQuotaError: () => {},
      onRetryAttempt: () => {},
      sleep: async () => {},
    });
    expect(sendPrompt).toHaveBeenCalledTimes(2);
  });

  it('quota errors invoke onQuotaError and rethrow without retry', async () => {
    const quotaErr = { data: { details: 'quota exhausted reset after 2h' } };
    const sendPrompt = vi.fn().mockRejectedValue(quotaErr);
    const onRetry = vi.fn();
    const onQuota = vi.fn();
    await expect(
      sendPromptWithRetry({
        backend: makeBackend({ sendPrompt }),
        acpSessionId: 'sid',
        prompt: 'hi',
        onQuotaError: onQuota,
        onRetryAttempt: onRetry,
        sleep: async () => {},
      }),
    ).rejects.toBe(quotaErr);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(onQuota).toHaveBeenCalledWith({ quotaResetSuffix: ' Quota resets in 2h.' });
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('non-retryable errors propagate immediately', async () => {
    const err = { message: 'something else' };
    const sendPrompt = vi.fn().mockRejectedValue(err);
    await expect(
      sendPromptWithRetry({
        backend: makeBackend({ sendPrompt }),
        acpSessionId: 'sid',
        prompt: 'hi',
        onQuotaError: () => {},
        onRetryAttempt: () => {},
        sleep: async () => {},
      }),
    ).rejects.toBe(err);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
  });

  it('respects maxRetries cap', async () => {
    const err = { data: { details: 'empty response' } };
    const sendPrompt = vi.fn().mockRejectedValue(err);
    await expect(
      sendPromptWithRetry({
        backend: makeBackend({ sendPrompt }),
        acpSessionId: 'sid',
        prompt: 'hi',
        maxRetries: 2,
        onQuotaError: () => {},
        onRetryAttempt: () => {},
        sleep: async () => {},
      }),
    ).rejects.toBe(err);
    expect(sendPrompt).toHaveBeenCalledTimes(2);
  });

  it('sleep delay scales linearly with attempt number', async () => {
    const sleeps: number[] = [];
    const sendPrompt = vi.fn()
      .mockRejectedValueOnce({ data: { details: 'empty response' } })
      .mockRejectedValueOnce({ data: { details: 'empty response' } })
      .mockResolvedValueOnce(undefined);
    await sendPromptWithRetry({
      backend: makeBackend({ sendPrompt }),
      acpSessionId: 'sid',
      prompt: 'hi',
      retryDelayMs: 1000,
      onQuotaError: () => {},
      onRetryAttempt: () => {},
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(sleeps).toEqual([1000, 2000]); // attempt 1 -> 1000, attempt 2 -> 2000
  });
});
