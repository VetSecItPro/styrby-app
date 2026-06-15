/**
 * Tests for the product-analytics event catalog.
 *
 * These guard the two invariants the rest of the system relies on:
 *  1. The product super-property is always present and correct (data from the
 *     shared PostHog project stays filterable by product).
 *  2. Event names are unique and stable (a duplicate value would silently
 *     merge two distinct user actions into one funnel step).
 */

import { describe, it, expect } from 'vitest';
import {
  ANALYTICS_EVENTS,
  PRODUCT_TAG,
  PRODUCT_PROPERTY_KEY,
  withProduct,
} from '../events.js';

describe('analytics events catalog', () => {
  it('tags Styrby as the product', () => {
    expect(PRODUCT_TAG).toBe('styrby');
    expect(PRODUCT_PROPERTY_KEY).toBe('product');
  });

  it('has no duplicate event-name values', () => {
    const values = Object.values(ANALYTICS_EVENTS);
    expect(new Set(values).size).toBe(values.length);
  });

  it('uses snake_case for every event name', () => {
    for (const name of Object.values(ANALYTICS_EVENTS)) {
      expect(name).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
    }
  });
});

describe('withProduct', () => {
  it('always stamps the product tag, even with no props', () => {
    expect(withProduct()).toEqual({ product: 'styrby' });
  });

  it('merges caller props alongside the product tag', () => {
    expect(withProduct({ to_tier: 'growth' })).toEqual({
      product: 'styrby',
      to_tier: 'growth',
    });
  });

  it('forces product to the tag even if a caller tries to override it', () => {
    // A caller passing product: 'kaulby' must not be able to mislabel a
    // Styrby event - the tag is forced last so the shared project stays clean.
    expect(withProduct({ product: 'kaulby' }).product).toBe('styrby');
  });
});
