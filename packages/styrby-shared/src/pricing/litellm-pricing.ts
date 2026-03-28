/**
 * LiteLLM Dynamic Pricing Module
 *
 * Fetches live AI model pricing from LiteLLM's canonical pricing dataset and
 * provides a uniform `getModelPrice()` interface for all cost calculation code.
 *
 * ## Fallback Chain
 *
 * ```
 * 1. In-memory cache (1-hour TTL)   — fastest, zero network cost
 *        ↓ miss / expired
 * 2. LiteLLM GitHub raw JSON        — primary live source
 *        ↓ network error / timeout
 * 3. Disk cache (temp dir)          — survives process restarts
 *        ↓ disk miss / corrupt
 * 4. OpenRouter pricing endpoint    — secondary live source
 *        ↓ also fails
 * 5. Static fallback map (built-in) — always works, may be stale
 * ```
 *
 * WHY: AI providers change pricing without warning. A static map means users
 * silently see wrong cost data. Dynamic fetching keeps pricing accurate while
 * the multi-tier fallback ensures the app never crashes due to a network blip.
 *
 * @module pricing/litellm-pricing
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ============================================================================
// Types
// ============================================================================

/**
 * Normalized price for a single model.
 *
 * All values are USD per 1,000 tokens (not per million — kept small for
 * readability in cost calculations).
 */
export interface ModelPrice {
  /** Cost per 1,000 input tokens in USD */
  inputPer1k: number;
  /** Cost per 1,000 output tokens in USD */
  outputPer1k: number;
  /**
   * Cost per 1,000 cache-read tokens in USD.
   * Only populated for models that support prompt caching (Anthropic Claude).
   */
  cachePer1k?: number;
  /**
   * Cost per 1,000 cache-write tokens in USD.
   * Only populated for models that support prompt caching (Anthropic Claude).
   */
  cacheWritePer1k?: number;
}

/**
 * A single entry from LiteLLM's raw pricing JSON.
 *
 * Field names match LiteLLM's canonical dataset exactly so the response can
 * be cast directly without transformation.
 */
interface LiteLLMEntry {
  /** Cost per single input token in USD */
  input_cost_per_token?: number;
  /** Cost per single output token in USD */
  output_cost_per_token?: number;
  /** Cost per single cache-read input token in USD */
  cache_read_input_token_cost?: number;
  /** Cost per single cache-write input token in USD */
  cache_creation_input_token_cost?: number;
  /** Provider identifier (e.g. "anthropic", "openai", "gemini") */
  litellm_provider?: string;
}

/**
 * Shape of the full LiteLLM pricing JSON file.
 */
type LiteLLMPricingData = Record<string, LiteLLMEntry>;

/**
 * Internal cache entry with TTL tracking.
 */
interface CacheEntry {
  /** Parsed pricing map ready for lookup */
  data: Map<string, ModelPrice>;
  /** Unix timestamp (ms) when this entry expires */
  expiresAt: number;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Primary pricing source — LiteLLM's canonical pricing dataset on GitHub.
 * WHY: LiteLLM tracks ~200+ models and is updated frequently by the community.
 */
const LITELLM_PRICING_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

/**
 * Secondary pricing source used when LiteLLM is unreachable.
 * WHY: OpenRouter maintains its own pricing dataset that covers most major
 * providers. Different infrastructure from LiteLLM means outages rarely
 * overlap.
 */
const OPENROUTER_PRICING_URL = 'https://openrouter.ai/api/v1/models';

/**
 * In-memory cache TTL: 1 hour.
 * WHY: Pricing changes infrequently (days or weeks). One hour is fresh enough
 * to catch changes quickly while keeping network calls negligible.
 */
const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Disk cache file location — written to the OS temp directory so it survives
 * process restarts without touching the project directory.
 */
const DISK_CACHE_PATH = path.join(os.tmpdir(), 'styrby-model-pricing-cache.json');

/**
 * Maximum age for the disk cache before it is considered stale (24 hours).
 * WHY: Even if the network is down for hours, we prefer slightly-stale live
 * data over the hardcoded static fallback — unless it is more than a day old.
 */
const DISK_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Fetch timeout in milliseconds.
 * WHY: The pricing JSON is ~2MB. 10 seconds is generous for slow connections
 * but tight enough that a hung fetch doesn't block the CLI.
 */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Maximum allowed response size in bytes (5 MB).
 *
 * SECURITY: If the LiteLLM GitHub repo is compromised, an attacker could serve
 * an arbitrarily large JSON payload causing memory exhaustion (OOM). This cap
 * ensures we never allocate more than 5 MB for pricing data. The legitimate
 * file is ~2 MB as of 2026-03.
 */
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024;

/**
 * Maximum number of entries to process from pricing data.
 *
 * SECURITY: Even within the size limit, a crafted JSON with millions of tiny
 * entries could cause CPU exhaustion during parsing. Cap at 10,000 entries
 * which is well above the current ~2,000 legitimate models.
 */
const MAX_PRICING_ENTRIES = 10_000;

// ============================================================================
// Static Fallback Pricing
// ============================================================================

/**
 * Static pricing map used when ALL dynamic sources fail.
 *
 * Prices are USD per 1M tokens (per LiteLLM convention), then converted to
 * per-1k at lookup time via `toModelPrice()`.
 *
 * WHY this exists: The CLI may be run fully offline. Without a static fallback
 * costs would show as $0 or cause crashes. Stale pricing is better than no
 * pricing for budget alerts.
 *
 * Last verified: 2026-03-27 against Anthropic, OpenAI, and Google pricing pages.
 */
const STATIC_PRICING_PER_TOKEN: Record<
  string,
  {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  }
> = {
  // ── Anthropic ──────────────────────────────────────────────────────────────
  // Prices in USD per single token (to match LiteLLM raw format for uniform conversion)
  'claude-sonnet-4-20250514': {
    input: 3e-6,
    output: 15e-6,
    cacheRead: 0.3e-6,
    cacheWrite: 3.75e-6,
  },
  'claude-sonnet-4-6': {
    input: 3e-6,
    output: 15e-6,
    cacheRead: 0.3e-6,
    cacheWrite: 3.75e-6,
  },
  'claude-opus-4-20250514': {
    input: 15e-6,
    output: 75e-6,
    cacheRead: 1.5e-6,
    cacheWrite: 18.75e-6,
  },
  'claude-opus-4-5-20251101': {
    input: 5e-6,
    output: 25e-6,
    cacheRead: 0.5e-6,
    cacheWrite: 6.25e-6,
  },
  'claude-opus-4-5': {
    input: 5e-6,
    output: 25e-6,
    cacheRead: 0.5e-6,
    cacheWrite: 6.25e-6,
  },
  'claude-3-5-sonnet-20241022': {
    input: 3e-6,
    output: 15e-6,
    cacheRead: 0.3e-6,
    cacheWrite: 3.75e-6,
  },
  'claude-3-5-haiku-20241022': {
    input: 0.8e-6,
    output: 4e-6,
    cacheRead: 0.08e-6,
    cacheWrite: 1e-6,
  },
  'claude-3-opus-20240229': {
    input: 15e-6,
    output: 75e-6,
    cacheRead: 1.5e-6,
    cacheWrite: 18.75e-6,
  },
  'claude-haiku-4-5': {
    input: 1e-6,
    output: 5e-6,
    cacheRead: 0.1e-6,
    cacheWrite: 1.25e-6,
  },

  // ── OpenAI ─────────────────────────────────────────────────────────────────
  'gpt-4o': { input: 2.5e-6, output: 10e-6 },
  'gpt-4o-mini': { input: 0.15e-6, output: 0.6e-6 },
  'gpt-4-turbo': { input: 10e-6, output: 30e-6 },
  'o1': { input: 15e-6, output: 60e-6 },
  'o1-mini': { input: 1.1e-6, output: 4.4e-6 },
  'o3': { input: 2e-6, output: 8e-6 },
  'o3-mini': { input: 1.1e-6, output: 4.4e-6 },

  // ── Google ─────────────────────────────────────────────────────────────────
  'gemini/gemini-2.0-flash': { input: 0.1e-6, output: 0.4e-6 },
  'gemini/gemini-2.5-flash': { input: 0.3e-6, output: 2.5e-6 },
  'gemini/gemini-1.5-pro': { input: 1.25e-6, output: 5e-6 },
  'gemini/gemini-1.5-flash': { input: 0.075e-6, output: 0.3e-6 },
};

// ============================================================================
// Module State (in-memory cache)
// ============================================================================

/** Singleton in-memory cache. Null until first successful fetch. */
let _memCache: CacheEntry | null = null;

// ============================================================================
// Core Helpers
// ============================================================================

/**
 * Converts a per-token price (LiteLLM raw format) to per-1k tokens.
 *
 * WHY: LiteLLM stores prices per individual token (e.g., 3e-6 for $3/1M).
 * Our `ModelPrice` interface uses per-1k to keep numbers human-readable in
 * cost calculation code.
 *
 * @param perToken - Price per single token in USD, or undefined
 * @returns Price per 1,000 tokens in USD, or undefined if input is absent
 */
function toPerThousand(perToken: number | undefined): number | undefined {
  if (perToken === undefined || perToken === null) return undefined;
  return perToken * 1000;
}

/**
 * Builds a `ModelPrice` from a LiteLLM entry.
 *
 * Returns null if the entry lacks the minimum required cost fields.
 *
 * @param entry - Raw LiteLLM pricing entry
 * @returns Normalized `ModelPrice` or null
 */
function toModelPrice(entry: LiteLLMEntry): ModelPrice | null {
  const inputPer1k = toPerThousand(entry.input_cost_per_token);
  const outputPer1k = toPerThousand(entry.output_cost_per_token);

  if (inputPer1k === undefined || outputPer1k === undefined) return null;

  const price: ModelPrice = { inputPer1k, outputPer1k };

  const cachePer1k = toPerThousand(entry.cache_read_input_token_cost);
  if (cachePer1k !== undefined) price.cachePer1k = cachePer1k;

  const cacheWritePer1k = toPerThousand(entry.cache_creation_input_token_cost);
  if (cacheWritePer1k !== undefined) price.cacheWritePer1k = cacheWritePer1k;

  return price;
}

/**
 * Builds the static fallback pricing map in the same `ModelPrice` shape.
 *
 * WHY: We keep the static data in per-token format (matching LiteLLM) so
 * there is one conversion path (`toModelPrice`) for both live and static data.
 *
 * @returns Map from model identifier to `ModelPrice`
 */
function buildStaticFallbackMap(): Map<string, ModelPrice> {
  const map = new Map<string, ModelPrice>();

  for (const [modelId, pricing] of Object.entries(STATIC_PRICING_PER_TOKEN)) {
    const price: ModelPrice = {
      inputPer1k: pricing.input * 1000,
      outputPer1k: pricing.output * 1000,
    };

    if (pricing.cacheRead !== undefined) {
      price.cachePer1k = pricing.cacheRead * 1000;
    }
    if (pricing.cacheWrite !== undefined) {
      price.cacheWritePer1k = pricing.cacheWrite * 1000;
    }

    map.set(modelId, price);
  }

  return map;
}

// ============================================================================
// Network Fetchers
// ============================================================================

/**
 * Fetches pricing data from LiteLLM's GitHub raw URL.
 *
 * Applies a configurable timeout and returns null on any failure so callers
 * can try the next source in the fallback chain without crashing.
 *
 * @returns Parsed LiteLLM pricing data, or null on failure
 */
async function fetchLiteLLMPricing(): Promise<LiteLLMPricingData | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(LITELLM_PRICING_URL, {
      signal: controller.signal,
      headers: {
        // WHY: Some CDNs block requests without a User-Agent header
        'User-Agent': 'styrby-cli/pricing-module',
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return null;
    }

    // SECURITY: Check Content-Length before reading the body to prevent OOM.
    // If the upstream repo is compromised, the response could be arbitrarily large.
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
      return null;
    }

    // SECURITY: Read body as text with size enforcement, then parse.
    // response.json() provides no size limit; reading as text lets us check.
    const text = await response.text();
    if (text.length > MAX_RESPONSE_SIZE) {
      return null;
    }

    const data = JSON.parse(text) as LiteLLMPricingData;

    // SECURITY: Validate that the response is actually an object (not an array or primitive).
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return null;
    }

    return data;
  } catch {
    // Network error, timeout, or JSON parse failure — return null to trigger fallback
    return null;
  }
}

/**
 * Fetches pricing from OpenRouter as a secondary source.
 *
 * OpenRouter's `/api/v1/models` endpoint returns an array of model objects
 * with `pricing.prompt` and `pricing.completion` fields (per-token, USD).
 *
 * WHY: Different infrastructure from LiteLLM means outages rarely overlap.
 * This expands coverage especially for OpenRouter-specific models.
 *
 * @returns Parsed pricing map, or null on failure
 */
async function fetchOpenRouterPricing(): Promise<Map<string, ModelPrice> | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(OPENROUTER_PRICING_URL, {
      signal: controller.signal,
      headers: { 'User-Agent': 'styrby-cli/pricing-module' },
    });

    clearTimeout(timeoutId);

    if (!response.ok) return null;

    // SECURITY: Enforce response size limit to prevent OOM from compromised endpoint.
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
      return null;
    }

    const text = await response.text();
    if (text.length > MAX_RESPONSE_SIZE) {
      return null;
    }

    // OpenRouter response: { data: Array<{ id: string, pricing: { prompt: string, completion: string } }> }
    const json = JSON.parse(text) as {
      data: Array<{
        id: string;
        pricing?: { prompt?: string; completion?: string };
      }>;
    };

    if (!Array.isArray(json.data)) return null;

    const map = new Map<string, ModelPrice>();

    for (const model of json.data) {
      const promptCost = parseFloat(model.pricing?.prompt ?? '');
      const completionCost = parseFloat(model.pricing?.completion ?? '');

      if (!isFinite(promptCost) || !isFinite(completionCost)) continue;
      if (promptCost <= 0 || completionCost <= 0) continue;
      // SEC-CACHE-001: Reject absurdly high prices that could be injected by a
      // compromised OpenRouter response to trigger false budget alerts.
      // $1/token (= $1B/1M tokens) is far above any real model pricing.
      if (promptCost > 1 || completionCost > 1) continue;

      map.set(model.id, {
        inputPer1k: promptCost * 1000,
        outputPer1k: completionCost * 1000,
      });
    }

    return map.size > 0 ? map : null;
  } catch {
    return null;
  }
}

// ============================================================================
// Disk Cache
// ============================================================================

/**
 * Loads pricing data from the disk cache.
 *
 * Returns null if the file doesn't exist, is corrupt, or is older than
 * `DISK_CACHE_MAX_AGE_MS`.
 *
 * WHY: Disk cache survives process restarts. If the CLI is started offline,
 * pricing from the last successful network fetch (up to 24h ago) is used
 * instead of falling all the way back to static data.
 *
 * @returns Pricing map from disk, or null
 */
function loadDiskCache(): Map<string, ModelPrice> | null {
  try {
    if (!fs.existsSync(DISK_CACHE_PATH)) return null;

    const stat = fs.statSync(DISK_CACHE_PATH);
    const ageMs = Date.now() - stat.mtimeMs;

    if (ageMs > DISK_CACHE_MAX_AGE_MS) return null;

    // SECURITY: Verify the cache file is owned by the current user to prevent
    // cache poisoning attacks where another user/process plants a malicious file
    // in the shared tmpdir. On Windows, uid is always 0 so we skip this check.
    if (process.platform !== 'win32' && stat.uid !== process.getuid?.()) {
      return null;
    }

    // SECURITY: Reject cache files larger than 5 MB (consistent with fetch limit)
    if (stat.size > MAX_RESPONSE_SIZE) return null;

    const raw = fs.readFileSync(DISK_CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, ModelPrice>;

    if (typeof parsed !== 'object' || parsed === null) return null;

    // SEC-CACHE-001: Validate that loaded entries have sane numeric values.
    // WHY: The disk cache file lives in os.tmpdir() which is world-writable.
    // A local attacker could plant a malicious cache file with zero prices to
    // suppress budget alerts, or with absurdly high prices to trigger false
    // alerts and disrupt the user's workflow. We validate that every entry has
    // positive, finite prices within a plausible range ($0 < price < $1/token).
    const map = new Map<string, ModelPrice>();
    for (const [key, value] of Object.entries(parsed)) {
      if (
        typeof value.inputPer1k !== 'number' ||
        typeof value.outputPer1k !== 'number' ||
        !isFinite(value.inputPer1k) ||
        !isFinite(value.outputPer1k) ||
        value.inputPer1k <= 0 ||
        value.outputPer1k <= 0 ||
        value.inputPer1k > 1000 || // $1M/1M tokens — no model costs this much
        value.outputPer1k > 1000
      ) {
        // Skip this entry — it has been tampered with or is corrupt
        continue;
      }
      map.set(key, value);
    }

    // If more than half the entries were invalid, reject the entire cache
    const totalEntries = Object.keys(parsed).length;
    if (totalEntries > 0 && map.size < totalEntries / 2) {
      return null;
    }

    return map.size > 0 ? map : null;
  } catch {
    return null;
  }
}

/**
 * Persists a pricing map to disk for future process restarts.
 *
 * Silently swallows errors — disk writes are best-effort; the in-memory
 * cache is the primary store.
 *
 * @param priceMap - The pricing map to persist
 */
function saveDiskCache(priceMap: Map<string, ModelPrice>): void {
  try {
    const obj: Record<string, ModelPrice> = {};
    for (const [k, v] of priceMap) obj[k] = v;
    // SEC-CACHE-002: Write with mode 0o600 (owner read/write only) to prevent
    // local privilege escalation via cache poisoning on shared systems.
    fs.writeFileSync(DISK_CACHE_PATH, JSON.stringify(obj), { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Non-critical — disk writes may fail in read-only environments
  }
}

// ============================================================================
// Model Name Normalization
// ============================================================================

/**
 * Normalization candidates for a given model identifier.
 *
 * LiteLLM keys can take several forms for the same underlying model. For
 * example, Claude Sonnet 4 appears as:
 * - "claude-sonnet-4-20250514"       (direct Anthropic API key)
 * - "anthropic/claude-sonnet-4-20250514" (OpenRouter-style)
 * - "claude-4-sonnet-20250514"       (alias used in some tooling)
 *
 * We generate multiple candidates and return the first one that has a hit
 * in the pricing map.
 *
 * @param model - Raw model identifier from the agent's token usage event
 * @returns Ordered list of lookup keys to try against the pricing map
 */
export function getModelNameCandidates(model: string): string[] {
  const candidates: string[] = [model];

  const lower = model.toLowerCase();

  // Strip provider prefixes: "anthropic/..." → try without prefix
  // WHY: Claude Code reports bare model IDs ("claude-sonnet-4-20250514") but
  // some callers may pass in OpenRouter-style "anthropic/claude-..." IDs.
  if (lower.includes('/')) {
    const withoutPrefix = model.slice(model.indexOf('/') + 1);
    candidates.push(withoutPrefix);
  }

  // For Claude models: try "claude-4-sonnet-..." ↔ "claude-sonnet-4-..." aliases
  // WHY: Anthropic briefly used both orderings during the claude-4 release cycle.
  if (lower.startsWith('claude-')) {
    // "claude-sonnet-4-..." → "claude-4-sonnet-..."
    const sonnetSwap = model.replace(/^claude-(sonnet|haiku|opus)-(\d)/, 'claude-$2-$1');
    if (sonnetSwap !== model) candidates.push(sonnetSwap);

    // "claude-4-sonnet-..." → "claude-sonnet-4-..."
    const reverseSwap = model.replace(/^claude-(\d)-(sonnet|haiku|opus)/, 'claude-$2-$1');
    if (reverseSwap !== model) candidates.push(reverseSwap);

    // Add "anthropic/" prefix variant for completeness
    candidates.push(`anthropic/${model}`);
  }

  // For Gemini models: try with and without "gemini/" prefix
  // WHY: Gemini CLI and LiteLLM use "gemini/gemini-2.0-flash" but raw model
  // names from some integrations omit the prefix.
  if (lower.startsWith('gemini-')) {
    candidates.push(`gemini/${model}`);
  } else if (lower.startsWith('gemini/gemini-')) {
    candidates.push(model.replace(/^gemini\//, ''));
  }

  // For OpenAI o-series: "o1-preview" was the old name, "o1" is the current key
  if (lower === 'o1-preview') candidates.push('o1');
  if (lower === 'o1-mini') candidates.push('o3-mini'); // pricing-equivalent fallback

  return candidates;
}

// ============================================================================
// Cache Population
// ============================================================================

/**
 * Parses a raw LiteLLM pricing JSON into a normalized `Map<string, ModelPrice>`.
 *
 * Only retains entries where `litellm_provider` is one of the three providers
 * Styrby supports AND both input and output costs are present and positive.
 *
 * WHY: The LiteLLM JSON contains ~2,000+ entries including image generation,
 * embeddings, re-ranking, speech models, etc. Filtering to known providers
 * keeps the in-memory map small and avoids false hits for non-chat models.
 *
 * @param raw - Raw parsed LiteLLM JSON
 * @returns Filtered, normalized pricing map
 */
function parseLiteLLMData(raw: LiteLLMPricingData): Map<string, ModelPrice> {
  const map = new Map<string, ModelPrice>();

  const supportedProviders = new Set(['anthropic', 'openai', 'gemini', 'google']);

  // SECURITY: Cap the number of entries we process to prevent CPU exhaustion
  // from a crafted response with millions of entries.
  const entries = Object.entries(raw);
  const cappedEntries = entries.slice(0, MAX_PRICING_ENTRIES);

  for (const [modelId, entry] of cappedEntries) {
    // SECURITY: Validate that each entry is an object, not a primitive or array.
    // A compromised response could include non-object entries to cause type confusion.
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      continue;
    }

    // Skip non-chat providers (bedrock, azure, vertex, etc.) to avoid key collisions
    // WHY: We want the canonical model IDs for direct API use, not cloud-provider
    // wrapped variants. Bedrock keys like "anthropic.claude-sonnet-4-..." would
    // match normalization candidates incorrectly.
    if (!entry.litellm_provider || !supportedProviders.has(entry.litellm_provider)) {
      continue;
    }

    const price = toModelPrice(entry);
    if (!price) continue;

    // Reject zero-price entries (image generation models etc. have 0 output cost)
    if (price.inputPer1k <= 0 || price.outputPer1k <= 0) continue;

    // SECURITY: Reject absurdly high prices that could be injected by a compromised
    // LiteLLM response to trigger false budget alerts or cause integer overflow in
    // cost calculations. $1/token (= $1B/1M tokens) is far above any real pricing.
    // Per-1k cap: $1000 per 1k tokens (equivalent check).
    if (price.inputPer1k > 1000 || price.outputPer1k > 1000) continue;

    map.set(modelId, price);
  }

  return map;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Refreshes the in-memory pricing cache by fetching from live sources.
 *
 * Follows the fallback chain: LiteLLM → OpenRouter → disk cache → static.
 * The result is stored in the module-level `_memCache` and also written to
 * the disk cache for future process restarts.
 *
 * Callers do not need to call this directly — `getModelPrice()` calls it
 * automatically on cache miss.
 *
 * @returns The populated pricing map (never throws)
 */
export async function refreshPricingCache(): Promise<Map<string, ModelPrice>> {
  // 1. Try LiteLLM
  const litellmData = await fetchLiteLLMPricing();
  if (litellmData) {
    const priceMap = parseLiteLLMData(litellmData);
    if (priceMap.size > 0) {
      _memCache = { data: priceMap, expiresAt: Date.now() + CACHE_TTL_MS };
      saveDiskCache(priceMap);
      return priceMap;
    }
  }

  // 2. Try OpenRouter
  const openRouterMap = await fetchOpenRouterPricing();
  if (openRouterMap && openRouterMap.size > 0) {
    _memCache = { data: openRouterMap, expiresAt: Date.now() + CACHE_TTL_MS };
    saveDiskCache(openRouterMap);
    return openRouterMap;
  }

  // 3. Try disk cache
  const diskMap = loadDiskCache();
  if (diskMap && diskMap.size > 0) {
    // Don't update the disk cache from disk — only network fetches do that.
    // Still populate the in-memory cache (shorter TTL to retry network sooner).
    _memCache = { data: diskMap, expiresAt: Date.now() + CACHE_TTL_MS / 4 };
    return diskMap;
  }

  // 4. Static fallback
  const staticMap = buildStaticFallbackMap();
  // WHY: Don't cache static data with a long TTL — we want to retry live
  // sources again soon in case network connectivity returns.
  _memCache = { data: staticMap, expiresAt: Date.now() + 5 * 60 * 1000 };
  return staticMap;
}

/**
 * Returns the pricing for a given model identifier.
 *
 * Handles model name normalization automatically — callers can pass bare
 * model IDs from any agent's token usage event without pre-processing.
 *
 * When no price is found after all normalization attempts, returns a
 * conservative claude-sonnet-class default rather than throwing.
 *
 * @param model - The model identifier as reported by the agent (e.g., 'claude-sonnet-4-20250514')
 * @returns Pricing for the model (never throws, never returns undefined)
 *
 * @example
 * const price = await getModelPrice('claude-sonnet-4-20250514');
 * // { inputPer1k: 0.003, outputPer1k: 0.015, cachePer1k: 0.0003, cacheWritePer1k: 0.00375 }
 *
 * const price2 = await getModelPrice('gpt-4o');
 * // { inputPer1k: 0.0025, outputPer1k: 0.01 }
 */
export async function getModelPrice(model: string): Promise<ModelPrice> {
  // Ensure cache is populated and fresh
  let priceMap: Map<string, ModelPrice>;

  if (_memCache && Date.now() < _memCache.expiresAt) {
    priceMap = _memCache.data;
  } else {
    priceMap = await refreshPricingCache();
  }

  // Try all normalization candidates in order
  const candidates = getModelNameCandidates(model);

  for (const candidate of candidates) {
    const price = priceMap.get(candidate);
    if (price) return price;
  }

  // WHY: Return a conservative default rather than throwing. Cost calculations
  // that encounter an unknown model should still produce a plausible estimate
  // rather than crashing. The Sonnet-class rate is a reasonable middle-ground
  // for unknown models — not free, but not Opus-expensive.
  return {
    inputPer1k: 0.003,  // $3 / 1M — Sonnet-class input rate
    outputPer1k: 0.015, // $15 / 1M — Sonnet-class output rate
  };
}

/**
 * Synchronous version of `getModelPrice` for callers that cannot await.
 *
 * Uses the in-memory cache if populated; falls back to the static map
 * if the cache is empty (before the first async `getModelPrice()` call).
 *
 * WHY: Some synchronous code paths (e.g., `calculateCost` in jsonl-parser.ts)
 * cannot easily be made async. This provides a best-effort synchronous path
 * while the async version ensures the cache stays warm.
 *
 * @param model - The model identifier
 * @returns Pricing for the model (never throws, never returns undefined)
 *
 * @example
 * const price = getModelPriceSync('claude-sonnet-4-20250514');
 * // { inputPer1k: 0.003, outputPer1k: 0.015, ... }
 */
export function getModelPriceSync(model: string): ModelPrice {
  const priceMap =
    _memCache && Date.now() < _memCache.expiresAt
      ? _memCache.data
      : buildStaticFallbackMap();

  const candidates = getModelNameCandidates(model);

  for (const candidate of candidates) {
    const price = priceMap.get(candidate);
    if (price) return price;
  }

  return {
    inputPer1k: 0.003,
    outputPer1k: 0.015,
  };
}

/**
 * Clears the in-memory cache, forcing the next `getModelPrice()` call to
 * re-fetch from the network.
 *
 * Primarily used in tests to isolate cache state between test cases.
 */
export function clearPricingCache(): void {
  _memCache = null;
}

/**
 * Returns true if the in-memory cache is currently populated and not expired.
 *
 * Useful for diagnostics and tests.
 *
 * @returns True if the cache is warm and fresh
 */
export function isPricingCacheWarm(): boolean {
  return _memCache !== null && Date.now() < _memCache.expiresAt;
}
