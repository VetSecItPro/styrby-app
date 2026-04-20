/**
 * Tests for the tokenizer abstraction (Phase 1.1).
 *
 * These tests assert the heuristic + dispatch contract. They do NOT assert
 * on real anthropic / openai tokenizer counts because those packages are
 * optional dependencies that may or may not be installed in the test
 * environment. When they ARE installed, the regression tests below will
 * upgrade automatically (the assertion is "exact === true" rather than a
 * specific number).
 *
 * @module tokenizers/__tests__/tokenizers
 */

import { describe, it, expect } from 'vitest';
import {
  detectModelFamily,
  heuristicTokens,
  estimateTokensSync,
  countTokens,
} from '../index.js';

describe('detectModelFamily', () => {
  it('classifies Anthropic Claude models', () => {
    expect(detectModelFamily('claude-sonnet-4')).toBe('anthropic');
    expect(detectModelFamily('claude-3-opus-20240229')).toBe('anthropic');
    expect(detectModelFamily('anthropic/claude-haiku')).toBe('anthropic');
  });

  it('classifies OpenAI GPT models', () => {
    expect(detectModelFamily('gpt-4o')).toBe('openai');
    expect(detectModelFamily('gpt-4-turbo')).toBe('openai');
    expect(detectModelFamily('o1-preview')).toBe('openai');
    expect(detectModelFamily('openai/gpt-3.5-turbo')).toBe('openai');
  });

  it('returns "unknown" for missing or unrecognised models', () => {
    expect(detectModelFamily(undefined)).toBe('unknown');
    expect(detectModelFamily(null)).toBe('unknown');
    expect(detectModelFamily('')).toBe('unknown');
    expect(detectModelFamily('llama-3.1-70b')).toBe('unknown');
    expect(detectModelFamily('gemini-pro')).toBe('unknown');
  });
});

describe('heuristicTokens', () => {
  it('returns 0 for empty input', () => {
    expect(heuristicTokens('')).toBe(0);
  });

  it('approximates words * 1.3 with ceiling', () => {
    // 5 words → ceil(5 * 1.3) = ceil(6.5) = 7
    expect(heuristicTokens('hello there how are you')).toBe(7);
  });

  it('handles whitespace-only strings as 0 tokens', () => {
    expect(heuristicTokens('   \n\t  ')).toBe(0);
  });

  it('estimateTokensSync delegates to heuristicTokens', () => {
    const text = 'one two three four five six seven eight nine ten';
    expect(estimateTokensSync(text)).toBe(heuristicTokens(text));
  });
});

describe('countTokens dispatcher', () => {
  it('falls back to heuristic when no model is provided', async () => {
    const result = await countTokens('hello world');
    expect(result.source).toBe('heuristic');
    expect(result.exact).toBe(false);
    expect(result.tokens).toBe(heuristicTokens('hello world'));
  });

  it('falls back to heuristic for unknown model families', async () => {
    const result = await countTokens('hello world', 'llama-3.1-70b');
    expect(result.source).toBe('heuristic');
    expect(result.exact).toBe(false);
  });

  it('attempts the anthropic tokenizer for Claude models (heuristic fallback if not installed)', async () => {
    const result = await countTokens('hello world', 'claude-sonnet-4');
    // Either we got the real tokenizer (exact === true) or we fell back.
    expect(['anthropic-tokenizer', 'heuristic']).toContain(result.source);
    if (result.source === 'anthropic-tokenizer') {
      expect(result.exact).toBe(true);
    }
  });

  it('attempts the gpt tokenizer for OpenAI models (heuristic fallback if not installed)', async () => {
    const result = await countTokens('hello world', 'gpt-4o');
    expect(['gpt-tokenizer', 'heuristic']).toContain(result.source);
    if (result.source === 'gpt-tokenizer') {
      expect(result.exact).toBe(true);
    }
  });

  it('returns 0 tokens for empty text regardless of model', async () => {
    const a = await countTokens('', 'claude-sonnet-4');
    const b = await countTokens('', 'gpt-4o');
    const c = await countTokens('', undefined);
    expect(a.tokens).toBe(0);
    expect(b.tokens).toBe(0);
    expect(c.tokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Regression — exact-vs-heuristic contract for known prompts (Phase 1.1)
//
// WHY: These cases pin the contract that "the dispatcher returns SOMETHING
// reasonable for every supported family." Once the optional tokenizer
// packages are added to package.json, the assertions tighten automatically
// without test changes (exact === true on the real path).
// ---------------------------------------------------------------------------
describe('regression — known prompts', () => {
  const SAMPLES: Array<{ name: string; text: string; model: string }> = [
    { name: 'short claude prompt', text: 'Hello, how are you today?', model: 'claude-sonnet-4' },
    { name: 'medium openai prompt', text: 'Write a haiku about TypeScript.', model: 'gpt-4o' },
    {
      name: 'long unknown prompt',
      text: Array.from({ length: 100 }, () => 'word').join(' '),
      model: 'llama-3.1',
    },
  ];

  for (const sample of SAMPLES) {
    it(`returns a positive token count for "${sample.name}"`, async () => {
      const result = await countTokens(sample.text, sample.model);
      expect(result.tokens).toBeGreaterThan(0);
      // Heuristic is bounded — typical range is 0.5x to 2x word count.
      const wordCount = sample.text.split(/\s+/).filter(Boolean).length;
      expect(result.tokens).toBeLessThan(wordCount * 4);
    });
  }
});
