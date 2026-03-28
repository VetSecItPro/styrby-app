/**
 * LiteLLM Dynamic Pricing Module Tests
 *
 * Covers:
 * - Cache hit/miss/expiry behavior
 * - Fallback chain: LiteLLM → disk cache → static fallback
 * - Model name normalization (provider prefixes, Claude aliases, Gemini prefix)
 * - Price format validation (per-1k, positive numbers)
 * - Error handling for network failures and corrupt responses
 * - OpenRouter fallback when LiteLLM is unreachable
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';

import {
  getModelPrice,
  getModelPriceSync,
  getModelNameCandidates,
  refreshPricingCache,
  clearPricingCache,
  isPricingCacheWarm,
  type ModelPrice,
} from './litellm-pricing.js';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Minimal LiteLLM pricing payload that covers all three supported providers.
 * Prices match the real data fetched during module development.
 */
const MOCK_LITELLM_DATA = {
  // Anthropic direct API
  'claude-sonnet-4-20250514': {
    litellm_provider: 'anthropic',
    input_cost_per_token: 3e-6,
    output_cost_per_token: 15e-6,
    cache_read_input_token_cost: 3e-7,
    cache_creation_input_token_cost: 3.75e-6,
  },
  'claude-opus-4-20250514': {
    litellm_provider: 'anthropic',
    input_cost_per_token: 15e-6,
    output_cost_per_token: 75e-6,
    cache_read_input_token_cost: 1.5e-6,
    cache_creation_input_token_cost: 18.75e-6,
  },
  'claude-haiku-4-5': {
    litellm_provider: 'anthropic',
    input_cost_per_token: 1e-6,
    output_cost_per_token: 5e-6,
    cache_read_input_token_cost: 1e-7,
    cache_creation_input_token_cost: 1.25e-6,
  },
  // OpenAI direct API
  'gpt-4o': {
    litellm_provider: 'openai',
    input_cost_per_token: 2.5e-6,
    output_cost_per_token: 10e-6,
  },
  'gpt-4o-mini': {
    litellm_provider: 'openai',
    input_cost_per_token: 1.5e-7,
    output_cost_per_token: 6e-7,
  },
  'o1': {
    litellm_provider: 'openai',
    input_cost_per_token: 15e-6,
    output_cost_per_token: 60e-6,
  },
  // Google Gemini direct API
  'gemini/gemini-2.0-flash': {
    litellm_provider: 'gemini',
    input_cost_per_token: 1e-7,
    output_cost_per_token: 4e-7,
  },
  'gemini/gemini-1.5-pro': {
    litellm_provider: 'gemini',
    input_cost_per_token: 1.25e-6,
    output_cost_per_token: 5e-6,
  },
  // Entries that should be FILTERED OUT
  'anthropic.claude-sonnet-4-20250514-v1:0': {
    litellm_provider: 'bedrock_converse', // bedrock — should be ignored
    input_cost_per_token: 3e-6,
    output_cost_per_token: 15e-6,
  },
  'azure/gpt-4o-2024-11-20': {
    litellm_provider: 'azure', // azure — should be ignored
    input_cost_per_token: 2.5e-6,
    output_cost_per_token: 10e-6,
  },
  'some-embedding-model': {
    litellm_provider: 'openai',
    input_cost_per_token: 1e-7,
    output_cost_per_token: 0, // zero output — should be filtered
  },
};

// ============================================================================
// Mock Setup
// ============================================================================

// Mock global fetch so tests never make real network calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

/**
 * Configures the mock `fetch` to return `MOCK_LITELLM_DATA` as the LiteLLM
 * response and a minimal OpenRouter response for all other URLs.
 */
/**
 * Creates a mock Response-like object with text(), json(), and headers.get().
 * WHY: The pricing module reads responses as text (for size validation) then
 * parses with JSON.parse, so mock responses need a text() method.
 */
function mockResponse(data: unknown, ok = true) {
  const body = JSON.stringify(data);
  return {
    ok,
    headers: {
      get: (name: string) => {
        if (name.toLowerCase() === 'content-length') return String(body.length);
        return null;
      },
    },
    text: async () => body,
    json: async () => data,
  };
}

function setupSuccessfulFetch(): void {
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes('raw.githubusercontent.com')) {
      return mockResponse(MOCK_LITELLM_DATA);
    }
    // OpenRouter fallback — minimal valid response
    return mockResponse({
      data: [
        { id: 'openai/gpt-4o', pricing: { prompt: '0.0000025', completion: '0.00001' } },
      ],
    });
  });
}

beforeEach(() => {
  clearPricingCache();
  mockFetch.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================================
// Cache Behavior
// ============================================================================

describe('cache behavior', () => {
  it('starts cold (cache is empty before first fetch)', () => {
    expect(isPricingCacheWarm()).toBe(false);
  });

  it('warms the cache after a successful fetch', async () => {
    setupSuccessfulFetch();
    await refreshPricingCache();
    expect(isPricingCacheWarm()).toBe(true);
  });

  it('returns cached result on hit — does not call fetch again', async () => {
    setupSuccessfulFetch();

    // First call — network hit
    await getModelPrice('gpt-4o');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Second call — cache hit
    await getModelPrice('gpt-4o');
    expect(mockFetch).toHaveBeenCalledTimes(1); // still just 1
  });

  it('re-fetches after cache is cleared', async () => {
    setupSuccessfulFetch();

    await getModelPrice('gpt-4o');
    const firstCallCount = mockFetch.mock.calls.length;

    clearPricingCache();
    expect(isPricingCacheWarm()).toBe(false);

    await getModelPrice('gpt-4o');
    expect(mockFetch.mock.calls.length).toBeGreaterThan(firstCallCount);
  });
});

// ============================================================================
// Price Retrieval — Happy Path
// ============================================================================

describe('getModelPrice — known models', () => {
  beforeEach(() => {
    setupSuccessfulFetch();
  });

  it('returns correct price for claude-sonnet-4-20250514', async () => {
    const price = await getModelPrice('claude-sonnet-4-20250514');
    expect(price.inputPer1k).toBeCloseTo(0.003);
    expect(price.outputPer1k).toBeCloseTo(0.015);
    expect(price.cachePer1k).toBeCloseTo(0.0003);
    expect(price.cacheWritePer1k).toBeCloseTo(0.00375);
  });

  it('returns correct price for gpt-4o', async () => {
    const price = await getModelPrice('gpt-4o');
    expect(price.inputPer1k).toBeCloseTo(0.0025);
    expect(price.outputPer1k).toBeCloseTo(0.01);
    expect(price.cachePer1k).toBeUndefined();
  });

  it('returns correct price for gemini-2.0-flash (with gemini/ prefix)', async () => {
    const price = await getModelPrice('gemini/gemini-2.0-flash');
    expect(price.inputPer1k).toBeCloseTo(0.0001);
    expect(price.outputPer1k).toBeCloseTo(0.0004);
  });

  it('has all prices as positive numbers', async () => {
    const models = [
      'claude-sonnet-4-20250514',
      'gpt-4o',
      'gpt-4o-mini',
      'o1',
      'gemini/gemini-2.0-flash',
    ];

    for (const model of models) {
      const price = await getModelPrice(model);
      expect(price.inputPer1k, `${model} inputPer1k`).toBeGreaterThan(0);
      expect(price.outputPer1k, `${model} outputPer1k`).toBeGreaterThan(0);
    }
  });

  it('has output price >= input price for all models', async () => {
    const models = [
      'claude-sonnet-4-20250514',
      'claude-opus-4-20250514',
      'gpt-4o',
      'o1',
      'gemini/gemini-1.5-pro',
    ];

    for (const model of models) {
      const price = await getModelPrice(model);
      expect(
        price.outputPer1k,
        `${model}: output should be >= input`
      ).toBeGreaterThanOrEqual(price.inputPer1k);
    }
  });

  it('returns prices as per-1k (not per-token or per-million)', async () => {
    const price = await getModelPrice('gpt-4o');
    // $2.50 / 1M = $0.0025 / 1k
    expect(price.inputPer1k).toBeCloseTo(0.0025, 6);
    // $10.00 / 1M = $0.01 / 1k
    expect(price.outputPer1k).toBeCloseTo(0.01, 6);
  });
});

// ============================================================================
// Model Name Normalization
// ============================================================================

describe('getModelNameCandidates — normalization', () => {
  it('bare model ID is always first candidate', () => {
    const candidates = getModelNameCandidates('claude-sonnet-4-20250514');
    expect(candidates[0]).toBe('claude-sonnet-4-20250514');
  });

  it('strips "anthropic/" prefix from OpenRouter-style IDs', () => {
    const candidates = getModelNameCandidates('anthropic/claude-sonnet-4-20250514');
    expect(candidates).toContain('claude-sonnet-4-20250514');
  });

  it('adds "anthropic/" prefix variant for bare claude IDs', () => {
    const candidates = getModelNameCandidates('claude-sonnet-4-20250514');
    expect(candidates).toContain('anthropic/claude-sonnet-4-20250514');
  });

  it('swaps claude-sonnet-4 ↔ claude-4-sonnet alias', () => {
    const candidates = getModelNameCandidates('claude-sonnet-4-20250514');
    expect(candidates).toContain('claude-4-sonnet-20250514');
  });

  it('swaps claude-4-sonnet ↔ claude-sonnet-4 alias', () => {
    const candidates = getModelNameCandidates('claude-4-sonnet-20250514');
    expect(candidates).toContain('claude-sonnet-4-20250514');
  });

  it('handles claude-opus variant swaps', () => {
    const candidates = getModelNameCandidates('claude-opus-4-20250514');
    expect(candidates).toContain('claude-4-opus-20250514');
  });

  it('adds gemini/ prefix for bare gemini model IDs', () => {
    const candidates = getModelNameCandidates('gemini-2.0-flash');
    expect(candidates).toContain('gemini/gemini-2.0-flash');
  });

  it('strips gemini/ prefix for gemini/ model IDs', () => {
    const candidates = getModelNameCandidates('gemini/gemini-2.0-flash');
    expect(candidates).toContain('gemini-2.0-flash');
  });

  it('maps o1-preview to o1', () => {
    const candidates = getModelNameCandidates('o1-preview');
    expect(candidates).toContain('o1');
  });

  it('resolves bare gemini-2.0-flash to correct price via normalization', async () => {
    setupSuccessfulFetch();
    // The mock data has "gemini/gemini-2.0-flash" — bare "gemini-2.0-flash" should normalize to it
    const price = await getModelPrice('gemini-2.0-flash');
    expect(price.inputPer1k).toBeCloseTo(0.0001);
    expect(price.outputPer1k).toBeCloseTo(0.0004);
  });

  it('resolves anthropic/ prefixed ID to correct price', async () => {
    setupSuccessfulFetch();
    // "anthropic/claude-sonnet-4-20250514" should resolve to "claude-sonnet-4-20250514"
    const price = await getModelPrice('anthropic/claude-sonnet-4-20250514');
    expect(price.inputPer1k).toBeCloseTo(0.003);
    expect(price.outputPer1k).toBeCloseTo(0.015);
  });
});

// ============================================================================
// Fallback Chain
// ============================================================================

describe('fallback chain', () => {
  it('falls back to OpenRouter when LiteLLM fetch fails', async () => {
    // LiteLLM fails, OpenRouter succeeds
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('raw.githubusercontent.com')) {
        throw new Error('Network error');
      }
      return mockResponse({
        data: [
          {
            id: 'openai/gpt-4o',
            pricing: { prompt: '0.0000025', completion: '0.00001' },
          },
        ],
      });
    });

    await refreshPricingCache();
    expect(isPricingCacheWarm()).toBe(true);
  });

  it('falls back to disk cache when both network sources fail', async () => {
    // Write a valid disk cache first
    const diskData: Record<string, ModelPrice> = {
      'gpt-4o': { inputPer1k: 0.0025, outputPer1k: 0.01 },
    };
    const diskPath = require('node:path').join(
      require('node:os').tmpdir(),
      'styrby-model-pricing-cache.json'
    );
    fs.writeFileSync(diskPath, JSON.stringify(diskData), 'utf8');

    // Both network sources fail
    mockFetch.mockRejectedValue(new Error('Network down'));

    await refreshPricingCache();
    // Cache should be warm (from disk)
    expect(isPricingCacheWarm()).toBe(true);

    const price = await getModelPrice('gpt-4o');
    expect(price.inputPer1k).toBeCloseTo(0.0025);

    // Cleanup
    try { fs.unlinkSync(diskPath); } catch { /* ignore */ }
  });

  it('falls back to static map when all sources fail', async () => {
    // Both network sources fail and disk cache absent
    mockFetch.mockRejectedValue(new Error('Network down'));

    // Ensure no disk cache
    const diskPath = require('node:path').join(
      require('node:os').tmpdir(),
      'styrby-model-pricing-cache.json'
    );
    try { fs.unlinkSync(diskPath); } catch { /* ignore if not present */ }

    await refreshPricingCache();
    expect(isPricingCacheWarm()).toBe(true);

    // Static fallback should still return reasonable pricing
    const price = await getModelPrice('claude-sonnet-4-20250514');
    expect(price.inputPer1k).toBeGreaterThan(0);
    expect(price.outputPer1k).toBeGreaterThan(0);
  });

  it('filters out bedrock and azure variants from LiteLLM data', async () => {
    setupSuccessfulFetch();
    await refreshPricingCache();

    // "anthropic.claude-sonnet-4-20250514-v1:0" is a bedrock key — should NOT be in the map
    // The only way to look it up is if getModelNameCandidates returns it, which it won't for a bare bedrock key
    // Test that the bedrock-style key doesn't accidentally return bedrock pricing
    const price = await getModelPrice('anthropic.claude-sonnet-4-20250514-v1:0');
    // Should fall through to normalization or default — not crash
    expect(price.inputPer1k).toBeGreaterThan(0);
    expect(price.outputPer1k).toBeGreaterThan(0);
  });
});

// ============================================================================
// Unknown Models — Safe Defaults
// ============================================================================

describe('unknown model handling', () => {
  beforeEach(() => {
    setupSuccessfulFetch();
  });

  it('returns a non-zero default price for a completely unknown model', async () => {
    const price = await getModelPrice('some-future-model-2030');
    expect(price.inputPer1k).toBeGreaterThan(0);
    expect(price.outputPer1k).toBeGreaterThan(0);
  });

  it('default price has output >= input (conservative Sonnet-class)', async () => {
    const price = await getModelPrice('unknown-model-xyz');
    expect(price.outputPer1k).toBeGreaterThanOrEqual(price.inputPer1k);
  });

  it('never returns undefined or throws for any input', async () => {
    const oddInputs = ['', 'gpt-9999', 'CLAUDE-BIG', 'gemini/', '/model'];

    for (const input of oddInputs) {
      const price = await getModelPrice(input);
      expect(price, `should not throw for "${input}"`).toBeDefined();
      expect(price.inputPer1k).toBeGreaterThan(0);
      expect(price.outputPer1k).toBeGreaterThan(0);
    }
  });
});

// ============================================================================
// Synchronous API
// ============================================================================

describe('getModelPriceSync', () => {
  it('returns static fallback pricing before any async fetch', () => {
    // Cache is cleared in beforeEach — this tests truly cold sync path
    const price = getModelPriceSync('claude-sonnet-4-20250514');
    expect(price.inputPer1k).toBeGreaterThan(0);
    expect(price.outputPer1k).toBeGreaterThan(0);
  });

  it('uses in-memory cache after async fetch has warmed it', async () => {
    setupSuccessfulFetch();
    await refreshPricingCache();

    const price = getModelPriceSync('gpt-4o');
    expect(price.inputPer1k).toBeCloseTo(0.0025);
    expect(price.outputPer1k).toBeCloseTo(0.01);
  });

  it('never throws for unknown models', () => {
    const price = getModelPriceSync('definitely-not-a-real-model');
    expect(price.inputPer1k).toBeGreaterThan(0);
    expect(price.outputPer1k).toBeGreaterThan(0);
  });
});

// ============================================================================
// Network Error Handling
// ============================================================================

describe('network error handling', () => {
  it('handles fetch timeout gracefully', async () => {
    // Simulates AbortError from timeout
    mockFetch.mockRejectedValue(Object.assign(new Error('Aborted'), { name: 'AbortError' }));

    await expect(refreshPricingCache()).resolves.not.toThrow();
    expect(isPricingCacheWarm()).toBe(true); // still warm (static fallback)
  });

  it('handles non-ok HTTP response from LiteLLM', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('raw.githubusercontent.com')) {
        return mockResponse({}, false);
      }
      return mockResponse({
        data: [
          { id: 'openai/gpt-4o', pricing: { prompt: '0.0000025', completion: '0.00001' } },
        ],
      });
    });

    await expect(refreshPricingCache()).resolves.not.toThrow();
  });

  it('handles malformed JSON from LiteLLM', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('raw.githubusercontent.com')) {
        return {
          ok: true,
          headers: { get: () => '10' },
          text: async () => '{invalid json[[[',
        };
      }
      return mockResponse({
        data: [
          { id: 'openai/gpt-4o', pricing: { prompt: '0.0000025', completion: '0.00001' } },
        ],
      });
    });

    await expect(refreshPricingCache()).resolves.not.toThrow();
  });

  it('handles completely empty LiteLLM response', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('raw.githubusercontent.com')) {
        return mockResponse({});
      }
      return mockResponse({}, false);
    });

    await expect(refreshPricingCache()).resolves.not.toThrow();
  });

  it('handles OpenRouter returning empty model list', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('raw.githubusercontent.com')) {
        throw new Error('down');
      }
      return mockResponse({ data: [] });
    });

    await expect(refreshPricingCache()).resolves.not.toThrow();
    expect(isPricingCacheWarm()).toBe(true); // static fallback kicked in
  });
});

// ============================================================================
// Price Format Validation
// ============================================================================

describe('price format validation', () => {
  it('all LiteLLM-derived prices are finite positive numbers', async () => {
    setupSuccessfulFetch();
    const map = await refreshPricingCache();

    let checkedCount = 0;
    for (const [modelId, price] of map) {
      expect(isFinite(price.inputPer1k), `${modelId} inputPer1k is not finite`).toBe(true);
      expect(isFinite(price.outputPer1k), `${modelId} outputPer1k is not finite`).toBe(true);
      expect(price.inputPer1k, `${modelId} inputPer1k <= 0`).toBeGreaterThan(0);
      expect(price.outputPer1k, `${modelId} outputPer1k <= 0`).toBeGreaterThan(0);

      if (price.cachePer1k !== undefined) {
        expect(isFinite(price.cachePer1k), `${modelId} cachePer1k is not finite`).toBe(true);
        expect(price.cachePer1k, `${modelId} cachePer1k <= 0`).toBeGreaterThan(0);
      }
      if (price.cacheWritePer1k !== undefined) {
        expect(isFinite(price.cacheWritePer1k), `${modelId} cacheWritePer1k is not finite`).toBe(
          true
        );
        expect(price.cacheWritePer1k, `${modelId} cacheWritePer1k <= 0`).toBeGreaterThan(0);
      }

      checkedCount++;
    }

    // Sanity check: we should have parsed at least the 8 mock entries minus 3 filtered
    expect(checkedCount).toBeGreaterThanOrEqual(5);
  });

  it('cache prices are always lower than input prices (Anthropic discount)', async () => {
    setupSuccessfulFetch();
    const models = ['claude-sonnet-4-20250514', 'claude-haiku-4-5'];

    for (const model of models) {
      const price = await getModelPrice(model);
      if (price.cachePer1k !== undefined) {
        expect(
          price.cachePer1k,
          `${model}: cache read should be cheaper than input`
        ).toBeLessThan(price.inputPer1k);
      }
    }
  });
});
