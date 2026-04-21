/**
 * Tests for agent/acp/streamBridge.ts
 *
 * Covers:
 * - nodeToWebStreams: writable → Node stdin, readable from Node stdout,
 *   stdout end closes readable, stdout error surfaces in readable
 * - createFilteredStdoutStream: lines are filtered/passed/replaced via
 *   transport.filterStdoutLine, partial lines are buffered across chunks,
 *   EOF trailing line is flushed, undefined return passes line through,
 *   null drops the line, string replaces the line
 *
 * WHY: streamBridge is the boundary between the ACP SDK (WHATWG Web Streams)
 * and Node child_process streams. Bugs here corrupt the JSON-RPC ndjson
 * parser which crashes sessions silently on mobile.
 *
 * @module agent/acp/__tests__/streamBridge
 */

import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { nodeToWebStreams, createFilteredStdoutStream } from '../streamBridge';
import type { TransportHandler } from '../../transport';

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a transport double whose filterStdoutLine behaviour is controlled
 * per-test via the supplied callback.
 *
 * @param filter - Maps a line to: string (replace), null (drop), undefined (pass-through).
 */
function makeTransport(
  filter?: (line: string) => string | null | undefined,
): TransportHandler {
  return {
    agentName: 'test',
    getInitTimeout: () => 60_000,
    filterStdoutLine: filter,
    handleStderr: () => ({ message: null }),
    getToolPatterns: () => [],
    isInvestigationTool: () => false,
    getToolCallTimeout: () => 120_000,
    extractToolNameFromId: () => null,
    determineToolName: (name) => name,
  };
}

/**
 * Drain a WHATWG ReadableStream into a single concatenated string.
 */
async function drainReadable(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value);
  }
  return result;
}

// ===========================================================================
// nodeToWebStreams
// ===========================================================================

describe('nodeToWebStreams', () => {
  it('returns an object with writable and readable properties', () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const { writable, readable } = nodeToWebStreams(stdin, stdout);

    expect(writable).toBeInstanceOf(WritableStream);
    expect(readable).toBeInstanceOf(ReadableStream);
  });

  it('writes data to Node stdin when the WHATWG writable is written to', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const { writable } = nodeToWebStreams(stdin, stdout);

    // Collect bytes written to the PassThrough stdin
    const received: Buffer[] = [];
    stdin.on('data', (chunk: Buffer) => received.push(chunk));

    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    await writer.write(encoder.encode('hello'));
    await writer.close();

    await new Promise((r) => setImmediate(r));
    const text = Buffer.concat(received).toString();
    expect(text).toBe('hello');
  });

  it('readable emits chunks pushed to Node stdout', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const { readable } = nodeToWebStreams(stdin, stdout);

    // Push data to stdout before the reader starts consuming — data events
    // buffer in the ReadableStream controller.
    const drainPromise = drainReadable(readable);
    stdout.write('chunk1');
    stdout.write('chunk2');
    stdout.end();

    const text = await drainPromise;
    expect(text).toContain('chunk1');
    expect(text).toContain('chunk2');
  });

  it('closes the readable when stdout emits end', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const { readable } = nodeToWebStreams(stdin, stdout);

    const drainPromise = drainReadable(readable);
    stdout.end();

    // Should resolve without hanging
    await expect(drainPromise).resolves.toBeDefined();
  });

  it('errors the readable when stdout emits an error', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const { readable } = nodeToWebStreams(stdin, stdout);

    const drainPromise = drainReadable(readable);
    const err = new Error('stdout broke');
    stdout.emit('error', err);

    await expect(drainPromise).rejects.toThrow('stdout broke');
  });
});

// ===========================================================================
// createFilteredStdoutStream
// ===========================================================================

describe('createFilteredStdoutStream', () => {
  it('passes lines through when filterStdoutLine returns undefined (method absent)', async () => {
    // WHY: undefined means the transport does not implement filterStdoutLine at all.
    const transportWithoutFilter = makeTransport(undefined);
    // Ensure the property is absent (not just undefined-returning)
    delete (transportWithoutFilter as any).filterStdoutLine;

    const encoder = new TextEncoder();
    const raw = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(encoder.encode('line1\nline2\n'));
        ctrl.close();
      },
    });

    const filtered = createFilteredStdoutStream(raw, transportWithoutFilter);
    const text = await drainReadable(filtered);
    expect(text).toContain('line1');
    expect(text).toContain('line2');
  });

  it('drops lines where filterStdoutLine returns null', async () => {
    // WHY: null = this line is debug noise (e.g. Gemini CLI banner), drop it.
    const transport = makeTransport((line) => (line.startsWith('{') ? line : null));
    const encoder = new TextEncoder();

    const raw = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(encoder.encode('banner output\n{"valid":"json"}\n'));
        ctrl.close();
      },
    });

    const filtered = createFilteredStdoutStream(raw, transport);
    const text = await drainReadable(filtered);
    expect(text).not.toContain('banner output');
    expect(text).toContain('{"valid":"json"}');
  });

  it('replaces lines when filterStdoutLine returns a string', async () => {
    const transport = makeTransport((_line) => '{"replaced":true}');
    const encoder = new TextEncoder();

    const raw = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(encoder.encode('original\n'));
        ctrl.close();
      },
    });

    const filtered = createFilteredStdoutStream(raw, transport);
    const text = await drainReadable(filtered);
    expect(text).toContain('{"replaced":true}');
    expect(text).not.toContain('original');
  });

  it('buffers partial lines across chunk boundaries', async () => {
    // WHY: ndjson parser requires complete lines. If a chunk splits mid-line
    // the bridge must hold the partial line and flush it on the next chunk.
    const transport = makeTransport((line) => line); // pass-through
    const encoder = new TextEncoder();

    const raw = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(encoder.encode('partial'));
        ctrl.enqueue(encoder.encode('-line\n'));
        ctrl.close();
      },
    });

    const filtered = createFilteredStdoutStream(raw, transport);
    const text = await drainReadable(filtered);
    expect(text).toContain('partial-line');
  });

  it('flushes a trailing line without newline on EOF', async () => {
    // WHY: The last ndjson record from an agent may not have a trailing \n.
    // createFilteredStdoutStream must flush it on done so the parser sees it.
    const transport = makeTransport((line) => line);
    const encoder = new TextEncoder();

    const raw = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(encoder.encode('{"last":true}'));
        ctrl.close();
      },
    });

    const filtered = createFilteredStdoutStream(raw, transport);
    const text = await drainReadable(filtered);
    expect(text).toContain('{"last":true}');
  });

  it('skips blank lines (whitespace-only)', async () => {
    const emitted: string[] = [];
    const transport = makeTransport((line) => {
      emitted.push(line);
      return line;
    });
    const encoder = new TextEncoder();

    const raw = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(encoder.encode('  \n\nreal-line\n'));
        ctrl.close();
      },
    });

    const filtered = createFilteredStdoutStream(raw, transport);
    await drainReadable(filtered);
    // Only non-blank lines reach filterStdoutLine
    expect(emitted.every((l) => l.trim().length > 0)).toBe(true);
  });

  it('handles multiple complete lines in a single chunk', async () => {
    const transport = makeTransport((line) => line);
    const encoder = new TextEncoder();

    const raw = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(encoder.encode('a\nb\nc\n'));
        ctrl.close();
      },
    });

    const filtered = createFilteredStdoutStream(raw, transport);
    const text = await drainReadable(filtered);
    expect(text).toContain('a\n');
    expect(text).toContain('b\n');
    expect(text).toContain('c\n');
  });
});
