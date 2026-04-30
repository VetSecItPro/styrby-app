/**
 * Unit tests for mobile Sentry initialization.
 *
 * @sentry/react-native is mocked entirely — no real SDK calls, no network.
 * Tests verify: mute switch, noise filter, __DEV__ gate, adapter factory.
 *
 * WHY overrides parameter instead of process.env:
 * Expo's `babel-preset-expo` applies `babel-plugin-transform-inline-
 * environment-variables`, which inlines `process.env.EXPO_PUBLIC_*` values at
 * Babel transform / cache time. Mutating process.env between Jest tests has no
 * effect because the compiled code already has the values baked in.
 *
 * `initMobileSentry` accepts an optional `overrides` parameter that lets test
 * code inject DSN, mute-switch, and dev-flag values without relying on
 * compile-time env var inlining.
 */

jest.mock('@sentry/react-native', () => ({
  init: jest.fn(),
  addBreadcrumb: jest.fn(),
  captureException: jest.fn().mockReturnValue('fake-event-id'),
}));

// We also mock @styrby/shared/logging to avoid pulling in the real logger.
jest.mock('@styrby/shared/logging', () => ({
  Logger: jest.fn().mockImplementation(() => ({})),
}));

import { initMobileSentry, getMobileSentryAdapter } from '../sentry';

// Retrieve bound mock references after registration.
const SentryMock = jest.requireMock('@sentry/react-native') as {
  init: jest.Mock;
  addBreadcrumb: jest.Mock;
  captureException: jest.Mock;
};

// ============================================================================
// Setup
// ============================================================================

beforeEach(() => {
  jest.clearAllMocks();
});

// ============================================================================
// Tests
// ============================================================================

describe('initMobileSentry', () => {
  it('calls Sentry.init with the provided DSN', () => {
    initMobileSentry({ dsn: 'https://key@sentry.io/456', isDev: false, muted: false });

    expect(SentryMock.init).toHaveBeenCalledWith(
      expect.objectContaining({ dsn: 'https://key@sentry.io/456' })
    );
  });

  it('sets enabled=false when muted=true', () => {
    initMobileSentry({ dsn: 'https://key@sentry.io/1', muted: true, isDev: false });

    const { enabled } = SentryMock.init.mock.calls[0][0] as { enabled: boolean };
    expect(enabled).toBe(false);
  });

  it('sets enabled=false when isDev=true', () => {
    initMobileSentry({ dsn: 'https://key@sentry.io/1', isDev: true, muted: false });

    const { enabled } = SentryMock.init.mock.calls[0][0] as { enabled: boolean };
    expect(enabled).toBe(false);
  });

  it('sets enabled=true in production build when not muted', () => {
    initMobileSentry({ dsn: 'https://key@sentry.io/1', isDev: false, muted: false });

    const { enabled } = SentryMock.init.mock.calls[0][0] as { enabled: boolean };
    expect(enabled).toBe(true);
  });

  it('passes beforeSend that drops ResizeObserver noise', () => {
    initMobileSentry({ isDev: false, muted: false });

    const { beforeSend } = SentryMock.init.mock.calls[0][0] as {
      beforeSend: (event: Record<string, unknown>, hint: { originalException?: Error }) => unknown;
    };

    const noiseEvent = { message: '' };
    const noiseHint = { originalException: new Error('ResizeObserver loop limit exceeded') };
    expect(beforeSend(noiseEvent, noiseHint)).toBeNull();
  });

  it('passes beforeSend that allows real errors through', () => {
    initMobileSentry({ isDev: false, muted: false });

    const { beforeSend } = SentryMock.init.mock.calls[0][0] as {
      beforeSend: (event: Record<string, unknown>, hint: { originalException?: Error }) => unknown;
    };

    const realEvent = { message: 'session relay error' };
    const realHint = { originalException: new Error('session relay error') };
    expect(beforeSend(realEvent, realHint)).toBe(realEvent);
  });
});

describe('getMobileSentryAdapter', () => {
  it('returns an adapter with addBreadcrumb and captureException', () => {
    const adapter = getMobileSentryAdapter();
    expect(typeof adapter.addBreadcrumb).toBe('function');
    expect(typeof adapter.captureException).toBe('function');
  });

  it('addBreadcrumb delegates to Sentry.addBreadcrumb', () => {
    const adapter = getMobileSentryAdapter();
    const bc = { level: 'warning' as const, message: 'relay reconnecting' };
    adapter.addBreadcrumb(bc);
    expect(SentryMock.addBreadcrumb).toHaveBeenCalledWith(bc);
  });

  it('captureException delegates to Sentry.captureException', () => {
    const adapter = getMobileSentryAdapter();
    const err = new Error('crash');
    const id = adapter.captureException(err);
    expect(SentryMock.captureException).toHaveBeenCalledWith(err, undefined);
    expect(id).toBe('fake-event-id');
  });
});
