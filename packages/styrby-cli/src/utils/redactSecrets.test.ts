/**
 * Tests for redactSecrets / redactAgentMessage (utils/redactSecrets.ts).
 *
 * SECURITY (Cluster A1): agent stdout is parsed and emitted to listeners that
 * forward to operational logs + the relay. `buildSafeEnv` guards what env we
 * pass INTO an agent, but nothing scrubbed what the agent prints back OUT. An
 * agent that runs `env`, `cat .env`, or echoes a `curl -H "Authorization:
 * Bearer ..."` would stream that credential through. These tests pin the
 * redactor's contract: catch credential VALUES and `NAME=secret` env dumps,
 * WITHOUT mangling ordinary code/text (false redaction is a real UX cost).
 *
 * @module utils/redactSecrets.test
 */

import { describe, it, expect } from 'vitest';
import { redactSecrets, redactAgentMessage } from './redactSecrets';

describe('redactSecrets — standalone credential VALUES (any context)', () => {
  it('redacts a provider secret key (sk-...)', () => {
    expect(redactSecrets('key is sk-ant-api03-abcdef0123456789ABCDEF')).not.toContain('abcdef0123456789');
    expect(redactSecrets('key is sk-ant-api03-abcdef0123456789ABCDEF')).toContain('[REDACTED]');
  });

  it('redacts a GitHub PAT (ghp_/gho_/ghs_)', () => {
    const pat = 'ghp_' + 'a'.repeat(36);
    expect(redactSecrets(`token=${pat}`)).not.toContain(pat);
  });

  it('redacts an AWS access key id (AKIA...)', () => {
    // WHY built by concat: a contiguous AKIA-literal would trip the CI
    // "Secret pattern scan" (which correctly scans test files too). Splitting
    // keeps the runtime value identical without a real-looking secret in source.
    const awsKey = 'AKIA' + 'IOSFODNN7EXAMPLE';
    expect(redactSecrets(`${awsKey} here`)).not.toContain(awsKey);
  });

  it('redacts a Google API key (AIza...)', () => {
    const k = 'AIza' + 'B'.repeat(35);
    expect(redactSecrets(k)).toBe('[REDACTED]');
  });

  it('redacts a Styrby API key value (styrby_...)', () => {
    expect(redactSecrets('styrby_AbCdEf0123456789')).toBe('[REDACTED]');
  });

  it('redacts a JWT', () => {
    // Built by concat so the contiguous JWT literal never sits in source (CI
    // "Secret pattern scan" matches the eyJ...header pattern). Runtime value is
    // a valid three-segment JWT shape, which is what the redactor must catch.
    const jwt = ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'].join('.');
    expect(redactSecrets(`Authorization: ${jwt}`)).toContain('[REDACTED]');
    expect(redactSecrets(`Authorization: ${jwt}`)).not.toContain('SflKxwRJSMeKKF2QT4');
  });

  it('redacts a Bearer token in an auth header', () => {
    expect(redactSecrets('-H "Authorization: Bearer abcDEF123456789xyz"')).not.toContain('abcDEF123456789xyz');
  });

  it('redacts multiple secrets in one line', () => {
    const out = redactSecrets('sk-ant-0123456789abcdefABCD and ghp_' + 'z'.repeat(36));
    expect(out).not.toMatch(/sk-ant-0123456789/);
    expect(out).not.toMatch(/ghp_z{36}/);
  });
});

describe('redactSecrets — NAME=value env dumps', () => {
  it('redacts SCREAMING_SNAKE env assignments, keeping the name', () => {
    expect(redactSecrets('ANTHROPIC_API_KEY=sk-ant-realsecretvalue123456'))
      .toBe('ANTHROPIC_API_KEY=[REDACTED]');
  });

  it('redacts an `export VAR=...` env dump line', () => {
    expect(redactSecrets('export OPENAI_API_KEY=xyzSECRETvalue12345')).toContain('OPENAI_API_KEY=[REDACTED]');
  });

  it('redacts a quoted JSON-style secret with a lowercase key', () => {
    expect(redactSecrets('"apiKey": "abcdefgh12345"')).toContain('[REDACTED]');
    expect(redactSecrets('"apiKey": "abcdefgh12345"')).not.toContain('abcdefgh12345');
  });

  it('redacts AWS_SECRET_ACCESS_KEY assignment', () => {
    expect(redactSecrets('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCY'))
      .toContain('AWS_SECRET_ACCESS_KEY=[REDACTED]');
  });
});

describe('redactSecrets — does NOT over-redact ordinary text/code', () => {
  it('leaves lowercase code assignments alone', () => {
    // name lowercase + value unquoted => not an env dump, preserve.
    expect(redactSecrets('const token = parseToken(input)')).toBe('const token = parseToken(input)');
  });

  it('does not match words that merely contain "key"', () => {
    expect(redactSecrets('MONKEY=banana12345')).toBe('MONKEY=banana12345');
    expect(redactSecrets('the keyboard layout = qwerty')).toBe('the keyboard layout = qwerty');
  });

  it('leaves prose untouched', () => {
    const s = 'Refactored the auth module and fixed the token refresh race condition.';
    expect(redactSecrets(s)).toBe(s);
  });

  it('returns non-string-safe empty for empty input', () => {
    expect(redactSecrets('')).toBe('');
  });

  it('scrubs each line of multiline text independently', () => {
    const input = 'line one ok\nGITHUB_TOKEN=ghp_' + 'a'.repeat(36) + '\nline three ok';
    const out = redactSecrets(input);
    expect(out).toContain('line one ok');
    expect(out).toContain('line three ok');
    expect(out).toContain('GITHUB_TOKEN=[REDACTED]');
  });
});

describe('redactAgentMessage — recursive scrub of every string field', () => {
  it('scrubs terminal-output data (the env-dump vector)', () => {
    const msg = { type: 'terminal-output', data: 'OPENAI_API_KEY=sk-realvalue0123456789' } as const;
    const out = redactAgentMessage(msg) as typeof msg;
    expect(out.data).toContain('[REDACTED]');
    expect(out.data).not.toContain('sk-realvalue0123456789');
  });

  it('scrubs model-output fullText and textDelta', () => {
    const msg = { type: 'model-output', fullText: 'here is your key sk-ant-abcdef0123456789ABCDEF' } as const;
    const out = redactAgentMessage(msg) as typeof msg;
    expect(out.fullText).not.toContain('abcdef0123456789');
  });

  it('scrubs nested object fields (tool-result.result)', () => {
    const msg = {
      type: 'tool-result',
      toolName: 'bash',
      callId: 'c1',
      result: { stdout: 'GITHUB_TOKEN=ghp_' + 'a'.repeat(36), exitCode: 0 },
    } as const;
    const out = redactAgentMessage(msg) as { result: { stdout: string; exitCode: number } };
    expect(out.result.stdout).toContain('[REDACTED]');
    expect(out.result.exitCode).toBe(0); // non-string fields preserved
  });

  it('does not mutate the original message (returns a clean copy)', () => {
    const msg = { type: 'terminal-output', data: 'sk-ant-secret0123456789ABCDEF' } as const;
    redactAgentMessage(msg);
    expect(msg.data).toBe('sk-ant-secret0123456789ABCDEF'); // original intact
  });

  it('passes through messages with no secrets unchanged in value', () => {
    const msg = { type: 'status', status: 'running', detail: 'compiling' } as const;
    expect(redactAgentMessage(msg)).toEqual(msg);
  });
});
