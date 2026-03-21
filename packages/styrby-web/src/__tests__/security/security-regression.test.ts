/**
 * Security Regression Tests
 *
 * Protects against reintroduction of security vulnerabilities fixed on
 * 2026-03-21. Each test reads actual source files and asserts that security
 * fixes remain in place: auth checks, input validation, cryptographic
 * randomness, SSRF guards, and rate limiting.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// __dirname = packages/styrby-web/src/__tests__/security
//   ../      = __tests__
//   ../../   = src   (where all source files live)
const WEB_SRC = resolve(__dirname, '../../');
const CLI_SRC = resolve(__dirname, '../../../../styrby-cli/src');
const SHARED_SRC = resolve(__dirname, '../../../../styrby-shared/src');
const SUPABASE_FN = resolve(__dirname, '../../../../../supabase/functions');

function readWeb(relPath: string): string {
  return readFileSync(resolve(WEB_SRC, relPath), 'utf-8');
}

function readCli(relPath: string): string {
  return readFileSync(resolve(CLI_SRC, relPath), 'utf-8');
}

function readShared(relPath: string): string {
  return readFileSync(resolve(SHARED_SRC, relPath), 'utf-8');
}

function readFn(relPath: string): string {
  return readFileSync(resolve(SUPABASE_FN, relPath), 'utf-8');
}

// ============================================================================
// deliver-webhook — auth check
// ============================================================================

describe('deliver-webhook edge function — authentication', () => {
  it('deliver-webhook checks for SUPABASE_SERVICE_ROLE_KEY', () => {
    const content = readFn('deliver-webhook/index.ts');
    expect(content).toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('deliver-webhook returns 401 for missing or invalid token', () => {
    const content = readFn('deliver-webhook/index.ts');
    // Must have a 401 response in the auth section
    expect(content).toContain('401');
    expect(content).toContain('Unauthorized');
  });

  it('deliver-webhook has SSRF URL validation', () => {
    const content = readFn('deliver-webhook/index.ts');
    expect(content).toContain('validateWebhookUrl');
    // Must block private IP ranges
    expect(content).toContain('169.254');
    expect(content).toContain('127.0.0.1');
  });

  it('deliver-webhook has DNS rebinding protection via IP validation after resolution', () => {
    const content = readFn('deliver-webhook/index.ts');
    // DNS rebinding fix: resolve the hostname and validate each returned IP
    expect(content).toContain('validateResolvedIp');
    expect(content).toContain('resolveDns');
  });
});

// ============================================================================
// generate-summary — no encrypted content sent to AI
// ============================================================================

describe('generate-summary edge function — data privacy', () => {
  it('does NOT select content_encrypted to send to OpenAI', () => {
    const content = readFn('generate-summary/index.ts');
    // The select for messages must never include content_encrypted
    expect(content).not.toContain("select('content_encrypted')");
    expect(content).not.toContain('"content_encrypted"');
  });

  it('generate-summary uses service role auth (not anonymous)', () => {
    const content = readFn('generate-summary/index.ts');
    expect(content).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(content).toContain('401');
  });

  it('generate-summary sanitizes user-controlled values before embedding in AI prompt', () => {
    const content = readFn('generate-summary/index.ts');
    // Prompt injection protection
    expect(content).toContain('sanitizeForPrompt');
  });
});

// ============================================================================
// rate limiter — Upstash Redis
// ============================================================================

describe('rate limiter — distributed Redis backend', () => {
  it('rateLimit.ts imports from @upstash/ratelimit', () => {
    const content = readWeb('lib/rateLimit.ts');
    expect(content).toContain('@upstash/ratelimit');
  });

  it('rateLimit.ts imports from @upstash/redis', () => {
    const content = readWeb('lib/rateLimit.ts');
    expect(content).toContain('@upstash/redis');
  });

  it('rateLimit.ts uses sliding window algorithm (not fixed window)', () => {
    const content = readWeb('lib/rateLimit.ts');
    // Sliding window prevents burst-at-boundary attacks
    expect(content).toContain('slidingWindow');
  });

  it('rateLimit.ts has in-memory fallback for local dev', () => {
    const content = readWeb('lib/rateLimit.ts');
    // Must not throw when Redis is not configured (local dev / CI)
    expect(content).toContain('isRedisConfigured');
    expect(content).toContain('inMemoryRateLimit');
  });
});

// ============================================================================
// CLI — agent type validation against allowlist
// ============================================================================

describe('CLI — agent type allowlist validation', () => {
  it('CLI index defines VALID_AGENTS allowlist', () => {
    const content = readCli('index.ts');
    expect(content).toContain('VALID_AGENTS');
  });

  it('CLI validates agent type against VALID_AGENTS before accepting it', () => {
    const content = readCli('index.ts');
    // Must include() check against the allowlist
    expect(content).toMatch(/VALID_AGENTS\.includes\(/);
  });

  it('CLI VALID_AGENTS includes all supported agent names', () => {
    const content = readCli('index.ts');
    // All agents that were in scope at fix time
    expect(content).toContain("'claude'");
    expect(content).toContain("'codex'");
    expect(content).toContain("'gemini'");
  });
});

// ============================================================================
// API key generation — no Math.random()
// ============================================================================

describe('API key generation — cryptographic randomness', () => {
  it('api-keys.ts uses crypto.getRandomValues() for key generation', () => {
    const content = readShared('utils/api-keys.ts');
    expect(content).toContain('crypto.getRandomValues');
  });

  it('api-keys.ts does not call Math.random() — only references it in a warning comment', () => {
    const content = readShared('utils/api-keys.ts');
    // Math.random() may appear in a comment explaining why it is rejected,
    // but must never be called as actual code. Check it only appears in comments.
    const codeLines = content
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'));
    const hasCallInCode = codeLines.some((line) => line.includes('Math.random()'));
    expect(hasCallInCode).toBe(false);
  });

  it('api-keys.ts comment explains why Math.random() was rejected (security rationale)', () => {
    const content = readShared('utils/api-keys.ts');
    expect(content).toContain('cryptographically weak');
  });
});

// ============================================================================
// relay/types — crypto.randomUUID() for message IDs
// ============================================================================

describe('relay message IDs — crypto.randomUUID()', () => {
  it('relay types uses crypto.randomUUID() for generateMessageId', () => {
    const content = readShared('relay/types.ts');
    expect(content).toContain('crypto.randomUUID()');
  });

  it('relay types does not use Math.random() for ID generation', () => {
    const content = readShared('relay/types.ts');
    expect(content).not.toContain('Math.random()');
  });
});

// ============================================================================
// budget-monitor — UUID input validation (injection prevention)
// ============================================================================

describe('budget-monitor — input validation', () => {
  it('budget-monitor validates userId is a proper UUID v4', () => {
    const content = readCli('costs/budget-monitor.ts');
    expect(content).toContain('isValidUuid');
    expect(content).toContain('UUID_REGEX');
  });

  it('budget-monitor throws on invalid userId format', () => {
    const content = readCli('costs/budget-monitor.ts');
    expect(content).toContain('Invalid userId format');
  });
});

// ============================================================================
// middleware api-auth — key lookup uses prefix, not full key
// ============================================================================

describe('API key authentication middleware', () => {
  it('api-auth middleware exists', () => {
    expect(() => readWeb('middleware/api-auth.ts')).not.toThrow();
  });

  it('api-auth middleware references audit_log for security event recording', () => {
    const content = readWeb('middleware/api-auth.ts');
    expect(content).toContain('audit_log');
  });
});
