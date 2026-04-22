/**
 * Unit tests for the structured Logger class.
 *
 * All Sentry SDK calls are mocked via a SentryAdapter spy — no real network
 * traffic is generated.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger, type SentryAdapter, type LogEntry } from '../structuredLogger.js';

// ============================================================================
// Helpers
// ============================================================================

/** Collect JSON-line output into an array of parsed entries. */
function makeCollector(): { entries: LogEntry[]; writeFn: (line: string) => void } {
  const entries: LogEntry[] = [];
  return {
    entries,
    writeFn: (line: string) => entries.push(JSON.parse(line) as LogEntry),
  };
}

/** Build a spy SentryAdapter. */
function makeSentryAdapter(): SentryAdapter & {
  breadcrumbs: Parameters<SentryAdapter['addBreadcrumb']>[0][];
  captured: unknown[];
} {
  const breadcrumbs: Parameters<SentryAdapter['addBreadcrumb']>[0][] = [];
  const captured: unknown[] = [];
  return {
    breadcrumbs,
    captured,
    addBreadcrumb: (b) => { breadcrumbs.push(b); },
    captureException: (e) => { captured.push(e); return 'fake-id'; },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Logger', () => {
  describe('output format', () => {
    it('emits JSON-line entries with required fields', () => {
      const { entries, writeFn } = makeCollector();
      const log = new Logger({ writeFn });

      log.info('hello world', { userId: 'u1' });

      expect(entries).toHaveLength(1);
      const [entry] = entries;
      expect(entry.level).toBe('info');
      expect(entry.message).toBe('hello world');
      expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(entry.context.userId).toBe('u1');
      expect(typeof entry.context.traceId).toBe('string');
    });

    it('auto-generates a stable traceId for the instance lifetime', () => {
      const { entries, writeFn } = makeCollector();
      const log = new Logger({ writeFn });

      log.info('a');
      log.info('b');

      expect(entries[0].context.traceId).toBe(entries[1].context.traceId);
    });

    it('accepts caller-provided traceId and propagates it', () => {
      const { entries, writeFn } = makeCollector();
      const log = new Logger({ writeFn });

      log.info('traced', { traceId: 'my-trace' });

      expect(entries[0].context.traceId).toBe('my-trace');
    });

    it('emits all log levels: debug, info, warn, error', () => {
      const { entries, writeFn } = makeCollector();
      const log = new Logger({ writeFn, minLevel: 'debug' });

      log.debug('d');
      log.info('i');
      log.warn('w');
      log.error('e');

      expect(entries.map((e) => e.level)).toEqual(['debug', 'info', 'warn', 'error']);
    });
  });

  describe('minLevel filtering', () => {
    it('drops entries below minLevel', () => {
      const { entries, writeFn } = makeCollector();
      const log = new Logger({ writeFn, minLevel: 'info' });

      log.debug('ignored');
      log.info('kept');

      expect(entries).toHaveLength(1);
      expect(entries[0].message).toBe('kept');
    });

    it('emits exactly at minLevel', () => {
      const { entries, writeFn } = makeCollector();
      const log = new Logger({ writeFn, minLevel: 'warn' });

      log.warn('at boundary');
      log.error('above');

      expect(entries).toHaveLength(2);
    });
  });

  describe('Sentry integration', () => {
    it('sends error() to captureException', () => {
      const { entries, writeFn } = makeCollector();
      const sentry = makeSentryAdapter();
      const log = new Logger({ writeFn, sentry });
      const err = new Error('boom');

      log.error('something broke', { sessionId: 's1' }, err);

      expect(sentry.captured).toHaveLength(1);
      expect(sentry.captured[0]).toBe(err);
      // Log entry still emitted
      expect(entries[0].level).toBe('error');
    });

    it('wraps non-Error in new Error when capturing to Sentry', () => {
      const { writeFn } = makeCollector();
      const sentry = makeSentryAdapter();
      const log = new Logger({ writeFn, sentry });

      log.error('plain string error', {}, 'something');

      expect(sentry.captured[0]).toBeInstanceOf(Error);
    });

    it('sends warn() to addBreadcrumb with level "warning"', () => {
      const { writeFn } = makeCollector();
      const sentry = makeSentryAdapter();
      const log = new Logger({ writeFn, sentry });

      log.warn('reconnecting', { machineId: 'm1' });

      expect(sentry.breadcrumbs).toHaveLength(1);
      expect(sentry.breadcrumbs[0].level).toBe('warning');
      expect(sentry.breadcrumbs[0].message).toBe('reconnecting');
    });

    it('does NOT send info() or debug() to Sentry', () => {
      const { writeFn } = makeCollector();
      const sentry = makeSentryAdapter();
      const log = new Logger({ writeFn, sentry, minLevel: 'debug' });

      log.debug('debug msg');
      log.info('info msg');

      expect(sentry.breadcrumbs).toHaveLength(0);
      expect(sentry.captured).toHaveLength(0);
    });

    it('is silent when no sentry adapter provided', () => {
      const { writeFn } = makeCollector();
      const log = new Logger({ writeFn });

      // Must not throw even though no Sentry adapter
      expect(() => {
        log.error('no sentry', {}, new Error('x'));
        log.warn('also no sentry');
      }).not.toThrow();
    });

    it('setSentry() wires in a Sentry adapter after construction', () => {
      const { writeFn } = makeCollector();
      const log = new Logger({ writeFn });
      const sentry = makeSentryAdapter();

      // Before wiring — no calls
      log.error('before', {}, new Error('before'));
      expect(sentry.captured).toHaveLength(0);

      // After wiring — should capture
      log.setSentry(sentry);
      log.error('after', {}, new Error('after'));
      expect(sentry.captured).toHaveLength(1);
    });

    it('swallows Sentry failures silently', () => {
      const { writeFn } = makeCollector();
      const brokeSentry: SentryAdapter = {
        addBreadcrumb: () => { throw new Error('sentry down'); },
        captureException: () => { throw new Error('sentry down'); },
      };
      const log = new Logger({ writeFn, sentry: brokeSentry });

      // Must not throw
      expect(() => {
        log.warn('warn during sentry outage');
        log.error('error during sentry outage', {}, new Error('x'));
      }).not.toThrow();
    });
  });

  describe('correlation fields', () => {
    it('includes all standard correlation fields in context', () => {
      const { entries, writeFn } = makeCollector();
      const log = new Logger({ writeFn });

      log.info('session started', {
        sessionId: 'sess-1',
        userId: 'user-1',
        machineId: 'machine-1',
        agent: 'claude',
      });

      const ctx = entries[0].context;
      expect(ctx.sessionId).toBe('sess-1');
      expect(ctx.userId).toBe('user-1');
      expect(ctx.machineId).toBe('machine-1');
      expect(ctx.agent).toBe('claude');
    });

    it('getTraceId() returns the instance trace ID', () => {
      const log = new Logger();
      expect(typeof log.getTraceId()).toBe('string');
      expect(log.getTraceId().length).toBeGreaterThan(10);
    });
  });

  describe('write failures', () => {
    it('silently swallows errors from the write function', () => {
      const log = new Logger({ writeFn: () => { throw new Error('disk full'); } });
      expect(() => log.info('msg')).not.toThrow();
    });
  });
});
