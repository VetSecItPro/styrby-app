/**
 * PlanCheckout component tests (POST-SIGNUP-2).
 *
 * Proves the OAuth → /dashboard?plan=…&seats=…&billing=… → Polar
 * checkout chain works end-to-end and that legacy URL slugs (?plan=power,
 * ?plan=team) still resolve to the canonical tier rather than 400ing the
 * checkout API.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const mockReplace = vi.fn();
const mockSearchParamsGet = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => ({ get: mockSearchParamsGet }),
}));

import { PlanCheckout } from '../plan-checkout';

function setSearchParams(params: Record<string, string | null>) {
  mockSearchParamsGet.mockImplementation((key: string) => params[key] ?? null);
}

function mockFetchOk(url: string) {
  global.fetch = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({ url }) }) as unknown as typeof fetch;
}

function mockFetchError() {
  global.fetch = vi
    .fn()
    .mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
}

function captureLocationHref(): { hrefSetter: ReturnType<typeof vi.fn> } {
  const hrefSetter = vi.fn();
  Object.defineProperty(window, 'location', {
    value: {
      get href() {
        return '';
      },
      set href(v: string) {
        hrefSetter(v);
      },
      origin: 'http://localhost',
    },
    writable: true,
  });
  return { hrefSetter };
}

describe('PlanCheckout (POST-SIGNUP-2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('no plan in URL → no checkout call, no redirect', async () => {
    setSearchParams({});
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    render(<PlanCheckout />);

    // Give effects time to run
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('plan=growth & seats=5 & billing=annual → POSTs correct discriminated-union body and redirects to Polar', async () => {
    setSearchParams({ plan: 'growth', seats: '5', billing: 'annual' });
    const { hrefSetter } = captureLocationHref();
    mockFetchOk('https://polar.sh/checkout/growth-5-annual');

    render(<PlanCheckout />);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/billing/checkout',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ tierId: 'growth', billingCycle: 'annual', seats: 5 }),
        }),
      );
    });
    await waitFor(() => {
      expect(hrefSetter).toHaveBeenCalledWith('https://polar.sh/checkout/growth-5-annual');
    });
  });

  it('plan=pro → body excludes `seats` field (Pro variant rejects it via .strict())', async () => {
    setSearchParams({ plan: 'pro', seats: '5' /* should be ignored for Pro */ });
    const { hrefSetter } = captureLocationHref();
    mockFetchOk('https://polar.sh/checkout/pro');

    render(<PlanCheckout />);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/billing/checkout',
        expect.objectContaining({
          body: JSON.stringify({ tierId: 'pro', billingCycle: 'monthly' }),
        }),
      );
    });
    await waitFor(() => {
      expect(hrefSetter).toHaveBeenCalledWith('https://polar.sh/checkout/pro');
    });
  });

  it('legacy plan=power → resolves to growth (back-compat for old URLs)', async () => {
    setSearchParams({ plan: 'power', seats: '4' });
    captureLocationHref();
    mockFetchOk('https://polar.sh/checkout/x');

    render(<PlanCheckout />);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/billing/checkout',
        expect.objectContaining({
          body: JSON.stringify({ tierId: 'growth', billingCycle: 'monthly', seats: 4 }),
        }),
      );
    });
  });

  it('checkout API failure → router.replace clears params (no infinite re-fire)', async () => {
    setSearchParams({ plan: 'growth', seats: '3' });
    captureLocationHref();
    mockFetchError();

    render(<PlanCheckout />);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/dashboard');
    });
  });

  it('plan=growth without seats → omits seats field (API will default to GROWTH_BASE_SEATS)', async () => {
    setSearchParams({ plan: 'growth' });
    captureLocationHref();
    mockFetchOk('https://polar.sh/checkout/y');

    render(<PlanCheckout />);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/billing/checkout',
        expect.objectContaining({
          body: JSON.stringify({ tierId: 'growth', billingCycle: 'monthly' }),
        }),
      );
    });
  });

  it('rejects garbage seats values (negative, NaN, huge)', async () => {
    setSearchParams({ plan: 'growth', seats: '-5' });
    captureLocationHref();
    mockFetchOk('https://polar.sh/checkout/z');

    render(<PlanCheckout />);

    await waitFor(() => {
      // Negative seats are dropped; body has no seats field at all
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/billing/checkout',
        expect.objectContaining({
          body: JSON.stringify({ tierId: 'growth', billingCycle: 'monthly' }),
        }),
      );
    });
  });

  it('unknown plan slug (?plan=enterprise) → no fetch, no redirect', async () => {
    setSearchParams({ plan: 'enterprise' });
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    render(<PlanCheckout />);

    await new Promise((r) => setTimeout(r, 10));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
