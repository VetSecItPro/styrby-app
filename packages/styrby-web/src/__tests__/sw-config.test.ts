/**
 * Service worker config invariants — guards against regression of the
 * "Update banner stuck on Updating…" bug observed in production 2026-05-04.
 *
 * Root cause: `new Serwist({ skipWaiting: true })` makes Serwist self-skip
 * on install AND removes the message-listener fallback. The custom
 * "Update now" banner in `components/sw-register.tsx` then has no waiting
 * worker to postMessage SKIP_WAITING to, so the click does nothing and the
 * button gets stuck. The fix is `skipWaiting: false` so the banner's
 * postMessage path actually runs.
 *
 * These tests read the source file (not the bundled output) so they catch
 * regressions BEFORE the SW gets compiled to public/sw.js. They are
 * deliberately string-based — testing the runtime behavior would require
 * a real Service Worker scope, which is heavier than the value here.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SW_SOURCE = readFileSync(
  resolve(__dirname, '..', 'sw.ts'),
  'utf-8',
);

describe('Service worker config (regression guards)', () => {
  it('passes skipWaiting: false to Serwist (so the update banner can drive skipWaiting via postMessage)', () => {
    // The source must contain the literal `skipWaiting: false` and must NOT
    // contain `skipWaiting: true`. This is intentionally strict — any
    // accidental flip back to true reintroduces the stuck-banner bug.
    expect(SW_SOURCE).toContain('skipWaiting: false');
    expect(SW_SOURCE).not.toContain('skipWaiting: true');
  });

  it('registers a message listener that calls self.skipWaiting() on SKIP_WAITING', () => {
    // The custom message handler is what actually flips the new SW from
    // waiting → active when the user clicks "Update now". It must exist.
    expect(SW_SOURCE).toContain("'message'");
    expect(SW_SOURCE).toMatch(/data\?\.type === 'SKIP_WAITING'/);
    expect(SW_SOURCE).toContain('self.skipWaiting()');
  });

  it('keeps clientsClaim: true (so the new SW takes over open tabs immediately after activation)', () => {
    // After SKIP_WAITING fires and the new SW activates, clientsClaim
    // ensures it controls the page that triggered the update without a
    // hard reload. The reload still happens (sw-register listens for
    // controllerchange) but clientsClaim is what makes the SW the
    // controller in the first place.
    expect(SW_SOURCE).toContain('clientsClaim: true');
  });
});
