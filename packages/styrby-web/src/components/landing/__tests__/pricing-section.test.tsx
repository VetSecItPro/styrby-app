/**
 * PricingSection Component Tests
 *
 * Tests the landing-page pricing section:
 * - All three plan cards render (Free, Pro, Power)
 * - Monthly prices are shown by default
 * - Annual toggle switches to annual pricing
 * - Annual savings copy appears when toggle is on, disappears when off
 * - CTA buttons link to correct signup URLs including plan params
 * - Free plan "forever" label (not "/mo")
 * - Free plan not-included features list (renders X icon items)
 * - Toggle switch has correct aria-checked attribute
 * - Annual label gets the "Save 2 months" badge
 *
 * WHY: The pricing section is the primary conversion point. Incorrect prices,
 * broken CTA links, or wrong plan copy directly harm revenue.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
  it('renders all three plan names', () => {
    setup();

    expect(screen.getByRole('heading', { name: 'Free' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Pro' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Power' })).toBeInTheDocument();
  });

  it('renders the three plan taglines', () => {
    setup();

    expect(screen.getByText('For developers exploring')).toBeInTheDocument();
    expect(screen.getByText('For developers who ship daily')).toBeInTheDocument();
    expect(screen.getByText('For teams and power users')).toBeInTheDocument();
  });
});

describe('PricingSection — monthly prices', () => {
  it('shows $0 for Free plan', () => {
    setup();

    // Free plan has $0 — the span renders "$0" as the price text
    // There are three price spans on the page; $0 corresponds to Free
    expect(screen.getByText('$0')).toBeInTheDocument();
  });

  it('shows $24 for Pro plan in monthly mode', () => {
    setup();

    // $24 monthly price
    expect(screen.getByText('$24')).toBeInTheDocument();
  });

  it('shows $59 for Power plan in monthly mode', () => {
    setup();

    expect(screen.getByText('$59')).toBeInTheDocument();
  });

  it('shows "forever" label for Free plan instead of /mo', () => {
    setup();

    expect(screen.getByText('forever')).toBeInTheDocument();
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

  it('shows annual prices when toggle is on (Pro: $20/mo equivalent)', async () => {
    const { user } = setup();

    await user.click(screen.getByRole('switch', { name: /toggle annual billing/i }));

    // Pro annual = $240/year → $20/mo displayed
    expect(screen.getByText('$20')).toBeInTheDocument();
  });

  it('shows Power annual price ($49/mo equivalent) when toggled', async () => {
    const { user } = setup();

    await user.click(screen.getByRole('switch', { name: /toggle annual billing/i }));

    // Power annual = $590/year → Math.round(590/12) = $49
    expect(screen.getByText('$49')).toBeInTheDocument();
  });

  it('shows savings copy for Pro when annual is toggled on', async () => {
    const { user } = setup();

    await user.click(screen.getByRole('switch', { name: /toggle annual billing/i }));

    // Pro saves $48 per year
    expect(screen.getByText(/\$240\/year.*save \$48/i)).toBeInTheDocument();
  });

  it('hides savings copy when toggled back to monthly', async () => {
    const { user } = setup();

    const toggle = screen.getByRole('switch', { name: /toggle annual billing/i });
    await user.click(toggle); // on
    await user.click(toggle); // off

    expect(screen.queryByText(/save \$48/i)).not.toBeInTheDocument();
  });

  it('shows the "Save 2 months" badge in the annual label', () => {
    setup();

    expect(screen.getByText('Save 2 months')).toBeInTheDocument();
  });
});

describe('PricingSection — CTA links', () => {
  it('Free plan CTA links to /signup', () => {
    setup();

    const freeLink = screen.getByRole('link', { name: 'Start Free' });
    expect(freeLink).toHaveAttribute('href', '/signup');
  });

  it('Pro plan CTA links to /signup?plan=pro', () => {
    setup();

    const proLink = screen.getByRole('link', { name: 'Connect 3 Machines' });
    expect(proLink).toHaveAttribute('href', '/signup?plan=pro');
  });

  it('Power plan CTA links to /signup?plan=power', () => {
    setup();

    const powerLink = screen.getByRole('link', { name: 'Connect 9 Machines' });
    expect(powerLink).toHaveAttribute('href', '/signup?plan=power');
  });
});

describe('PricingSection — feature lists', () => {
  it('renders included features for Free plan', () => {
    setup();

    expect(screen.getByText('1 connected machine')).toBeInTheDocument();
    expect(screen.getByText('E2E encryption')).toBeInTheDocument();
    expect(screen.getByText('1 budget alert')).toBeInTheDocument();
  });

  it('renders not-included features for Free plan', () => {
    setup();

    // notIncluded items for Free
    expect(screen.getByText('Per-message cost tracking')).toBeInTheDocument();
    expect(screen.getByText('Session checkpoints')).toBeInTheDocument();
    expect(screen.getByText('Team management')).toBeInTheDocument();
    expect(screen.getByText('Voice commands')).toBeInTheDocument();
  });

  it('renders included features for Power plan', () => {
    setup();

    expect(
      screen.getByText('OTEL export (Grafana, Datadog, and more)')
    ).toBeInTheDocument();
    expect(screen.getByText('Voice commands and cloud monitoring')).toBeInTheDocument();
  });
});

describe('PricingSection — trial footnote', () => {
  it('shows the 14-day free trial note', () => {
    setup();

    expect(
      screen.getByText(/14-day free trial on pro and power/i)
    ).toBeInTheDocument();
  });
});
