/**
 * Unit tests for CLI Sentry initialization.
 *
 * @sentry/node is mocked entirely — no real SDK calls, no network traffic.
 * Tests verify: mute switch, DSN resolution, noise filter, process handlers.
 *
 * WHY vi.hoisted(): vitest hoists vi.mock() calls to the top of the file at
 * transform time, which means the mock factory runs before any const declarations
 * in module scope. Using vi.hoisted() ensures the mock fns are created in the
 * hoisted zone so the vi.mock() factory can safely reference them.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mock functions (must be declared before vi.mock calls) ───────────
const { mockSentryInit, mockAddBreadcrumb, mockCaptureException, mockReadFileSync } = vi.hoisted(() => ({
  mockSentryInit: vi.fn(),
  mockAddBreadcrumb: vi.fn(),
  mockCaptureException: vi.fn().mockReturnValue('fake-event-id'),
  mockReadFileSync: vi.fn(),
}));

// ── Mock @sentry/node before importing the module under test ────────────────
vi.mock('@sentry/node', () => ({
  init: mockSentryInit,
  addBreadcrumb: mockAddBreadcrumb,
  captureException: mockCaptureException,
}));

// ── Mock node:fs to control config.json reading ─────────────────────────────
vi.mock('node:fs', () => ({ readFileSync: mockReadFileSync }));

// ── Import after mocks ────────────────────────────────────────────────────────
import { initSentry, getSentryAdapter } from '../sentry.js';

// ============================================================================
// Tests
// ============================================================================

describe('initSentry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: config.json not found
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    // Default environment
    delete process.env.STYRBY_SENTRY_DSN;
    delete process.env.STYRBY_SENTRY_MUTED;
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    // Remove any process listeners added by initSentry
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
  });

  it('calls Sentry.init with the env var DSN', () => {
    process.env.STYRBY_SENTRY_DSN = 'https://key@sentry.io/123';

    initSentry();

    expect(mockSentryInit).toHaveBeenCalledWith(
      expect.objectContaining({ dsn: 'https://key@sentry.io/123' })
    );
  });

  it('falls back to DSN from config.json when env var is absent', () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ sentry: { dsn: 'https://cfg@sentry.io/999' } })
    );

    initSentry();

    expect(mockSentryInit).toHaveBeenCalledWith(
      expect.objectContaining({ dsn: 'https://cfg@sentry.io/999' })
    );
  });

  it('passes undefined DSN when neither env var nor config.json provides one', () => {
    initSentry();

    const { dsn } = mockSentryInit.mock.calls[0][0] as { dsn: unknown };
    expect(dsn).toBeUndefined();
  });

  it('sets enabled=false when STYRBY_SENTRY_MUTED=true', () => {
    process.env.STYRBY_SENTRY_MUTED = 'true';
    process.env.STYRBY_SENTRY_DSN = 'https://key@sentry.io/1';

    initSentry();

    const { enabled } = mockSentryInit.mock.calls[0][0] as { enabled: boolean };
    expect(enabled).toBe(false);
  });

  it('sets enabled=false when config.json sentry.muted=true', () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ sentry: { muted: true } })
    );
    process.env.STYRBY_SENTRY_DSN = 'https://key@sentry.io/1';

    initSentry();

    const { enabled } = mockSentryInit.mock.calls[0][0] as { enabled: boolean };
    expect(enabled).toBe(false);
  });

  it('sets enabled=false in development mode', () => {
    process.env.NODE_ENV = 'development';
    process.env.STYRBY_SENTRY_DSN = 'https://key@sentry.io/1';

    initSentry();

    const { enabled } = mockSentryInit.mock.calls[0][0] as { enabled: boolean };
    expect(enabled).toBe(false);
  });

  it('registers uncaughtException handler', () => {
    initSentry();
    expect(process.listenerCount('uncaughtException')).toBeGreaterThan(0);
  });

  it('registers unhandledRejection handler', () => {
    initSentry();
    expect(process.listenerCount('unhandledRejection')).toBeGreaterThan(0);
  });

  it('unhandledRejection handler captures non-Error reasons as Error', () => {
    initSentry();

    const handler = process.listeners('unhandledRejection')[0] as (reason: unknown) => void;
    handler('bare string reason');

    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { handler: 'unhandledRejection' } })
    );
  });
});

describe('getSentryAdapter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns an adapter with addBreadcrumb and captureException', () => {
    const adapter = getSentryAdapter();
    expect(typeof adapter.addBreadcrumb).toBe('function');
    expect(typeof adapter.captureException).toBe('function');
  });

  it('addBreadcrumb delegates to Sentry.addBreadcrumb', () => {
    const adapter = getSentryAdapter();
    const bc = { level: 'info' as const, message: 'test' };
    adapter.addBreadcrumb(bc);
    expect(mockAddBreadcrumb).toHaveBeenCalledWith(bc);
  });

  it('captureException delegates to Sentry.captureException', () => {
    const adapter = getSentryAdapter();
    const err = new Error('test');
    const id = adapter.captureException(err, { tags: { foo: 'bar' } });
    expect(mockCaptureException).toHaveBeenCalledWith(err, { tags: { foo: 'bar' } });
    expect(id).toBe('fake-event-id');
  });
});
