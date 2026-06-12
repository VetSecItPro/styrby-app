/**
 * Tests for the chat message content parser (chat/message-content.ts).
 *
 * This pure logic was untested while embedded in ChatMessage.tsx; the Cluster
 * A2 split moved it out and these tests now pin its contract: fenced code
 * blocks, inline code, plain text, and the documented edge cases.
 *
 * @module components/chat/__tests__/message-content
 */

import { parseMessageContent, parseInlineCode } from '../message-content';

describe('parseInlineCode', () => {
  it('returns a single text segment for plain prose', () => {
    expect(parseInlineCode('just words')).toEqual([{ type: 'text', content: 'just words' }]);
  });

  it('splits inline code from surrounding text', () => {
    expect(parseInlineCode('use `npm ci` here')).toEqual([
      { type: 'text', content: 'use ' },
      { type: 'inline_code', content: 'npm ci' },
      { type: 'text', content: ' here' },
    ]);
  });

  it('handles back-to-back inline code', () => {
    expect(parseInlineCode('`a``b`')).toEqual([
      { type: 'inline_code', content: 'a' },
      { type: 'inline_code', content: 'b' },
    ]);
  });
});

describe('parseMessageContent', () => {
  it('returns [] for empty input', () => {
    expect(parseMessageContent('')).toEqual([]);
  });

  it('parses a plain text message as one text segment', () => {
    expect(parseMessageContent('hello world')).toEqual([{ type: 'text', content: 'hello world' }]);
  });

  it('extracts a fenced code block with its language', () => {
    const segments = parseMessageContent('before\n```ts\nconst x = 1;\n```\nafter');
    const code = segments.find((s) => s.type === 'code_block')!;
    expect(code).toBeDefined();
    expect(code.language).toBe('ts');
    expect(code.content).toContain('const x = 1;');
    // Surrounding prose is preserved as text segments.
    expect(segments.some((s) => s.type === 'text' && s.content.includes('before'))).toBe(true);
    expect(segments.some((s) => s.type === 'text' && s.content.includes('after'))).toBe(true);
  });

  it('treats a fence with no language as undefined language', () => {
    const code = parseMessageContent('```\nplain\n```').find((s) => s.type === 'code_block')!;
    expect(code.language).toBeUndefined();
    expect(code.content).toContain('plain');
  });

  it('drops an empty fenced block (renders as nothing useful)', () => {
    expect(parseMessageContent('```\n\n```')).toEqual([]);
  });

  it('does NOT treat backticks inside a fenced block as inline code', () => {
    const segments = parseMessageContent('```\nuse `x` inside\n```');
    // The only segment is the code block; no inline_code segment leaks out.
    expect(segments.filter((s) => s.type === 'inline_code')).toHaveLength(0);
    expect(segments.find((s) => s.type === 'code_block')!.content).toContain('`x`');
  });

  it('parses inline code in the prose around a fenced block', () => {
    const segments = parseMessageContent('run `ls`\n```sh\necho hi\n```');
    expect(segments.some((s) => s.type === 'inline_code' && s.content === 'ls')).toBe(true);
    expect(segments.some((s) => s.type === 'code_block' && s.content.includes('echo hi'))).toBe(true);
  });
});
