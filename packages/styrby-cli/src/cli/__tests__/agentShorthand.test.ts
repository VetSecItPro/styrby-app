/**
 * Unit tests for `cli/agentShorthand`.
 *
 * These helpers are pure and security-relevant (they influence which
 * downstream handler runs), so we cover every known agent, every
 * precedence branch of `buildStartArgs`, and the bare-command predicate.
 */

import { describe, it, expect } from 'vitest';
import {
  KNOWN_AGENTS,
  buildStartArgs,
  isAgentShorthand,
  isBareCommand,
} from '@/cli/agentShorthand';

describe('KNOWN_AGENTS', () => {
  it('exposes exactly the 11 supported agents', () => {
    expect(KNOWN_AGENTS).toEqual([
      'claude',
      'codex',
      'gemini',
      'opencode',
      'aider',
      'goose',
      'amp',
      'crush',
      'kilo',
      'kiro',
      'droid',
    ]);
  });
});

describe('isAgentShorthand', () => {
  it.each(KNOWN_AGENTS.map((a) => [a]))('returns true for known agent %s', (agent) => {
    expect(isAgentShorthand(agent)).toBe(true);
  });

  it('returns false for non-agent commands', () => {
    expect(isAgentShorthand('start')).toBe(false);
    expect(isAgentShorthand('status')).toBe(false);
    expect(isAgentShorthand('onboard')).toBe(false);
    expect(isAgentShorthand('help')).toBe(false);
  });

  it('returns false for undefined and empty string', () => {
    expect(isAgentShorthand(undefined)).toBe(false);
    expect(isAgentShorthand('')).toBe(false);
  });

  it('is case-sensitive (uppercase is NOT a shorthand)', () => {
    expect(isAgentShorthand('Claude')).toBe(false);
    expect(isAgentShorthand('CODEX')).toBe(false);
  });
});

describe('isBareCommand', () => {
  it('returns true for undefined and empty string', () => {
    expect(isBareCommand(undefined)).toBe(true);
    expect(isBareCommand('')).toBe(true);
  });

  it('returns false for any populated command', () => {
    expect(isBareCommand('start')).toBe(false);
    expect(isBareCommand('claude')).toBe(false);
  });
});

describe('buildStartArgs', () => {
  it('uses shorthand as --agent and drops argv[0]', () => {
    expect(buildStartArgs(['codex', '--project', '.'], 'codex', null))
      .toEqual(['--agent', 'codex', '--project', '.']);
  });

  it('shorthand takes precedence over config default', () => {
    expect(buildStartArgs(['gemini'], 'gemini', 'claude'))
      .toEqual(['--agent', 'gemini']);
  });

  it('falls back to config default when no shorthand', () => {
    expect(buildStartArgs([], null, 'opencode'))
      .toEqual(['--agent', 'opencode']);
  });

  it('prepends config default in front of existing argv', () => {
    expect(buildStartArgs(['--project', '.'], null, 'aider'))
      .toEqual(['--agent', 'aider', '--project', '.']);
  });

  it('returns raw args when no shorthand and no config default', () => {
    expect(buildStartArgs(['--project', '.'], null, null))
      .toEqual(['--project', '.']);
  });

  it('returns empty array when no shorthand, no config, no args', () => {
    expect(buildStartArgs([], null, null)).toEqual([]);
  });

  it('treats undefined config default the same as null', () => {
    expect(buildStartArgs(['-p', '.'], null, undefined))
      .toEqual(['-p', '.']);
  });

  it('does not mutate the input array', () => {
    const input = ['codex', '--project', '.'];
    buildStartArgs(input, 'codex', null);
    expect(input).toEqual(['codex', '--project', '.']);
  });
});
