/**
 * Unit tests for `cli/helpScreen`.
 *
 * The help screen is user-facing documentation: broken formatting or
 * missing commands are visible bugs. These tests guard against silent
 * drift (e.g. a command being dropped from the help while still routed).
 */

import { describe, it, expect, vi } from 'vitest';
import { buildHelpText, printHelp } from '@/cli/helpScreen';
import { VERSION } from '@/cli/version';

describe('buildHelpText', () => {
  const help = buildHelpText();

  it('includes the current CLI version in the header', () => {
    expect(help).toContain(`styrby v${VERSION}`);
  });

  it('documents every top-level command that the router dispatches', () => {
    const commands = [
      'onboard',
      'auth',
      'pair',
      'install',
      'start',
      'stop',
      'status',
      'logs',
      'costs',
      'template',
      'export',
      'import',
      'checkpoint',
      'daemon',
      'upgrade',
      'doctor',
      'help',
      'version',
    ];

    for (const cmd of commands) {
      expect(help).toContain(cmd);
    }
  });

  it('lists every supported agent in the Options section', () => {
    // All five agents must be mentioned so users know what to pass to --agent.
    expect(help).toMatch(/claude .+codex.+gemini.+opencode.+aider/s);
  });

  it('documents the standard exit codes', () => {
    expect(help).toContain('0    Success');
    expect(help).toContain('1    General error');
    expect(help).toContain('2    Invalid arguments');
    expect(help).toContain('130  Interrupted');
  });

  it('includes the homepage, source, and issues links', () => {
    expect(help).toContain('https://styrbyapp.com');
    expect(help).toContain('https://github.com/VetSecItPro/styrby-app');
    expect(help).toContain('https://github.com/VetSecItPro/styrby-app/issues');
  });

  it('documents the main environment variables', () => {
    expect(help).toContain('STYRBY_LOG_LEVEL');
    expect(help).toContain('ANTHROPIC_API_KEY');
    expect(help).toContain('OPENAI_API_KEY');
    expect(help).toContain('GEMINI_API_KEY');
  });

  it('begins and ends with a newline so it renders with breathing room', () => {
    expect(help.startsWith('\n')).toBe(true);
    expect(help.endsWith('\n')).toBe(true);
  });
});

describe('printHelp', () => {
  it('writes the built help text to stdout', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      printHelp();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toBe(buildHelpText());
    } finally {
      spy.mockRestore();
    }
  });
});
