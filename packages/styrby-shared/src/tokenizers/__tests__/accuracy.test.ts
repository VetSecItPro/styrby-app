/**
 * Accuracy regression for the tokenizer abstraction (Task 1.1.5).
 *
 * Locks two properties:
 *
 * 1. **Exactness**: When the real tokenizer packages (`@anthropic-ai/tokenizer`,
 *    `gpt-tokenizer`) are installed in the runtime — which is true for the
 *    CLI and tests — `countTokens()` MUST return `exact: true` for
 *    Anthropic and OpenAI model families. Regression here means a future
 *    refactor accidentally degraded the path back to the heuristic.
 *
 * 2. **Stability**: A small set of fixed prompts produces a stable token
 *    count from each tokenizer. If those numbers shift, either the
 *    tokenizer package was upgraded (intentional) or the call shape changed
 *    (almost certainly a bug). The test failure forces reviewers to
 *    acknowledge the change before it lands.
 *
 * 3. **Heuristic bound**: The legacy `heuristicTokens()` is bounded — it must
 *    not drift more than ±50% from the exact count for typical English
 *    prompts. (The plan target is ±35%; we leave headroom for short prompts
 *    where the heuristic is noisier.)
 *
 * WHY no live API calls: The `@anthropic-ai/tokenizer` and `gpt-tokenizer`
 * packages ARE the same tokenizers the model servers use. Their output is
 * the ground truth by definition; comparing to a live API would test
 * network latency, not accuracy.
 *
 * @module tokenizers/__tests__/accuracy
 */

import { describe, it, expect } from 'vitest';
import { countTokens, heuristicTokens, detectModelFamily } from '../index.js';

// ============================================================================
// Fixed fixtures
// ============================================================================

/**
 * Each fixture pairs a prompt with the exact token counts produced by
 * the currently-pinned tokenizer libraries. If a future PR changes the
 * pinned tokenizer version, these expected values need to be regenerated
 * and the diff needs reviewer eyes.
 *
 * Counts captured against:
 *   - `@anthropic-ai/tokenizer@0.0.4`
 *   - `gpt-tokenizer@3.4.0`
 */
const FIXTURES = [
  {
    name: 'short greeting',
    prompt: 'Hello, world! This is a test.',
    expectedAnthropic: 9,
    expectedOpenai: 9,
  },
  {
    name: 'classic pangram',
    prompt: 'The quick brown fox jumps over the lazy dog.',
    expectedAnthropic: 10,
    expectedOpenai: 10,
  },
  {
    name: 'multi-sentence English paragraph',
    prompt:
      'Styrby brings your AI coding agent to your phone. Approve every dangerous command. Review every change. Sleep at night.',
    expectedAnthropic: 26,
    expectedOpenai: 26,
  },
  {
    name: 'code snippet (typescript)',
    prompt: 'export async function ship(pr: number) {\n  return await merge(pr);\n}',
    expectedAnthropic: 19,
    expectedOpenai: 16,
  },
];

// ============================================================================
// Exactness — countTokens() must report exact: true when real deps load
// ============================================================================

describe('countTokens — exactness contract', () => {
  it('returns exact=true for an Anthropic model when @anthropic-ai/tokenizer is installed', async () => {
    const result = await countTokens('Hello world', 'claude-sonnet-4');
    expect(result.source).toBe('anthropic-tokenizer');
    expect(result.exact).toBe(true);
    expect(result.tokens).toBeGreaterThan(0);
  });

  it('returns exact=true for an OpenAI model when gpt-tokenizer is installed', async () => {
    const result = await countTokens('Hello world', 'gpt-4');
    expect(result.source).toBe('gpt-tokenizer');
    expect(result.exact).toBe(true);
    expect(result.tokens).toBeGreaterThan(0);
  });

  it('returns exact=false (heuristic) for an unknown model family', async () => {
    const result = await countTokens('Hello world', 'mystery-model-9000');
    expect(result.source).toBe('heuristic');
    expect(result.exact).toBe(false);
    expect(result.tokens).toBeGreaterThan(0);
  });

  it('returns exact=false (heuristic) when no model is provided', async () => {
    const result = await countTokens('Hello world');
    expect(result.source).toBe('heuristic');
    expect(result.exact).toBe(false);
  });
});

// ============================================================================
// Stability — fixed prompts must produce known counts
// ============================================================================

describe('countTokens — fixture stability', () => {
  for (const fixture of FIXTURES) {
    it(`Anthropic count for "${fixture.name}" is stable`, async () => {
      const result = await countTokens(fixture.prompt, 'claude-sonnet-4');
      expect(result.exact).toBe(true);
      // WHY exact equality (not within tolerance): The pinned tokenizer
      // version produces deterministic counts. A change here means the
      // tokenizer package was upgraded — bump the expected value AND
      // call out the version bump in the PR description.
      expect(result.tokens).toBe(fixture.expectedAnthropic);
    });

    it(`OpenAI count for "${fixture.name}" is stable`, async () => {
      const result = await countTokens(fixture.prompt, 'gpt-4');
      expect(result.exact).toBe(true);
      expect(result.tokens).toBe(fixture.expectedOpenai);
    });
  }
});

// ============================================================================
// Heuristic bound — must not drift wildly from exact
// ============================================================================

describe('heuristicTokens — drift bound vs exact', () => {
  /**
   * The plan documents the heuristic's drift as up to ±35% from real
   * server counts. We assert ±50% to leave headroom for short prompts
   * where the heuristic is noisiest (a 5-token prompt off by 2 tokens
   * is already 40% drift, which is fine — short prompts matter little
   * in cost dollars).
   */
  const MAX_DRIFT = 0.5;

  for (const fixture of FIXTURES) {
    it(`heuristic for "${fixture.name}" stays within ±${MAX_DRIFT * 100}% of Anthropic exact`, () => {
      const heuristic = heuristicTokens(fixture.prompt);
      const exact = fixture.expectedAnthropic;
      const drift = Math.abs(heuristic - exact) / exact;
      expect(drift).toBeLessThanOrEqual(MAX_DRIFT);
    });
  }

  it('heuristic returns 0 for empty input (no crash, no negative)', () => {
    expect(heuristicTokens('')).toBe(0);
  });

  it('heuristic is deterministic — same input → same output', () => {
    const text = 'A reproducibility test.';
    expect(heuristicTokens(text)).toBe(heuristicTokens(text));
    expect(heuristicTokens(text)).toBe(heuristicTokens(text));
  });
});

// ============================================================================
// Model family detection — drives which tokenizer is picked
// ============================================================================

describe('detectModelFamily', () => {
  it.each([
    ['claude-sonnet-4', 'anthropic'],
    ['claude-opus-4-7', 'anthropic'],
    ['claude-haiku-4-5', 'anthropic'],
    ['anthropic/claude-3', 'anthropic'],
    ['gpt-4', 'openai'],
    ['gpt-4o', 'openai'],
    ['gpt-3.5-turbo', 'openai'],
    ['o1-preview', 'openai'],
    ['o3-mini', 'openai'],
    ['gemini-2.5-pro', 'unknown'],
    ['llama-3.3', 'unknown'],
    [null, 'unknown'],
    [undefined, 'unknown'],
    ['', 'unknown'],
  ])('detectModelFamily(%j) → %s', (input, expected) => {
    expect(detectModelFamily(input as string | null | undefined)).toBe(expected);
  });
});
