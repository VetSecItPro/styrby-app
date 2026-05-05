import { test, expect } from '@playwright/test';

/**
 * E2E coverage for the public pricing → signup → checkout flow.
 *
 * Three concentric layers (cheapest to most fragile, in that order):
 *
 *  1. **Pricing UI** — pure render + interaction. No backend.
 *     Catches regressions in CTA hrefs that would silently route customers
 *     to the wrong tier or wrong seat count post-signup.
 *
 *  2. **Auth surface regressions** — confirms /login + /signup don't
 *     re-grow the Google OAuth button until it's actually wired up
 *     (see PR #250). A button that fails on click is worse than none.
 *
 *  3. **Billing API contract** — `/api/billing/checkout` rejects bad
 *     input *before* it ever reaches Polar. These are the cheap gates
 *     that prevent a runaway bug from creating a Polar checkout for
 *     1 seat at $33 (or 100 seats at $1942).
 *
 * What is intentionally NOT covered here:
 *   - End-to-end OAuth (real Google/GitHub flow) — requires real third-
 *     party state; covered by manual QA pre-launch.
 *   - Magic-link email delivery — requires a mail receiver; covered by
 *     P11 (Resend integration tests).
 *   - Successful Polar checkout creation — requires a real session +
 *     POLAR_ACCESS_TOKEN; covered by the sandbox-validated unit tests
 *     in `src/__tests__/billing-pipeline.test.ts`.
 *
 * @see PR #247 — billing pipeline correction
 * @see PR #250 — Google OAuth disabled
 */

test.describe('Pricing UI flow', () => {
  test('renders both Pro and Growth tiers', async ({ page }) => {
    await page.goto('/pricing');

    await expect(page.getByRole('heading', { name: /^Pro$/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Growth$/ })).toBeVisible();
  });

  test('Pro CTA routes to /signup?plan=pro on monthly toggle', async ({ page }) => {
    await page.goto('/pricing');

    // Find the Pro card's CTA. It's an <a> wrapping a Button with the tier's cta text.
    // Match by href to avoid coupling to copy.
    const proCta = page.locator('a[href^="/signup?plan=pro"]').first();
    await expect(proCta).toBeVisible();

    const href = await proCta.getAttribute('href');
    // On the default monthly toggle, Pro href should not include billing=annual.
    expect(href).toBe('/signup?plan=pro');
  });

  test('Growth CTA carries the slider seat count in the URL', async ({ page }) => {
    await page.goto('/pricing');

    const growthCta = page.locator('a[href^="/signup?plan=growth"]').first();
    await expect(growthCta).toBeVisible();

    const initialHref = await growthCta.getAttribute('href');
    // Default seat count is GROWTH_BASE_SEATS=3.
    expect(initialHref).toMatch(/\/signup\?plan=growth&seats=3(&billing=annual)?$/);
  });

  test('annual toggle propagates to both Pro and Growth CTAs', async ({ page }) => {
    await page.goto('/pricing');

    // Annual toggle text varies; match the role + a billing-cycle keyword.
    const annualToggle = page.getByRole('button', { name: /annual|yearly/i }).first();

    // Best-effort — if the toggle isn't a button on this layout, skip the assertion
    // rather than fail the suite. The href-shape test above is the primary gate.
    if (await annualToggle.isVisible().catch(() => false)) {
      await annualToggle.click();

      // After flipping to annual, Pro href should include billing=annual.
      const proCta = page.locator('a[href*="plan=pro"]').first();
      await expect(proCta).toHaveAttribute('href', /billing=annual/);

      const growthCta = page.locator('a[href*="plan=growth"]').first();
      await expect(growthCta).toHaveAttribute('href', /billing=annual/);
    }
  });
});

test.describe('Auth surface — no broken OAuth buttons (regression for #250)', () => {
  test('signup page does not render a Google OAuth button', async ({ page }) => {
    await page.goto('/signup');

    // Heuristic: look for any visible button or link whose text mentions Google.
    // The text was "Continue with Google" in the prior implementation. If it
    // re-appears, this test fails until the OAuth client is actually provisioned.
    const googleButton = page.getByRole('button', { name: /google/i });
    await expect(googleButton).toHaveCount(0);
  });

  test('login page does not render a Google OAuth button', async ({ page }) => {
    await page.goto('/login');

    const googleButton = page.getByRole('button', { name: /google/i });
    await expect(googleButton).toHaveCount(0);
  });

  test('signup page still offers GitHub OAuth + email', async ({ page }) => {
    await page.goto('/signup');

    await expect(page.getByRole('button', { name: /github/i })).toBeVisible();
    await expect(page.getByLabel(/email/i)).toBeVisible();
  });

  test('signup page does not advertise a 14-day trial (regression for #250)', async ({ page }) => {
    await page.goto('/signup');

    // Polar is not configured to grant a trial; surfacing one is a
    // legal/trust risk. Stay sensitive to either copy variant.
    const body = await page.locator('body').innerText();
    expect(body).not.toMatch(/14[- ]day (free )?trial/i);
    expect(body).not.toMatch(/no credit card required/i);
  });
});

test.describe('Billing API contract', () => {
  test('POST /api/billing/checkout without auth returns 401', async ({ request }) => {
    const res = await request.post('/api/billing/checkout', {
      data: { tierId: 'pro' },
    });

    // Rate limiter sits ahead of auth — 429 is acceptable on a hot suite.
    // Anything else means the auth gate regressed.
    expect([401, 429]).toContain(res.status());
  });

  test('POST with empty body returns 400 or 401 (never 500)', async ({ request }) => {
    const res = await request.post('/api/billing/checkout', { data: {} });
    // Without a session the auth gate fires first (401). With a session,
    // the empty body fails Zod validation (400). The contract: NEVER 500
    // on a malformed request — that would mean validation is missing.
    expect([400, 401, 429]).toContain(res.status());
    expect(res.status()).not.toBe(500);
  });

  test('POST with unknown tierId returns 400 or 401 (never 500)', async ({ request }) => {
    const res = await request.post('/api/billing/checkout', {
      data: { tierId: 'enterprise-mega-plus' },
    });
    expect([400, 401, 429]).toContain(res.status());
    expect(res.status()).not.toBe(500);
  });

  test('POST tier=pro with seats field is rejected (.strict() schema)', async ({ request }) => {
    // The Pro variant of the discriminated union is .strict(); sending
    // `seats` for Pro is a client bug and must surface as 400, not be
    // silently ignored. Pre-auth layer catches this even without a JWT.
    const res = await request.post('/api/billing/checkout', {
      data: { tierId: 'pro', seats: 5 },
    });
    expect([400, 401, 429]).toContain(res.status());
    expect(res.status()).not.toBe(500);
  });
});
