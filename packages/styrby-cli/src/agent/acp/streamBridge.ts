/**
 * Stream bridging utilities for the ACP backend.
 *
 * WHY: The ACP SDK consumes WHATWG Web Streams (ReadableStream / WritableStream)
 * but Node.js child processes expose classic Node streams. We bridge them
 * here so the backend can drive a subprocess via the SDK transparently.
 *
 * We also wrap the resulting readable in a *line-aware filter* so transport
 * handlers (Gemini CLI in particular) can drop debug output that would
 * otherwise crash JSON-RPC parsing.
 */

import { Readable, Writable } from 'node:stream';
import { logger } from '@/ui/logger';
import type { TransportHandler } from '../transport';

/**
 * Bridge a Node child-process stdio pair to WHATWG Web Streams.
 *
 * NOTE: This function registers a `data` listener on `stdout`. If callers
 * also attach their own `data` listener the chunk will be delivered to both,
 * which is fine but worth knowing.
 *
 * @param stdin  - The child's writable stdin stream.
 * @param stdout - The child's readable stdout stream.
 * @returns A `{ writable, readable }` pair of Web Streams.
 */
export function nodeToWebStreams(
  stdin: Writable,
  stdout: Readable
): { writable: WritableStream<Uint8Array>; readable: ReadableStream<Uint8Array> } {
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise((resolve, reject) => {
        const ok = stdin.write(chunk, (err) => {
          if (err) {
            logger.debug(`[AcpBackend] Error writing to stdin:`, err);
            reject(err);
          }
        });
        if (ok) {
          resolve();
        } else {
          // WHY: Backpressure — wait for the kernel buffer to drain before
          // resolving so the SDK doesn't outpace the subprocess.
          stdin.once('drain', resolve);
        }
      });
    },
    close() {
      return new Promise((resolve) => {
        stdin.end(resolve);
      });
    },
    abort(reason) {
      stdin.destroy(reason instanceof Error ? reason : new Error(String(reason)));
    },
  });

  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      stdout.on('data', (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
      });
      stdout.on('end', () => {
        controller.close();
      });
      stdout.on('error', (err) => {
        logger.debug(`[AcpBackend] Stdout error:`, err);
        controller.error(err);
      });
    },
    cancel() {
      stdout.destroy();
    },
  });

  return { writable, readable };
}

/**
 * Wrap a raw stdout ReadableStream with a transport-driven, line-aware filter.
 *
 * WHY: Some agents (notably Gemini CLI) emit non-JSON lines to stdout
 * (experiment flags, banner output). Those lines crash the JSON-RPC ndjson
 * parser. The transport's `filterStdoutLine` returns:
 *   - `null`      → drop the line
 *   - `string`    → replace the line with this content
 *   - `undefined` → method not implemented, pass the line through unchanged
 *
 * @param readable  - The raw byte stream from the child process.
 * @param transport - Transport handler whose `filterStdoutLine` (if any) we apply.
 * @returns A filtered ReadableStream safe to feed to `ndJsonStream`.
 */
export function createFilteredStdoutStream(
  readable: ReadableStream<Uint8Array>,
  transport: TransportHandler
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = readable.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let buffer = '';
      let filteredCount = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            // WHY: On EOF the agent may have left a line without trailing \n.
            // We must still apply the filter (or pass through) so the parser
            // sees the final record.
            if (buffer.trim()) {
              const filtered = transport.filterStdoutLine?.(buffer);
              if (filtered === undefined) {
                controller.enqueue(encoder.encode(buffer));
              } else if (filtered !== null) {
                controller.enqueue(encoder.encode(filtered));
              } else {
                filteredCount++;
              }
            }
            if (filteredCount > 0) {
              logger.debug(
                `[AcpBackend] Filtered out ${filteredCount} non-JSON lines from ${transport.agentName} stdout`
              );
            }
            controller.close();
            break;
          }

          buffer += decoder.decode(value, { stream: true });

          // ndJSON is line-delimited: split, reserve any trailing partial
          // line for the next chunk so we never break a record mid-stream.
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;

            const filtered = transport.filterStdoutLine?.(line);
            if (filtered === undefined) {
              controller.enqueue(encoder.encode(line + '\n'));
            } else if (filtered !== null) {
              controller.enqueue(encoder.encode(filtered + '\n'));
            } else {
              filteredCount++;
            }
          }
        }
      } catch (error) {
        logger.debug(`[AcpBackend] Error filtering stdout stream:`, error);
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
  });
}
