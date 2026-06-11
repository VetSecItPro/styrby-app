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

import { initMobileSentry, getMobileSentryAdapter, scrubSensitiveData } from '../sentry';

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

describe('scrubSensitiveData (SEC-MOB-004)', () => {
  it('redacts a JWT embedded in a string', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc-DEF_123';
    expect(scrubSensitiveData(`auth failed for ${jwt}`)).toBe('auth failed for [REDACTED]');
  });

  it('redacts bearer tokens, provider keys, styrby key values, and emails', () => {
    expect(scrubSensitiveData('Bearer abcdef123456')).toBe('[REDACTED]');
    expect(scrubSensitiveData('sk-ABCDEFGHIJKLMNOPQRST')).toBe('[REDACTED]');
    expect(scrubSensitiveData('key=styrby_aBcDeFgHiJkLmNoP')).toBe('key=[REDACTED]');
    expect(scrubSensitiveData('user ada@example.com crashed')).toBe('user [REDACTED] crashed');
  });

  it('scrubs nested event structures (message, breadcrumbs, contexts)', () => {
    const event = {
      message: 'token eyJabc.eyJdef.ghi-_',
      breadcrumbs: [{ message: 'sent to bob@styrby.app', data: { auth: 'Bearer secrettoken12345' } }],
      contexts: { http: { headers: { authorization: 'Bearer anothertoken99999' } } },
    };
    const scrubbed = scrubSensitiveData(event) as typeof event;
    expect(scrubbed.message).not.toContain('eyJ');
    expect(scrubbed.breadcrumbs[0].message).toBe('sent to [REDACTED]');
    expect(scrubbed.breadcrumbs[0].data.auth).toBe('[REDACTED]');
    expect(scrubbed.contexts.http.headers.authorization).toBe('[REDACTED]');
  });

  it('leaves clean text and non-string values untouched', () => {
    expect(scrubSensitiveData('a normal error message')).toBe('a normal error message');
    expect(scrubSensitiveData(42)).toBe(42);
    expect(scrubSensitiveData(null)).toBeNull();
    // key NAMES (with underscores) are not key VALUES → not redacted
    expect(scrubSensitiveData('styrby_encryption_keypair')).toBe('styrby_encryption_keypair');
  });
});
