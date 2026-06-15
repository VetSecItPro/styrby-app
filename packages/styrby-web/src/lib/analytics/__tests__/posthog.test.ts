/**
 * Tests for the web PostHog wrapper.
 *
 * The wrapper's contract is: no-op safely when disabled, and when enabled,
 * lazy-load + initialise cookielessly + identified-only and stamp the product
 * tag on every event. These tests pin that contract so a future refactor can't
 * silently start setting cookies, drop the product tag, or pull the SDK back
 * into the first-load bundle (the lazy `import()` is load-bearing for bundle size).
 *
 * The module reads NEXT_PUBLIC_POSTHOG_KEY at import time, so each test resets
 * modules and re-imports under a stubbed env. Calls flush asynchronously
 * (behind the dynamic import), so assertions use `vi.waitFor`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the posthog-js singleton (resolved via dynamic import in the wrapper).
// The `loaded` callback is invoked with this same mock so we can assert the
// super-property registration.
const mockPosthog = {
  init: vi.fn(
    (
      _key: string,
      opts: { loaded?: (ph: unknown) => void; [k: string]: unknown }
    ) => {
      opts.loaded?.(mockPosthog);
    }
  ),
  capture: vi.fn(),
  identify: vi.fn(),
  register: vi.fn(),
  reset: vi.fn(),
};
vi.mock('posthog-js', () => ({ default: mockPosthog }));

// Keep shared deps deterministic (don't depend on the built dist).
vi.mock('@styrby/shared', () => ({
  PRODUCT_TAG: 'styrby',
  PRODUCT_PROPERTY_KEY: 'product',
  withProduct: (p?: Record<string, unknown>) => ({ ...p, product: 'styrby' }),
}));

async function loadModule() {
  vi.resetModules();
  return import('../posthog.js');
}

/** Let any queued microtasks (the dynamic-import .then chain) settle. */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('when no PostHog key is configured', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', '');
  });

  it('reports analytics disabled and never initialises', async () => {
    const m = await loadModule();
    expect(m.isAnalyticsEnabled()).toBe(false);
    m.initAnalytics();
    await flush();
    expect(mockPosthog.init).not.toHaveBeenCalled();
  });

  it('no-ops capture and identify', async () => {
    const m = await loadModule();
    m.capture('dashboard_viewed' as never);
    m.identifyUser('user-123');
    await flush();
    expect(mockPosthog.capture).not.toHaveBeenCalled();
    expect(mockPosthog.identify).not.toHaveBeenCalled();
  });
});

describe('when a PostHog key is configured', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_test_key');
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_HOST', 'https://us.i.posthog.com');
  });

  it('lazily initialises cookielessly + identified-only and registers the product tag', async () => {
    const m = await loadModule();
    m.initAnalytics();
    await vi.waitFor(() => expect(mockPosthog.init).toHaveBeenCalledTimes(1));
    const opts = mockPosthog.init.mock.calls[0][1];
    expect(opts.persistence).toBe('memory');
    expect(opts.person_profiles).toBe('identified_only');
    expect(opts.capture_pageview).toBe(false);
    expect(opts.api_host).toBe('https://us.i.posthog.com');
    // loaded() ran and stamped the product super-property
    expect(mockPosthog.register).toHaveBeenCalledWith({ product: 'styrby' });
  });

  it('only initialises once even if called repeatedly', async () => {
    const m = await loadModule();
    m.initAnalytics();
    m.initAnalytics();
    m.initAnalytics();
    await vi.waitFor(() => expect(mockPosthog.init).toHaveBeenCalledTimes(1));
    await flush();
    expect(mockPosthog.init).toHaveBeenCalledTimes(1);
  });

  it('stamps the product tag on captured events', async () => {
    const m = await loadModule();
    m.capture('plan_upgrade_clicked' as never, { to_tier: 'growth' });
    await vi.waitFor(() =>
      expect(mockPosthog.capture).toHaveBeenCalledWith('plan_upgrade_clicked', {
        to_tier: 'growth',
        product: 'styrby',
      })
    );
  });

  it('identifies by user id with the product tag', async () => {
    const m = await loadModule();
    m.identifyUser('user-123');
    await vi.waitFor(() =>
      expect(mockPosthog.identify).toHaveBeenCalledWith('user-123', {
        product: 'styrby',
      })
    );
  });

  it('ignores an empty user id', async () => {
    const m = await loadModule();
    m.identifyUser('');
    await flush();
    expect(mockPosthog.identify).not.toHaveBeenCalled();
  });
});
