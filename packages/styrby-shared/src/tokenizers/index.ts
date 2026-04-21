/**
 * Tokenizer abstraction (Phase 1.1).
 *
 * WHY THIS EXISTS
 * ---------------
 * Aider, Amp, Crush, and Goose all relied on the `words * 1.3` heuristic to
 * estimate token counts. That estimate drifts up to ±35% from real Anthropic
 * / OpenAI server-side counts, which makes the cost dashboard, budget
 * alerts, and weekly summaries misleading. SOC2 CC4.1 (monitoring) requires
 * that the metrics we surface to the user reasonably match the source of
 * truth — a 35% drift fails that bar.
 *
 * This module provides a single tokenizer interface that:
 * - Picks the right tokenizer per model family (anthropic / openai / other)
 * - Falls back to the legacy heuristic when a tokenizer package is not yet
 *   installed in the runtime environment (the heuristic is still bounded
 *   and the caller code is uniform either way)
 * - Documents the nightly refresh pattern for the model→pricing table from
 *   `tokencost`
 *
 * The actual tokenizer packages (`gpt-tokenizer`, `@anthropic-ai/tokenizer`,
 * `tokencost`) are loaded lazily via dynamic import so a missing optional
 * dependency does NOT break the build for environments that ship without
 * the native add-ons (e.g., the mobile bundle).
 *
 * ## DO NOT IMPORT FROM MOBILE
 *
 * `@anthropic-ai/tokenizer` transitively pulls in `tiktoken` (Rust/WASM)
 * which catastrophically breaks the Metro bundler. The string-toString
 * trick (`'@anthropic-ai/tokenizer'.toString()`) hides the import from
 * Metro static analysis, but only as long as no consumer file in
 * `packages/styrby-mobile/` reaches this module. Mobile must stick to
 * `heuristicTokens()` (sync, no deps) for any token estimation.
 *
 * If a future feature requires exact counts on mobile, add a server-side
 * proxy endpoint (`/api/tokenize`) that mobile calls instead of importing
 * this module directly.
 *
 * @module tokenizers
 */

/**
 * Family of model the text targets. Determines which tokenizer is used.
 *
 * - `'anthropic'` — Claude family (Sonnet, Opus, Haiku). Uses
 *   `@anthropic-ai/tokenizer` when available; heuristic otherwise.
 * - `'openai'` — GPT family (gpt-4o, gpt-4, gpt-3.5). Uses `gpt-tokenizer`
 *   (cl100k_base / o200k_base) when available.
 * - `'unknown'` — Used by Aider/Amp/Crush/Goose when the underlying model
 *   is not declared. Uses the heuristic.
 */
export type ModelFamily = 'anthropic' | 'openai' | 'unknown';

/**
 * Result of a token count operation.
 */
export interface TokenCountResult {
  /** Number of tokens in the input text. */
  tokens: number;
  /** Which tokenizer was actually used (helpful for diagnostics). */
  source: 'anthropic-tokenizer' | 'gpt-tokenizer' | 'heuristic';
  /** True if the count is exact; false if it is an estimate. */
  exact: boolean;
}

/**
 * Maps a model identifier string to its tokenizer family.
 *
 * @param model - Model name as reported by the agent (e.g., 'claude-sonnet-4',
 *   'gpt-4o', 'meta-llama/Llama-3.1-70B').
 * @returns The model family.
 */
export function detectModelFamily(model: string | undefined | null): ModelFamily {
  if (!model) return 'unknown';
  const m = model.toLowerCase();
  if (m.includes('claude') || m.startsWith('anthropic/')) return 'anthropic';
  // WHY the o-family regex: OpenAI's reasoning models follow `o<digit>` then
  // either end-of-string or a `-suffix` (o1, o1-mini, o1-preview, o3, o3-mini,
  // o4-mini, …). The boundary requirement (`(-|$)`) prevents false positives
  // for any future non-OpenAI model whose name happens to start with `o<digit>`
  // followed by other characters (e.g., a hypothetical `o2x` or `o9z`).
  // The previous `startsWith('o1')` check missed o3+ silently; this version
  // covers them while staying conservative against unrelated names.
  if (m.startsWith('gpt-') || /^o\d+(-|$)/.test(m) || m.startsWith('openai/')) return 'openai';
  return 'unknown';
}

/**
 * Heuristic token estimate — `words * 1.3`. Used as a fallback when the
 * real tokenizer package is not loaded. WHY 1.3: matches the prior
 * per-factory heuristic and is within ±35% of real counts on English
 * prose (well-documented in OpenAI cookbook and Anthropic SDK docs).
 *
 * @param text - The input text.
 * @returns Estimated token count.
 */
export function heuristicTokens(text: string): number {
  if (!text) return 0;
  const wordCount = text.split(/\s+/).filter((w) => w.length > 0).length;
  return Math.ceil(wordCount * 1.3);
}

// ---------------------------------------------------------------------------
// Lazy-loaded tokenizer cache
// ---------------------------------------------------------------------------

interface AnthropicTokenizerModule {
  countTokens(text: string): number | Promise<number>;
}
interface GptTokenizerModule {
  encode(text: string): number[];
}

let anthropicTokenizer: AnthropicTokenizerModule | null = null;
let anthropicTokenizerLoaded = false;
let gptTokenizer: GptTokenizerModule | null = null;
let gptTokenizerLoaded = false;

/**
 * Load `@anthropic-ai/tokenizer` if installed. Returns null when the
 * package is absent so callers can fall back gracefully.
 *
 * @returns The loaded tokenizer module, or `null` if the optional dep
 *          is not installed in the current runtime (cached after first call).
 */
async function loadAnthropicTokenizer(): Promise<AnthropicTokenizerModule | null> {
  if (anthropicTokenizerLoaded) return anthropicTokenizer;
  anthropicTokenizerLoaded = true;
  try {
    // WHY dynamic import: optional dependency. The mobile bundle does not
    // ship the tokenizer wasm; we must not crash there.
    const mod = (await import(/* @vite-ignore */ '@anthropic-ai/tokenizer'.toString())) as {
      countTokens?: AnthropicTokenizerModule['countTokens'];
      default?: AnthropicTokenizerModule;
    };
    anthropicTokenizer = mod.default ?? (mod as unknown as AnthropicTokenizerModule);
  } catch {
    anthropicTokenizer = null;
  }
  return anthropicTokenizer;
}

/**
 * Load `gpt-tokenizer` if installed. Returns null when the package is absent.
 *
 * @returns The loaded tokenizer module, or `null` if the optional dep
 *          is not installed in the current runtime (cached after first call).
 */
async function loadGptTokenizer(): Promise<GptTokenizerModule | null> {
  if (gptTokenizerLoaded) return gptTokenizer;
  gptTokenizerLoaded = true;
  try {
    gptTokenizer = (await import(/* @vite-ignore */ 'gpt-tokenizer'.toString())) as GptTokenizerModule;
  } catch {
    gptTokenizer = null;
  }
  return gptTokenizer;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Count tokens in `text` for the given model. Picks the right tokenizer
 * based on the model family; falls back to the heuristic when the real
 * tokenizer package is not available in the current runtime.
 *
 * Async because `@anthropic-ai/tokenizer` may need to load WASM. Callers
 * that only need a synchronous estimate should use {@link heuristicTokens}
 * directly.
 *
 * @param text - The input text.
 * @param model - Model identifier (used to pick a tokenizer).
 * @returns Token count plus diagnostic metadata.
 *
 * @example
 * ```ts
 * const { tokens, exact } = await countTokens('Hello, world!', 'claude-sonnet-4');
 * if (!exact) {
 *   logger.debug('Token count is heuristic — install @anthropic-ai/tokenizer for exact counts');
 * }
 * ```
 */
export async function countTokens(
  text: string,
  model?: string | null,
): Promise<TokenCountResult> {
  const family = detectModelFamily(model);
  if (family === 'anthropic') {
    const tk = await loadAnthropicTokenizer();
    if (tk) {
      const tokens = await tk.countTokens(text);
      return { tokens, source: 'anthropic-tokenizer', exact: true };
    }
  } else if (family === 'openai') {
    const tk = await loadGptTokenizer();
    if (tk) {
      const tokens = tk.encode(text).length;
      return { tokens, source: 'gpt-tokenizer', exact: true };
    }
  }
  return { tokens: heuristicTokens(text), source: 'heuristic', exact: false };
}

/**
 * Synchronous token estimate. Always uses the heuristic. Use for hot-path
 * accumulators (per-line streaming) where a Promise round-trip would add
 * latency; reconcile to exact counts on session close via {@link countTokens}.
 *
 * @param text - The input text.
 * @returns Estimated token count.
 */
export function estimateTokensSync(text: string): number {
  return heuristicTokens(text);
}

// ---------------------------------------------------------------------------
// tokencost — pricing refresh pattern
// ---------------------------------------------------------------------------

/**
 * Documented refresh pattern for the model → pricing table maintained by
 * the [tokencost](https://github.com/AgentOps-AI/tokencost) project.
 *
 * Phase 1.1 ships the abstraction; the actual nightly cron is wired in a
 * follow-up. The expected operation is:
 *
 * 1. Cron at 03:00 America/Chicago (ALL Styrby crons use Central Time)
 *    fetches `https://raw.githubusercontent.com/AgentOps-AI/tokencost/.../prices.json`.
 * 2. Validate with the Zod schema in `pricing/static-pricing.ts`.
 * 3. Write to the `model_pricing` table in Supabase with a `version` and
 *    `fetched_at` column so we can roll back a bad publish.
 * 4. The cost calculator reads from Supabase first, falls back to the
 *    bundled `static-pricing.ts` table on cache miss.
 *
 * This comment is intentional documentation — search for "REFRESH_TOKENCOST"
 * to find this contract from the cron implementation site.
 */
export const REFRESH_TOKENCOST_NOTE = 'See tokenizers/index.ts for the documented refresh pattern.';
