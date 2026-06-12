/**
 * Outbound secret redaction for agent stdout (Cluster A1).
 *
 * THREAT MODEL
 * ------------
 * `buildSafeEnv` (utils/safeEnv.ts) controls what environment we pass INTO a
 * spawned agent. It does nothing about what the agent prints back OUT. A coding
 * agent routinely runs commands whose output can contain live credentials:
 * `env`, `printenv`, `cat .env`, `aws configure list`, or echoing a
 * `curl -H "Authorization: Bearer ..."`. That stdout is parsed by the agent
 * factories and `emit()`-ed to every listener — which forwards to operational
 * logs and the relay. The session message body is E2E-encrypted end to end, but
 * the operational/log sinks are NOT, so a leaked token there is plaintext.
 *
 * This module scrubs credentials at the `emit()` choke point so they never reach
 * those sinks. It is defense-in-depth, NOT a replacement for E2E.
 *
 * DESIGN
 * ------
 * Two complementary pattern sets:
 *  1. Standalone VALUE patterns (sk-, ghp_/gho_/..., AKIA, AIza, styrby_, JWT,
 *     Bearer) — catch a real credential wherever it appears, no key name needed.
 *  2. NAME=value assignment pattern — catches `OPENAI_API_KEY=...` env dumps and
 *     `"apiKey": "..."` JSON, keeping the name and masking only the value. To
 *     avoid mangling ordinary code (`const token = parseToken()`), the
 *     assignment only fires when the name is SCREAMING_SNAKE_CASE (env-var
 *     convention) OR the value is quoted. False redaction is a real UX cost, so
 *     precision is deliberate.
 *
 * NOT redacted: emails / general PII. Different threat model from the mobile
 * Sentry scrubber — this is the user's OWN session streaming to the user's OWN
 * device; the concern is leaked CREDENTIALS in shared log/relay sinks, not PII,
 * and redacting every email would mangle legitimate code/commit output.
 *
 * Parity note: the credential VALUE patterns mirror
 * `packages/styrby-mobile/src/observability/sentry.ts` SECRET_PATTERNS so the
 * two redaction layers agree on what a secret looks like.
 *
 * @module utils/redactSecrets
 */

const REDACTED = '[REDACTED]';

/**
 * Standalone credential-VALUE patterns. Each match is replaced wholesale with
 * `[REDACTED]`. These fire regardless of surrounding key name.
 */
const VALUE_PATTERNS: readonly RegExp[] = [
  // JWTs (Supabase anon/service, auth bearer payloads): three base64url segments.
  /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  // `Bearer <token>` auth headers.
  /Bearer\s+[A-Za-z0-9._-]{8,}/gi,
  // Provider secret keys: sk-..., sk_live_..., sk-ant-... (OpenAI/Anthropic/Stripe-style).
  /sk[-_][A-Za-z0-9-]{16,}/g,
  // GitHub tokens: PAT (ghp_), OAuth (gho_), user (ghu_), server (ghs_), refresh (ghr_).
  /gh[opusr]_[A-Za-z0-9]{36,}/g,
  // AWS access key id.
  /AKIA[0-9A-Z]{16}/g,
  // Google API key.
  /AIza[0-9A-Za-z_-]{35}/g,
  // Styrby API key VALUES (the value, not the `styrby_` prefix as a word).
  /styrby_[A-Za-z0-9]{12,}/g,
];

/**
 * Assignment pattern: a sensitive key name followed by `=` or `:` and a value.
 * Captures: (1) the full name, (2) optional opening quote, (3) the value.
 * Only treated as a secret when {@link isEnvSecretAssignment} agrees, so we keep
 * the name and mask the value: `OPENAI_API_KEY=[REDACTED]`.
 *
 * The name must CONTAIN a high-signal credential keyword (api[_-]?key,
 * access[_-]?key, auth[_-]?token, secret, token, password/passwd, credential,
 * private[_-]?key) — bare "key" is excluded so "monkey"/"keyboard" don't match.
 */
// The `["']?` after the name tolerates a JSON-style closing quote on the key
// (`"apiKey": "..."`) before the `:`/`=` separator.
const ASSIGNMENT_PATTERN =
  /\b([A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?key|auth[_-]?token|private[_-]?key|secret|token|password|passwd|credentials?)[A-Za-z0-9_-]*)["']?\s*[:=]\s*(["']?)([^\s"']{4,})\2/gi;

/**
 * Decide whether a matched `name=value` is a real env/secret dump vs ordinary
 * code. True when the name is SCREAMING_SNAKE_CASE (env-var convention, e.g.
 * `GITHUB_TOKEN`) or the value was quoted (JSON/YAML config, e.g.
 * `"apiKey": "..."`). This is what keeps `const token = parseToken()` intact.
 *
 * @param name - The captured key name.
 * @param quote - The captured opening quote char ('' if the value was unquoted).
 * @returns True if the value should be masked.
 */
function isEnvSecretAssignment(name: string, quote: string): boolean {
  const isQuoted = quote === '"' || quote === "'";
  const isScreamingSnake = /^[A-Z0-9_]+$/.test(name);
  return isQuoted || isScreamingSnake;
}

/**
 * Redact credential values from a single string.
 *
 * Applies the assignment pattern first (preserves the key name) then the
 * standalone value patterns (catch bare tokens). Safe on multiline input — the
 * global regexes span lines naturally. Non-secret text is returned unchanged.
 *
 * @param text - Arbitrary text (typically a line of agent stdout).
 * @returns The text with credential values replaced by `[REDACTED]`.
 *
 * @example
 * redactSecrets('OPENAI_API_KEY=sk-ant-realvalue123456'); // 'OPENAI_API_KEY=[REDACTED]'
 * redactSecrets('const token = parseToken(x)');           // unchanged
 */
export function redactSecrets(text: string): string {
  if (!text) return text;

  let out = text.replace(
    ASSIGNMENT_PATTERN,
    (match, name: string, quote: string, _value: string) =>
      isEnvSecretAssignment(name, quote) ? `${name}=${REDACTED}` : match,
  );

  for (const rx of VALUE_PATTERNS) {
    out = out.replace(rx, REDACTED);
  }

  return out;
}

/**
 * Recursively redact every string value within a structured value, returning a
 * fresh copy (the input is never mutated). Non-string leaves (numbers, booleans,
 * null) pass through untouched.
 *
 * Used to scrub a whole `AgentMessage` — text fields (`fullText`, `data`,
 * `detail`, `diff`, `stdout`/`stderr`) and nested objects (`tool-result.result`)
 * alike — without the caller having to enumerate which fields are free text.
 *
 * @param value - Any JSON-like value (string, number, array, object, ...).
 * @returns A redacted deep copy.
 */
function redactDeep(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactDeep(v);
    }
    return out;
  }
  return value;
}

/**
 * Redact credentials from an agent message before it is emitted to listeners.
 *
 * Returns a redacted deep copy; the original is not mutated (callers may still
 * hold a reference to the pre-redaction object for internal bookkeeping).
 *
 * @param msg - The agent message about to be emitted.
 * @returns A copy with all string fields scrubbed of credential values.
 */
export function redactAgentMessage<T>(msg: T): T {
  return redactDeep(msg) as T;
}
