/**
 * Tests for `buildFirstMessagePrompt` and `promptContainsChangeTitle`.
 *
 * The first-message format must match Codex byte-for-byte (system prompt
 * BEFORE user message, change_title instruction AFTER) — a regression here
 * silently breaks mobile session-title generation.
 */
import { describe, it, expect } from 'vitest';
import {
  buildFirstMessagePrompt,
  promptContainsChangeTitle,
} from '@/gemini/utils/promptBuilder';
import { CHANGE_TITLE_INSTRUCTION } from '@/gemini/constants';

describe('buildFirstMessagePrompt', () => {
  it('returns user message unchanged when no system prompt provided', () => {
    expect(
      buildFirstMessagePrompt({ userMessage: 'hi there' }),
    ).toBe('hi there');
  });

  it('returns user message unchanged when system prompt is empty string', () => {
    expect(
      buildFirstMessagePrompt({ userMessage: 'hi', appendSystemPrompt: '' }),
    ).toBe('hi');
  });

  it('orders parts as system + user + change_title with double-newlines', () => {
    const r = buildFirstMessagePrompt({
      userMessage: 'USERMSG',
      appendSystemPrompt: 'SYSPROMPT',
    });
    expect(r).toBe(`SYSPROMPT\n\nUSERMSG\n\n${CHANGE_TITLE_INSTRUCTION}`);
  });

  it('places change_title AFTER the user message (Codex parity)', () => {
    const r = buildFirstMessagePrompt({
      userMessage: 'do thing',
      appendSystemPrompt: 'be helpful',
    });
    expect(r.indexOf('do thing')).toBeLessThan(r.indexOf(CHANGE_TITLE_INSTRUCTION));
    expect(r.indexOf('be helpful')).toBeLessThan(r.indexOf('do thing'));
  });
});

describe('promptContainsChangeTitle', () => {
  it('detects bare change_title', () => {
    expect(promptContainsChangeTitle('please change_title now')).toBe(true);
  });

  it('detects MCP-prefixed happy__change_title', () => {
    expect(promptContainsChangeTitle('use happy__change_title tool')).toBe(true);
  });

  it('returns false when neither token is present', () => {
    expect(promptContainsChangeTitle('hello world')).toBe(false);
  });

  it('returns true for prompt built via buildFirstMessagePrompt with sysprompt', () => {
    const built = buildFirstMessagePrompt({
      userMessage: 'task',
      appendSystemPrompt: 'sys',
    });
    expect(promptContainsChangeTitle(built)).toBe(true);
  });
});
