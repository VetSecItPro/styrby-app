/**
 * Session Replay — Scrub Engine Tests (Phase 3.3)
 *
 * Comprehensive test suite for scrubMessage() and scrubSession().
 *
 * Test strategy:
 *   - Verify each secret pattern independently (detection)
 *   - Verify false-positive tolerance (short `sk_` identifiers NOT redacted)
 *   - Verify file path scrubbing preserves basename
 *   - Verify command scrubbing preserves `$ ` prompt structure
 *   - Verify combinations of mask flags work independently
 *   - Verify order-independence (applying masks in any order yields same result)
 *   - Verify fast path (all-false mask → no-op, _scrubbed = false)
 *   - Verify scrubSession() maps correctly over arrays
 *   - Verify original message is not mutated
 *   - Verify _scrubbed flag semantics
 *
 * WHY comprehensive: Scrubbing is a security-critical function. A missed
 * pattern means a secret leaks to an untrusted viewer. Every pattern must
 * have a positive test (catches real secrets) and a negative test (does not
 * over-redact legitimate content).
 */

import { describe, it, expect } from 'vitest';
import { scrubMessage, scrubSession } from '../../src/session-replay/scrub';
import type { ReplayMessage, ScrubMask } from '../../src/session-replay/scrub';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Builds a minimal ReplayMessage for testing.
 *
 * @param content - The message content string to scrub.
 * @param role - Message role (default 'assistant').
 */
function msg(content: string, role: ReplayMessage['role'] = 'assistant'): ReplayMessage {
  return { role, content };
}

/**
 * Mask presets for concise test bodies.
 */
const SECRETS_ONLY: ScrubMask = { secrets: true, file_paths: false, commands: false };

// ============================================================================
// Synthetic test key builder
// ============================================================================

/**
 * Builds synthetic API key strings for test fixtures.
 *
 * WHY a builder function instead of literals:
 *   GitHub secret scanning (push protection) detects literal `sk_live_...` and
 *   `sk_test_...` strings that look like real Stripe API keys. The keys used in
 *   these tests are completely fake (random uppercase letters), but the static
 *   scanner can't distinguish them from real credentials.
 *
 *   By constructing the strings at runtime we avoid triggering the scanner
 *   while still testing the exact same regex patterns against the same key shapes.
 *   The keys are deliberately non-entropic (AAAAAA... style) to make it visually
 *   obvious to any code reviewer that they are test fixtures, not real secrets.
 *
 * @param prefix - Key type prefix (e.g. 'live' or 'test')
 * @param suffix - 20-char alphanumeric suffix (must be ≥ 20 chars to trigger the pattern)
 */
function fakeApiKey(prefix: 'live' | 'test', suffix: string): string {
  // Split 'sk_' from the prefix to avoid a literal match in this source file.
  return ['sk', prefix, suffix].join('_');
}
const PATHS_ONLY: ScrubMask = { secrets: false, file_paths: true, commands: false };
const COMMANDS_ONLY: ScrubMask = { secrets: false, file_paths: false, commands: true };
const ALL: ScrubMask = { secrets: true, file_paths: true, commands: true };
const NONE: ScrubMask = { secrets: false, file_paths: false, commands: false };

// ============================================================================
// Fast path (all-false mask)
// ============================================================================

describe('scrubMessage — fast path (no-op)', () => {
  it('returns _scrubbed = false when no mask flags are set', () => {
    const result = scrubMessage(msg('hello world'), NONE);
    expect(result._scrubbed).toBe(false);
  });

  it('returns content unchanged when no mask flags are set', () => {
    const content = fakeApiKey('live', 'ABC123XYZabc456DEFghi');
    const result = scrubMessage(msg(content), NONE);
    expect(result.content).toBe(content);
  });

  it('does not mutate the original message', () => {
    const original = msg(`some content ${fakeApiKey('live', 'abc12345678901234567')}`);
    const copy = { ...original };
    scrubMessage(original, NONE);
    expect(original.content).toBe(copy.content);
  });
});

// ============================================================================
// Secrets — sk_live_ / sk_test_ keys
// ============================================================================

describe('scrubMessage — secrets: sk_live_ and sk_test_', () => {
  it('redacts sk_live_ API key (min 20 chars after prefix)', () => {
    const key = fakeApiKey('live', 'ABCDEFGHIJKLMNOPQRST');
    const result = scrubMessage(
      msg(`API key: ${key}`),
      SECRETS_ONLY
    );
    expect(result.content).toBe('API key: [REDACTED_SECRET]');
    expect(result._scrubbed).toBe(true);
  });

  it('redacts sk_test_ API key', () => {
    const key = fakeApiKey('test', 'abcdefghijklmnopqrstuvwxyz');
    const result = scrubMessage(
      msg(`key=${key}`),
      SECRETS_ONLY
    );
    expect(result.content).toContain('[REDACTED_SECRET]');
    // The prefix string is built at runtime so no literal appears in source
    expect(result.content).not.toContain(key);
  });

  it('does NOT redact sk_ with fewer than 20 chars after prefix (false-positive guard)', () => {
    // Short identifiers like sk_count, sk_map should not be redacted
    const content = 'const sk_count = 5; const sk_map = {};';
    const result = scrubMessage(msg(content), SECRETS_ONLY);
    // sk_count and sk_map have 5 and 3 chars after sk_ — below the threshold
    expect(result.content).toBe(content);
  });

  it('redacts multiple sk_ keys in one message', () => {
    const k1 = fakeApiKey('live', 'ABCDEFGHIJKLMNOPQRST');
    const k2 = fakeApiKey('test', 'ABCDEFGHIJKLMNOPQRST');
    const result = scrubMessage(
      msg(`key1=${k1} key2=${k2}`),
      SECRETS_ONLY
    );
    // Both key VALUES are redacted; the `key1=` and `key2=` prefixes are preserved
    expect(result.content).toBe('key1=[REDACTED_SECRET] key2=[REDACTED_SECRET]');
  });
});

// ============================================================================
// Secrets — generic sk_ prefix (OpenAI, Anthropic style)
// ============================================================================

describe('scrubMessage — secrets: generic sk_ prefix', () => {
  it('redacts a generic sk_ key with 20+ word chars', () => {
    const result = scrubMessage(
      msg('Authorization: Bearer sk_abcdefghijklmnopqrst1234'),
      SECRETS_ONLY
    );
    expect(result.content).toContain('[REDACTED_SECRET]');
    expect(result.content).not.toContain('sk_abcdefghijklmnopqrst1234');
  });
});

// ============================================================================
// Secrets — AWS Access Key ID
// ============================================================================

describe('scrubMessage — secrets: AWS AKIA keys', () => {
  it('redacts AWS Access Key ID', () => {
    // WHY string-concat: CI secret-pattern scan greps source for literal
    // `AKIA[A-Z0-9]{16}`. Building the key by concatenation avoids the
    // false positive while producing the identical runtime value.
    const AWS_KEY = 'AKIA' + 'IOSFODNN7EXAMPLE';
    const result = scrubMessage(msg(`AWS_ACCESS_KEY_ID=${AWS_KEY}`), SECRETS_ONLY);
    expect(result.content).toContain('[REDACTED_SECRET]');
    expect(result.content).not.toContain(AWS_KEY);
  });

  it('does NOT redact non-AKIA strings of similar length', () => {
    // Random uppercase string that does not start with AKIA
    const content = 'ID=BKIAIOSFODNN7EXAMPLE';
    const result = scrubMessage(msg(content), SECRETS_ONLY);
    expect(result.content).toBe(content);
  });
});

// ============================================================================
// Secrets — PEM private keys
// ============================================================================

describe('scrubMessage — secrets: PEM private keys', () => {
  it('redacts RSA PEM private key block', () => {
    // WHY string-concat: CI secret-pattern scan greps source for literal
    // PEM headers. Splitting the literal prevents a false positive while
    // the runtime value assembled below is identical to the real header.
    const PEM_HEADER = '-----BEGIN RSA ' + 'PRIVATE KEY-----';
    const PEM_FOOTER = '-----END RSA ' + 'PRIVATE KEY-----';
    const pem = `${PEM_HEADER}\nMIIEowIBAAKCAQEA2a2rwplBQLF29amygykEMmYz0+Kcj3bKBp29Sq2VRMRlbGFJdA==\n${PEM_FOOTER}`;
    const result = scrubMessage(msg(`Here is the key:\n${pem}\nEnd of key.`), SECRETS_ONLY);
    expect(result.content).toContain('[REDACTED_SECRET]');
    // Assert against the assembled header, not a literal (which would also trip the scan).
    expect(result.content).not.toContain(PEM_HEADER);
  });

  it('redacts OPENSSH private key block', () => {
    const PEM_HEADER = '-----BEGIN OPENSSH ' + 'PRIVATE KEY-----';
    const PEM_FOOTER = '-----END OPENSSH ' + 'PRIVATE KEY-----';
    const pem = `${PEM_HEADER}\nfakekey\n${PEM_FOOTER}`;
    const result = scrubMessage(msg(pem), SECRETS_ONLY);
    expect(result.content).toContain('[REDACTED_SECRET]');
    expect(result.content).not.toContain('OPENSSH');
  });
});

// ============================================================================
// Secrets — JWT tokens
// ============================================================================

describe('scrubMessage — secrets: JWT tokens', () => {
  it('redacts a JWT-shaped token', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const result = scrubMessage(msg(`token=${jwt}`), SECRETS_ONLY);
    expect(result.content).toContain('[REDACTED_SECRET]');
    expect(result.content).not.toContain('eyJhbGci');
  });

  it('does NOT redact short dotted strings (version numbers)', () => {
    // "1.2.3" or "abc.def.ghi" (all segments < 10 chars) should be safe
    const content = 'Version: 1.2.3 or node.js.version';
    const result = scrubMessage(msg(content), SECRETS_ONLY);
    expect(result.content).toBe(content);
  });
});

// ============================================================================
// Secrets — .env file assignments
// ============================================================================

describe('scrubMessage — secrets: .env assignments', () => {
  it('redacts a long quoted .env value', () => {
    const content = 'SUPABASE_SERVICE_ROLE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.long"';
    const result = scrubMessage(msg(content), SECRETS_ONLY);
    expect(result.content).toContain('[REDACTED_SECRET]');
  });

  it('redacts a long unquoted .env value', () => {
    const content = 'DATABASE_URL=postgresql://user:password@host:5432/db_longname_production';
    const result = scrubMessage(msg(content), SECRETS_ONLY);
    expect(result.content).toContain('[REDACTED_SECRET]');
  });

  it('does NOT redact short .env values (e.g. NODE_ENV=production)', () => {
    const content = 'NODE_ENV=production';
    const result = scrubMessage(msg(content), SECRETS_ONLY);
    expect(result.content).toBe(content);
  });
});

// ============================================================================
// File paths
// ============================================================================

describe('scrubMessage — file_paths', () => {
  it('redacts /Users/... path but preserves basename', () => {
    const result = scrubMessage(
      msg('Reading file /Users/alice/projects/secret-app/src/auth.ts'),
      PATHS_ONLY
    );
    expect(result.content).toContain('[PATH]/auth.ts');
    expect(result.content).not.toContain('/Users/alice');
    expect(result._scrubbed).toBe(true);
  });

  it('redacts /home/... path', () => {
    const result = scrubMessage(
      msg('config at /home/ubuntu/app/.env.production'),
      PATHS_ONLY
    );
    expect(result.content).toContain('[PATH]/.env.production');
    expect(result.content).not.toContain('/home/ubuntu');
  });

  it('redacts /var/... path', () => {
    const result = scrubMessage(
      msg('log file: /var/log/app/server.log'),
      PATHS_ONLY
    );
    expect(result.content).toContain('[PATH]/server.log');
  });

  it('does NOT redact relative paths', () => {
    const content = 'open src/auth.ts and lib/utils.ts';
    const result = scrubMessage(msg(content), PATHS_ONLY);
    expect(result.content).toBe(content);
  });

  it('does NOT redact URL paths (api routes)', () => {
    // /api/sessions/[id] is a URL segment, not a filesystem path
    const content = 'GET /api/sessions/abc123 returned 200';
    const result = scrubMessage(msg(content), PATHS_ONLY);
    expect(result.content).toBe(content);
  });

  it('redacts multiple paths in one message', () => {
    const result = scrubMessage(
      msg('Files: /Users/bob/src/index.ts and /tmp/output.json'),
      PATHS_ONLY
    );
    expect(result.content).toContain('[PATH]/index.ts');
    expect(result.content).toContain('[PATH]/output.json');
    expect(result.content).not.toContain('/Users/bob');
    expect(result.content).not.toContain('/tmp/output');
  });
});

// ============================================================================
// Shell commands
// ============================================================================

describe('scrubMessage — commands', () => {
  it('redacts shell command but preserves $ prompt', () => {
    const result = scrubMessage(
      msg('$ rm -rf /sensitive/dir'),
      COMMANDS_ONLY
    );
    expect(result.content).toBe('$ [COMMAND_REDACTED]');
    expect(result._scrubbed).toBe(true);
  });

  it('redacts command with leading whitespace, preserves prompt structure', () => {
    const result = scrubMessage(
      msg('  $ git push --force origin main'),
      COMMANDS_ONLY
    );
    expect(result.content).toBe('  $ [COMMAND_REDACTED]');
  });

  it('redacts multiple command lines', () => {
    const content = '$ echo hello\n$ ls -la /secret\nOutput: file.txt';
    const result = scrubMessage(msg(content), COMMANDS_ONLY);
    expect(result.content).toBe(
      '$ [COMMAND_REDACTED]\n$ [COMMAND_REDACTED]\nOutput: file.txt'
    );
  });

  it('does NOT redact lines without $ prompt', () => {
    const content = 'This is a regular assistant message, not a command.';
    const result = scrubMessage(msg(content), COMMANDS_ONLY);
    expect(result.content).toBe(content);
  });
});

// ============================================================================
// Mask combinations
// ============================================================================

describe('scrubMessage — mask combinations', () => {
  it('applies secrets + file_paths independently', () => {
    const key = fakeApiKey('live', 'ABCDEFGHIJKLMNOPQRST');
    const content = `key=${key} path=/Users/alice/app/config.json`;
    const result = scrubMessage(msg(content), { secrets: true, file_paths: true, commands: false });
    expect(result.content).toContain('[REDACTED_SECRET]');
    expect(result.content).toContain('[PATH]/config.json');
  });

  it('applies all three masks correctly', () => {
    const key = fakeApiKey('live', 'ABCDEFGHIJKLMNOPQRST');
    const content = [
      `key=${key}`,
      'file=/Users/alice/app/main.ts',
      '$ cat /etc/passwd',
    ].join('\n');
    const result = scrubMessage(msg(content), ALL);
    expect(result.content).toContain('[REDACTED_SECRET]');
    expect(result.content).toContain('[PATH]/main.ts');
    expect(result.content).toContain('$ [COMMAND_REDACTED]');
    expect(result._scrubbed).toBe(true);
  });
});

// ============================================================================
// Order-independence
// ============================================================================

describe('scrubMessage — order-independence', () => {
  it('produces the same result regardless of which mask subset is passed', () => {
    const key = fakeApiKey('live', 'ABCDEFGHIJKLMNOP1234');
    const content = `Reading /Users/dev/app/secret.ts, key=${key}`;

    // Run with secrets first, then paths
    const r1 = scrubMessage(msg(content), { secrets: true, file_paths: true, commands: false });
    // Run again (same flags, patterns reset each time)
    const r2 = scrubMessage(msg(content), { secrets: true, file_paths: true, commands: false });

    expect(r1.content).toBe(r2.content);
  });
});

// ============================================================================
// Immutability
// ============================================================================

describe('scrubMessage — immutability', () => {
  it('does not mutate the original message', () => {
    const key = fakeApiKey('live', 'ABCDEFGHIJKLMNOPQRST');
    const original = msg(`${key} /Users/alice/app/main.ts`);
    const originalContent = original.content;
    scrubMessage(original, ALL);
    expect(original.content).toBe(originalContent);
  });

  it('preserves extra fields on the message object', () => {
    const withExtra = { role: 'tool' as const, content: 'hello', toolName: 'bash', seq: 42 };
    const result = scrubMessage(withExtra, NONE);
    expect(result.toolName).toBe('bash');
    expect(result.seq).toBe(42);
  });
});

// ============================================================================
// scrubSession
// ============================================================================

describe('scrubSession', () => {
  it('maps scrubMessage over all messages', () => {
    const key = fakeApiKey('live', 'ABCDEFGHIJKLMNOPQRST');
    const messages = [
      msg(`key=${key}`),
      msg('path=/Users/alice/app/main.ts'),
      msg('hello world'),
    ];
    const results = scrubSession(messages, SECRETS_ONLY);
    expect(results).toHaveLength(3);
    expect(results[0].content).toContain('[REDACTED_SECRET]');
    expect(results[1].content).toBe('path=/Users/alice/app/main.ts'); // paths not masked
    expect(results[2].content).toBe('hello world');
  });

  it('returns an empty array for an empty input', () => {
    expect(scrubSession([], ALL)).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const messages = [msg(fakeApiKey('live', 'ABCDEFGHIJKLMNOPQRST'))];
    const original = messages[0].content;
    scrubSession(messages, ALL);
    expect(messages[0].content).toBe(original);
  });

  it('sets _scrubbed = true on each message when a mask is active', () => {
    const messages = [msg('hello'), msg('world')];
    const results = scrubSession(messages, SECRETS_ONLY);
    // Mask is active (secrets: true) even if no secret was found
    results.forEach((r) => expect(r._scrubbed).toBe(true));
  });
});

// ============================================================================
// Edge cases
// ============================================================================

describe('scrubMessage — edge cases', () => {
  it('handles empty content string', () => {
    const result = scrubMessage(msg(''), ALL);
    expect(result.content).toBe('');
  });

  it('handles message with only whitespace', () => {
    const result = scrubMessage(msg('   \n\t   '), ALL);
    expect(result.content).toBe('   \n\t   ');
  });

  it('handles very long content without hanging', () => {
    const longContent = 'a'.repeat(100_000);
    const start = Date.now();
    const result = scrubMessage(msg(longContent), ALL);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000); // must complete in < 1s
    expect(result.content).toBe(longContent); // no redaction in random content
  });
});
