/**
 * Tests for safeEnv.validateExtraArgs.
 *
 * Covers the extended config-flag blocklist that protects all 11
 * supported agents (claude, codex, gemini, opencode, aider, goose,
 * amp, crush, kilo, kiro, droid) from config-file injection via
 * extra-args.
 *
 * @module utils/safeEnv.test
 */

import { describe, it, expect } from 'vitest';
import { validateExtraArgs } from './safeEnv';

describe('validateExtraArgs - shell metacharacters', () => {
  it.each([
    ['semicolon', 'foo;rm -rf /'],
    ['ampersand', 'foo&bar'],
    ['pipe', 'foo|bar'],
    ['backtick', 'foo`whoami`'],
    ['dollar paren', 'foo$(whoami)'],
    ['dollar var', 'foo$BAR'],
    ['braces', 'foo{}'],
  ])('rejects %s metachar', (_label, arg) => {
    expect(() => validateExtraArgs([arg])).toThrow(/Shell metacharacters/);
  });

  it('passes through clean args', () => {
    expect(validateExtraArgs(['--model', 'sonnet-4', '--temperature', '0.2'])).toEqual([
      '--model',
      'sonnet-4',
      '--temperature',
      '0.2',
    ]);
  });
});

describe('validateExtraArgs - system path blocklist (per-agent flags)', () => {
  // Each entry covers an agent's config-loading flag pattern. /etc/passwd
  // is the canonical "trying to read a system file" probe.
  it.each([
    ['Aider --config', '--config=/etc/passwd'],
    ['Aider --env-file', '--env-file=/etc/shadow'],
    ['Goose --profile', '--profile=/etc/passwd'],
    ['OpenCode --profile', '--profile=/etc/secret'],
    ['Crush/Kilo/Kiro/Droid/Amp --config', '--config=/etc/secret'],
    ['Claude --config short', '-config=/etc/passwd'],
    ['--rc', '--rc=/etc/passwd'],
    ['--init', '--init=/etc/passwd'],
    ['--dotenv', '--dotenv=/etc/passwd'],
  ])('rejects %s targeting /etc/', (_label, arg) => {
    expect(() => validateExtraArgs([arg])).toThrow(/Unsafe argument targeting system path/);
  });
});

describe('validateExtraArgs - path traversal blocklist (per-agent flags)', () => {
  it.each([
    ['Aider --config traversal', '--config=../../../etc/passwd'],
    ['Aider --env-file traversal', '--env-file=../../secret.env'],
    ['Goose --profile traversal', '--profile=../../etc/passwd'],
    ['OpenCode --profile traversal', '--profile=../../../foo'],
    ['Crush --config traversal', '--config=../../bad.toml'],
    ['--include traversal', '--include=../../bad'],
    ['--load traversal', '--load=../../bad'],
    ['--rc traversal', '--rc=../../bad'],
    ['--init traversal', '--init=../../bad'],
  ])('rejects %s', (_label, arg) => {
    expect(() => validateExtraArgs([arg])).toThrow(/Unsafe path traversal/);
  });

  it('allows config flags pointing at project-relative paths', () => {
    // Forward-relative paths (no ../) are allowed - users legitimately
    // point at ./config.toml or subdir/config.json.
    expect(validateExtraArgs(['--config=./config.toml'])).toEqual(['--config=./config.toml']);
    expect(validateExtraArgs(['--profile=workspace/dev.json'])).toEqual([
      '--profile=workspace/dev.json',
    ]);
  });
});
