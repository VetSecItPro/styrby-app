/**
 * API key provider detection for cross-provider agents.
 *
 * WHY (audit 2026-05-05 HIGH fix): Multi-provider agents (goose, crush,
 * kilo, droid) historically injected the user's single API key under
 * EVERY provider's env-var name simultaneously — so an Anthropic key was
 * also sent as `OPENAI_API_KEY` and `GOOGLE_API_KEY`. The agent's startup
 * validation calls would then ship the Anthropic key to OpenAI's and
 * Google's servers, where it appeared in vendor logs as
 * `key=sk-ant-...rejected`. That's a real key-disclosure incident class.
 *
 * The fix: sniff the provider from the key prefix and inject only the
 * matching env var(s). Callers may also pass an explicit `provider` to
 * skip detection.
 *
 * @module utils/apiKeyProvider
 */

import { logger } from '@/ui/logger';

/**
 * Supported LLM provider identifiers.
 *
 * 'unknown' is returned when sniffing cannot match any prefix and no
 * explicit override was supplied — callers should treat that case as
 * "fall back to legacy fan-out with a deprecation warn".
 */
export type ApiKeyProvider = 'anthropic' | 'openai' | 'google' | 'mistral' | 'unknown';

/**
 * Detect the provider that owns an API key, based on its prefix.
 *
 * Heuristics (vendor-documented prefixes as of 2026-05):
 *   - Anthropic: `sk-ant-...`
 *   - Google AI Studio (Gemini): `AIza...`
 *   - Mistral: `r-...` (legacy) or full UUID-looking strings — too
 *     ambiguous to sniff confidently, so explicit-only.
 *   - OpenAI: `sk-...` (NOT `sk-ant-`), `sk-proj-`, `sess-`
 *   - Anything else: `unknown` — caller must decide.
 *
 * @param key - The API key to inspect.
 * @returns The detected provider, or 'unknown' if no prefix matched.
 *
 * @example
 * detectApiKeyProvider('sk-ant-abc123')   // → 'anthropic'
 * detectApiKeyProvider('AIzaSyAbcDef')    // → 'google'
 * detectApiKeyProvider('sk-proj-xyz')     // → 'openai'
 * detectApiKeyProvider('weird-key')       // → 'unknown'
 */
export function detectApiKeyProvider(key: string): ApiKeyProvider {
  if (!key) return 'unknown';

  if (key.startsWith('sk-ant-')) return 'anthropic';
  if (key.startsWith('AIza')) return 'google';

  // OpenAI: sk-, sk-proj-, sess-. Match AFTER the sk-ant- check.
  if (key.startsWith('sk-') || key.startsWith('sess-')) return 'openai';

  return 'unknown';
}

/**
 * Build the env-var subset that injects an API key for a single provider.
 *
 * Only the matching provider's env vars are populated. If `provider` is
 * `'unknown'` the caller decides whether to fan-out (legacy) or refuse.
 *
 * @param provider - Resolved or sniffed provider.
 * @param apiKey - The user's BYOK key.
 * @returns Env vars to merge into a `buildSafeEnv()` call.
 */
export function envVarsForProvider(
  provider: ApiKeyProvider,
  apiKey: string,
): Record<string, string> {
  switch (provider) {
    case 'anthropic':
      return { ANTHROPIC_API_KEY: apiKey };
    case 'openai':
      return { OPENAI_API_KEY: apiKey };
    case 'google':
      // Google's CLI tooling reads either name — set both for compatibility.
      return { GOOGLE_API_KEY: apiKey, GEMINI_API_KEY: apiKey };
    case 'mistral':
      return { MISTRAL_API_KEY: apiKey };
    case 'unknown':
    default:
      return {};
  }
}

/**
 * Resolve the env-var injection for a multi-provider agent's API key.
 *
 * Behavior:
 *   1. If `explicitProvider` is provided and not 'unknown', use it.
 *   2. Otherwise sniff from the key prefix.
 *   3. If sniffing also returns 'unknown', emit a deprecation warning
 *      and fall back to fanning out under the legacy env var names so
 *      existing users don't suddenly lose auth.
 *
 * @param apiKey - The BYOK key (may be empty / undefined).
 * @param legacyFallbackVars - Env var names the agent historically read
 *   (e.g. `['ANTHROPIC_API_KEY','OPENAI_API_KEY','GOOGLE_API_KEY']` for
 *   goose). Used ONLY when provider can't be detected.
 * @param explicitProvider - Optional caller-supplied provider override.
 * @param agentName - For logging context, e.g. 'GooseBackend'.
 * @returns Env vars to merge into the spawn env.
 */
export function resolveApiKeyEnv(
  apiKey: string | undefined,
  legacyFallbackVars: readonly string[],
  explicitProvider: ApiKeyProvider | undefined,
  agentName: string,
): Record<string, string> {
  if (!apiKey) return {};

  const provider = explicitProvider && explicitProvider !== 'unknown'
    ? explicitProvider
    : detectApiKeyProvider(apiKey);

  if (provider !== 'unknown') {
    return envVarsForProvider(provider, apiKey);
  }

  // Sniff failed AND no explicit override — fall back with a loud warning.
  // WHY: silently rejecting unknown keys would break existing users, but
  // the legacy fan-out IS a real security bug, so we mark it deprecated.
  logger.warn(
    `[${agentName}] Could not detect provider from API key prefix; ` +
    `falling back to legacy multi-provider fan-out. This is DEPRECATED ` +
    `and leaks your key to non-matching vendors during agent startup ` +
    `validation. Pass { provider: 'anthropic' | 'openai' | 'google' } ` +
    `explicitly, or use a key with a recognized prefix.`,
  );

  const fallback: Record<string, string> = {};
  for (const v of legacyFallbackVars) fallback[v] = apiKey;
  return fallback;
}
