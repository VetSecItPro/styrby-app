/**
 * Tests for the Phase 0.3 additions to {@link StreamingAgentBackendBase}:
 *
 * - `formatInstallHint()` returns a per-agent friendly install message.
 * - `streamLines()` yields one callback per line, ignores trailing newlines,
 *   and closes the readline interface when the upstream stream ends.
 * - `attachInstallHintErrorHandler()` distinguishes ENOENT from other errors.
 *
 * These tests do NOT spawn subprocesses; they exercise the helpers against
 * synthetic streams and event emitters.
 *
 * @module agent/__tests__/streamingAgentBackendBase
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import {
  StreamingAgentBackendBase,
  formatInstallHint,
} from '../StreamingAgentBackendBase';
import type { SessionId, StartSessionResult } from '../core';

vi.mock('@/ui/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/**
 * Minimal concrete subclass for testing the protected helpers.
 * Exposes the protected methods publicly so tests can drive them directly.
 */
class TestBackend extends StreamingAgentBackendBase {
  protected readonly logTag = 'TestBackend';
  async startSession(): Promise<StartSessionResult> {
    return { sessionId: 'test-session' };
  }
  async sendPrompt(_id: SessionId, _p: string): Promise<void> {}
  async cancel(_id: SessionId): Promise<void> {}

  /** Public proxy for tests. */
  public testStreamLines(stream: PassThrough, cb: (line: string) => void) {
    return this.streamLines(stream, cb);
  }
  /** Public proxy for tests. */
  public testAttachError(
    child: ChildProcess,
    cmd: string,
    reject: (e: Error) => void,
  ) {
    this.attachInstallHintErrorHandler(child, cmd, reject);
  }
  /** Expose emitted messages for assertions. */
  public emitted: unknown[] = [];
  constructor() {
    super();
    this.onMessage((m) => this.emitted.push(m));
  }
}

describe('formatInstallHint', () => {
  it('returns a friendly hint for known agents', () => {
    expect(formatInstallHint('aider')).toContain('Aider');
    expect(formatInstallHint('aider')).toContain('pip install');
    expect(formatInstallHint('amp')).toContain('Amp');
    expect(formatInstallHint('crush')).toContain('Crush');
    expect(formatInstallHint('opencode').toLowerCase()).toContain('opencode');
  });

  it('falls back to a generic hint for unknown agents', () => {
    const msg = formatInstallHint('mystery');
    expect(msg).toContain('Mystery');
    expect(msg).toContain('not installed');
  });

  it('is case-insensitive on lookup but capitalises display', () => {
    expect(formatInstallHint('AIDER').startsWith('AIDER')).toBe(true);
  });
});

describe('streamLines', () => {
  it('emits one callback per line and strips trailing newlines', async () => {
    const backend = new TestBackend();
    const stream = new PassThrough();
    const lines: string[] = [];
    backend.testStreamLines(stream, (l) => lines.push(l));

    stream.write('first line\nsecond line\nthird');
    stream.end();

    // Allow readline to flush.
    await new Promise((r) => setImmediate(r));
    expect(lines).toEqual(['first line', 'second line', 'third']);
  });

  it('closes the readline interface when the upstream stream ends', async () => {
    const backend = new TestBackend();
    const stream = new PassThrough();
    const rl = backend.testStreamLines(stream, () => {});
    const closed = vi.fn();
    rl.on('close', closed);

    stream.end();
    await new Promise((r) => setImmediate(r));
    expect(closed).toHaveBeenCalled();
  });

  it('does not crash when the user callback throws', async () => {
    const backend = new TestBackend();
    const stream = new PassThrough();
    backend.testStreamLines(stream, () => {
      throw new Error('boom');
    });

    stream.write('line\n');
    stream.end();
    await new Promise((r) => setImmediate(r));
    // No assertion needed; test passes if no unhandled rejection.
  });
});

describe('attachInstallHintErrorHandler', () => {
  it('rejects with the install hint when err.code === ENOENT', async () => {
    const backend = new TestBackend();
    const child = new EventEmitter() as ChildProcess;
    let rejected: Error | undefined;
    backend.testAttachError(child, 'aider', (e) => {
      rejected = e;
    });

    const err = new Error('spawn aider ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    child.emit('error', err);

    expect(rejected?.message).toMatch(/Aider is not installed/);
    const status = backend.emitted.find(
      (m: any) => m.type === 'status' && m.status === 'error',
    ) as any;
    expect(status.detail).toMatch(/pip install/);
  });

  it('forwards non-ENOENT errors verbatim', async () => {
    const backend = new TestBackend();
    const child = new EventEmitter() as ChildProcess;
    let rejected: Error | undefined;
    backend.testAttachError(child, 'aider', (e) => {
      rejected = e;
    });

    child.emit('error', new Error('EPERM: denied'));

    expect(rejected?.message).toBe('EPERM: denied');
  });
});
