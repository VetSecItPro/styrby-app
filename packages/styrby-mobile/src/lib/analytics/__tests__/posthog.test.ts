/**
 * Tests for the mobile PostHog thin client.
 *
 * Pins the wire contract with PostHog's capture endpoint and the privacy
 * behaviour: no-op without a key, product-tagged events, identity by Supabase
 * id, ephemeral anonymous id (no persistence), and fire-and-forget that never
 * throws. The module reads EXPO_PUBLIC_POSTHOG_KEY at import time, so each test
 * loads it fresh under a stubbed env.
 */

// Deterministic product tag (don't depend on the built shared dist).
// Mobile imports the unscoped `styrby-shared` alias (jest moduleNameMapper).
jest.mock('styrby-shared', () => ({
  withProduct: (p?: Record<string, unknown>) => ({ ...p, product: 'styrby' }),
}));

type Client = typeof import('../posthog');

const REAL_FETCH = global.fetch;
let fetchMock: jest.Mock;

function load(key?: string): Client {
  if (key) {
    process.env.EXPO_PUBLIC_POSTHOG_KEY = key;
  } else {
    delete process.env.EXPO_PUBLIC_POSTHOG_KEY;
  }
  process.env.EXPO_PUBLIC_POSTHOG_HOST = 'https://us.i.posthog.com';
  let mod: Client;
  jest.isolateModules(() => {
    mod = require('../posthog');
  });
  return mod!;
}

/** Let the fire-and-forget post() microtasks settle. */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

/** Parse the JSON body of the Nth fetch call. */
function bodyOf(call = 0) {
  return JSON.parse(fetchMock.mock.calls[call][1].body);
}

beforeEach(() => {
  fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
  (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
});

afterEach(() => {
  (global as unknown as { fetch: typeof REAL_FETCH }).fetch = REAL_FETCH;
  delete process.env.EXPO_PUBLIC_POSTHOG_KEY;
  jest.clearAllMocks();
});

describe('when no key is configured', () => {
  it('is disabled and never calls fetch', async () => {
    const ph = load(undefined);
    expect(ph.isAnalyticsEnabled()).toBe(false);
    ph.capture('dashboard_viewed' as never);
    ph.identifyUser('user-1');
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('when a key is configured', () => {
  it('POSTs a product-tagged event to the US ingestion endpoint', async () => {
    const ph = load('phc_test');
    ph.capture('plan_upgrade_clicked' as never, { to_tier: 'growth' });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://us.i.posthog.com/i/v0/e/');
    const body = bodyOf();
    expect(body.api_key).toBe('phc_test');
    expect(body.event).toBe('plan_upgrade_clicked');
    expect(body.properties).toEqual({ to_tier: 'growth', product: 'styrby' });
    expect(body.distinct_id).toMatch(/^anon-/); // ephemeral, pre-identify
  });

  it('captures a screen view as $screen with the screen name', async () => {
    const ph = load('phc_test');
    ph.captureScreen('/dashboard/sessions');
    await flush();
    const body = bodyOf();
    expect(body.event).toBe('$screen');
    expect(body.properties.$screen_name).toBe('/dashboard/sessions');
    expect(body.properties.product).toBe('styrby');
  });

  it('identifies by Supabase id and attributes later events to it', async () => {
    const ph = load('phc_test');
    ph.identifyUser('user-42');
    await flush();
    const idBody = bodyOf(0);
    expect(idBody.event).toBe('$identify');
    expect(idBody.distinct_id).toBe('user-42');
    expect(idBody.properties.$set.product).toBe('styrby');
    expect(ph._getDistinctId()).toBe('user-42');

    ph.capture('settings_viewed' as never);
    await flush();
    expect(bodyOf(1).distinct_id).toBe('user-42');
  });

  it('ignores an empty user id', async () => {
    const ph = load('phc_test');
    ph.identifyUser('');
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resets to a fresh anonymous id on sign-out', async () => {
    const ph = load('phc_test');
    ph.identifyUser('user-7');
    expect(ph._getDistinctId()).toBe('user-7');
    ph.resetUser();
    expect(ph._getDistinctId()).toMatch(/^anon-/);
    expect(ph._getDistinctId()).not.toBe('user-7');
  });

  it('never throws when the network fails (fire-and-forget)', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const ph = load('phc_test');
    expect(() => ph.capture('dashboard_viewed' as never)).not.toThrow();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
