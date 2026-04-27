/**
 * Tests for the pricing tier cards — CTA URLs, render correctness, seat copy.
 *
 * Phase 6 rewrite: replaces the legacy four-card test suite (Solo / Team /
 * Business / Enterprise, partly skipped pending the rename) with a focused
 * suite for the canonical {@link ProTierCard} + {@link GrowthTierCard}
 * components introduced as part of the tier reconciliation in
 * `.audit/styrby-fulltest.md` Decisions #1 / #2.
 *
 * WHY: the CTA buttons are the conversion point. Wrong URLs = dead clicks
 * = lost revenue. These tests assert that each card's CTA routes to the
 * correct checkout entry point and surfaces the canonical pricing copy.
 *
 * WHY NOT a full render of /pricing: the page uses dynamic imports for
 * `ROICalculator` and depends on the Sentry SDK. These unit tests isolate
 * individual cards to avoid those dependencies.
 *
 * @module components/pricing/__tests__/PricingCards
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProTierCard } from '../ProTierCard';
import { GrowthTierCard } from '../GrowthTierCard';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// WHY mock next/link: avoids needing a full Next.js router context. We only
// verify the rendered href; navigation itself is framework-tested.
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('@/lib/utils', () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
}));

// WHY mock UI primitives: Button and Slider have complex Radix internals;
// we only need the rendered anchor href and the slider's role/value.
vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    asChild,
    ...props
  }: {
    children: React.ReactNode;
    asChild?: boolean;
    [key: string]: unknown;
  }) => {
    if (asChild && children && typeof children === 'object') {
      return <>{children}</>;
    }
    return <button {...props}>{children}</button>;
  },
}));

vi.mock('@/components/ui/slider', () => ({
  Slider: ({
    min,
    max,
    value,
    'aria-label': ariaLabel,
  }: {
    min: number;
    max: number;
    value: number[];
    onValueChange: (v: number[]) => void;
    'aria-label': string;
  }) => (
    <input
      type="range"
      data-testid="mock-slider"
      min={min}
      max={max}
      value={value[0]}
      aria-label={ariaLabel}
      readOnly
    />
  ),
}));

// Mock lucide-react icons to simple spans
vi.mock('lucide-react', () => ({
  Check: () => <span data-testid="check-icon" />,
  Users: () => <span data-testid="users-icon" />,
  Calendar: () => <span data-testid="calendar-icon" />,
  DollarSign: () => <span data-testid="dollar-icon" />,
  X: () => <span data-testid="x-icon" />,
  Minus: () => <span data-testid="minus-icon" />,
  ArrowRight: () => <span data-testid="arrow-icon" />,
}));

// ---------------------------------------------------------------------------
// ProTierCard
// ---------------------------------------------------------------------------

describe('ProTierCard', () => {
  describe('monthly billing', () => {
    it('renders the Pro heading', () => {
      render(<ProTierCard annual={false} />);
      expect(screen.getByRole('heading', { name: 'Pro' })).toBeTruthy();
    });

    it('CTA links to /signup?plan=pro (monthly)', () => {
      render(<ProTierCard annual={false} />);
      const link = screen.getByRole('link', { name: /start my pro trial/i });
      expect(link.getAttribute('href')).toBe('/signup?plan=pro');
    });

    it('displays the $39/mo price', () => {
      render(<ProTierCard annual={false} />);
      // $39 = 3900 cents formatted as "$39"
      expect(screen.getByText('$39')).toBeTruthy();
    });

    it('does not show annual savings copy when annual is off', () => {
      render(<ProTierCard annual={false} />);
      expect(screen.queryByText(/save \$/i)).toBeNull();
    });
  });

  describe('annual billing', () => {
    it('CTA links to /signup?plan=pro&billing=annual', () => {
      render(<ProTierCard annual={true} />);
      const link = screen.getByRole('link', { name: /start my pro trial/i });
      expect(link.getAttribute('href')).toBe('/signup?plan=pro&billing=annual');
    });

    it('displays a discounted monthly equivalent (less than $39)', () => {
      render(<ProTierCard annual={true} />);
      // Pro annual = $390/yr → $32.50/mo equivalent → never shown as "$39"
      const priceEl = document.querySelector('.text-5xl');
      expect(priceEl?.textContent).not.toBe('$39');
    });

    it('shows annual savings copy', () => {
      render(<ProTierCard annual={true} />);
      // Pro saves ($39 × 12) - $390 = $78
      expect(screen.getByText(/\$390\/year/i)).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------
// GrowthTierCard
// ---------------------------------------------------------------------------

describe('GrowthTierCard', () => {
  const defaultProps = {
    annual: false,
    seatCount: 3,
    onSeatCountChange: vi.fn(),
  };

  it('renders the Growth heading', () => {
    render(<GrowthTierCard {...defaultProps} />);
    expect(screen.getByRole('heading', { name: 'Growth' })).toBeTruthy();
  });

  it('renders the "Most Popular" badge', () => {
    render(<GrowthTierCard {...defaultProps} />);
    expect(screen.getByText(/most popular/i)).toBeTruthy();
  });

  it('renders a seat slider', () => {
    render(<GrowthTierCard {...defaultProps} />);
    expect(screen.getByTestId('mock-slider')).toBeTruthy();
  });

  it('shows the "Includes 3 seats. Add more for $19/seat/month." copy', () => {
    render(<GrowthTierCard {...defaultProps} seatCount={3} />);
    expect(
      screen.getByText(/Includes 3 seats. Add more for \$19\/seat\/month\./i),
    ).toBeTruthy();
  });

  it('CTA links to /signup?plan=growth&seats=3 with the base seat count', () => {
    render(<GrowthTierCard {...defaultProps} seatCount={3} />);
    const link = screen.getByRole('link', { name: /start my growth trial/i });
    expect(link.getAttribute('href')).toBe('/signup?plan=growth&seats=3');
  });

  it('CTA includes the chosen seat count when slider moves', () => {
    render(<GrowthTierCard {...defaultProps} seatCount={7} />);
    const link = screen.getByRole('link', { name: /start my growth trial/i });
    expect(link.getAttribute('href')).toBe('/signup?plan=growth&seats=7');
  });

  it('CTA appends billing=annual when annual is true', () => {
    render(<GrowthTierCard {...defaultProps} annual={true} seatCount={5} />);
    const link = screen.getByRole('link', { name: /start my growth trial/i });
    expect(link.getAttribute('href')).toBe('/signup?plan=growth&seats=5&billing=annual');
  });

  it('shows $99 total for the base 3-seat plan in monthly mode', () => {
    render(<GrowthTierCard {...defaultProps} seatCount={3} />);
    // 9900 cents = $99
    expect(screen.getByText('$99')).toBeTruthy();
  });

  it('shows $137 total for 5 seats in monthly mode (base $99 + 2 × $19)', () => {
    render(<GrowthTierCard {...defaultProps} seatCount={5} />);
    // 9900 + (2 × 1900) = 13700 cents = $137
    expect(screen.getByText('$137')).toBeTruthy();
  });
});
