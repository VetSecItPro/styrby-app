/**
 * PricingSection — landing-page pricing section tests.
 *
 * Phase 6 rewrite: the section now surfaces only Pro and Growth (the legacy
 * Free / Pro $24 / Power $59 layout was retired with the tier reconciliation
 * in `.audit/styrby-fulltest.md`). These tests guard:
 *   - Both plan cards render (Pro, Growth).
 *   - Monthly prices match the canonical billing-config values.
 *   - Annual toggle switches to the discounted equivalents.
 *   - Annual savings copy appears / disappears with the toggle.
 *   - CTA buttons link to /signup?plan=pro and /signup?plan=growth (with
 *     billing=annual variants when toggled).
 *   - Toggle has correct ARIA semantics.
 *
 * WHY: the pricing section is the primary on-landing-page conversion point.
 * Wrong prices, broken CTAs, or stale plan copy directly harm revenue.
 *
 * @module components/landing/__tests__/pricing-section
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

import { PricingSection } from '../pricing-section';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setup() {
  const user = userEvent.setup();
  const utils = render(<PricingSection />);
  return { user, ...utils };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PricingSection — plan cards render', () => {
  it('renders both plan headings (Pro and Growth)', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'Pro' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Growth' })).toBeInTheDocument();
  });

  it('renders both plan taglines', () => {
    setup();
    expect(screen.getByText('For developers who ship daily')).toBeInTheDocument();
    expect(
      screen.getByText('For teams that need to govern spend and access'),
    ).toBeInTheDocument();
  });

  it('marks Growth as the recommended plan ("Most Popular" badge)', () => {
    setup();
    expect(screen.getByText(/most popular/i)).toBeInTheDocument();
  });
});

describe('PricingSection — monthly prices', () => {
  it('shows $39 for Pro in monthly mode', () => {
    setup();
    expect(screen.getByText('$39')).toBeInTheDocument();
  });

  it('shows $99 for Growth in monthly mode', () => {
    setup();
    expect(screen.getByText('$99')).toBeInTheDocument();
  });

  it('shows the per-seat add-on note on the Growth card', () => {
    setup();
    expect(
      screen.getByText(/Includes 3 seats. \+\$19\/seat\/month after\./i),
    ).toBeInTheDocument();
  });
});

describe('PricingSection — annual toggle', () => {
  it('toggle has aria-checked="false" by default', () => {
    setup();
    const toggle = screen.getByRole('switch', { name: /toggle annual billing/i });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('toggle switches to aria-checked="true" when clicked', async () => {
    const { user } = setup();
    const toggle = screen.getByRole('switch', { name: /toggle annual billing/i });
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('shows Pro annual price ($33/mo equivalent) when toggled', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('switch', { name: /toggle annual billing/i }));
    // Pro annual = $390/year → Math.round(390/12) = $33
    expect(screen.getByText('$33')).toBeInTheDocument();
  });

  it('shows Growth annual price ($83/mo equivalent) when toggled', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('switch', { name: /toggle annual billing/i }));
    // Growth base annual = $990/year → Math.round(990/12) = $83
    expect(screen.getByText('$83')).toBeInTheDocument();
  });

  it('shows savings copy for Pro when annual is toggled on', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('switch', { name: /toggle annual billing/i }));
    // Pro saves $78 per year
    expect(screen.getByText(/\$390\/year.*save \$78/i)).toBeInTheDocument();
  });

  it('hides savings copy when toggled back to monthly', async () => {
    const { user } = setup();
    const toggle = screen.getByRole('switch', { name: /toggle annual billing/i });
    await user.click(toggle); // on
    await user.click(toggle); // off
    expect(screen.queryByText(/save \$78/i)).not.toBeInTheDocument();
  });

  it('shows the "Save 17%" badge in the annual label', () => {
    setup();
    expect(screen.getByText('Save 17%')).toBeInTheDocument();
  });
});

describe('PricingSection — CTA links', () => {
  it('Pro plan CTA links to /signup?plan=pro (monthly)', () => {
    setup();
    const proLink = screen.getByRole('link', { name: 'Start my Pro trial' });
    expect(proLink).toHaveAttribute('href', '/signup?plan=pro');
  });

  it('Growth plan CTA links to /signup?plan=growth (monthly)', () => {
    setup();
    const growthLink = screen.getByRole('link', { name: 'Start my Growth trial' });
    expect(growthLink).toHaveAttribute('href', '/signup?plan=growth');
  });

  it('Pro CTA appends billing=annual when annual toggle is on', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('switch', { name: /toggle annual billing/i }));
    const proLink = screen.getByRole('link', { name: 'Start my Pro trial' });
    expect(proLink).toHaveAttribute('href', '/signup?plan=pro&billing=annual');
  });

  it('Growth CTA appends billing=annual when annual toggle is on', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('switch', { name: /toggle annual billing/i }));
    const growthLink = screen.getByRole('link', { name: 'Start my Growth trial' });
    expect(growthLink).toHaveAttribute('href', '/signup?plan=growth&billing=annual');
  });
});

describe('PricingSection — feature lists', () => {
  it('renders included features for Pro', () => {
    setup();
    expect(screen.getByText('All 11 CLI agents')).toBeInTheDocument();
    expect(
      screen.getByText('OTEL export (Grafana, Datadog, Honeycomb)'),
    ).toBeInTheDocument();
  });

  it('renders included features for Growth', () => {
    setup();
    expect(screen.getByText('Everything in Pro, plus:')).toBeInTheDocument();
    expect(
      screen.getByText('Team workspace with role-based access'),
    ).toBeInTheDocument();
  });
});

describe('PricingSection — trial footnote and deep link', () => {
  it('shows the 14-day free trial note with the compare-pricing link', () => {
    setup();
    expect(
      screen.getByText(/14-day free trial on pro and growth/i),
    ).toBeInTheDocument();
    const compareLink = screen.getByRole('link', { name: /compare full pricing/i });
    expect(compareLink).toHaveAttribute('href', '/pricing');
  });
});
