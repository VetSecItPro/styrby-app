/**
 * CostSummaryCard Component Tests
 *
 * Tests for the cost metrics card displayed on the cost dashboard:
 * - Renders the title, cost amount, token count, and request count
 * - Zero request count: request count row is hidden
 * - Highlight prop: applies orange styling to the cost text
 * - No highlight: default zinc styling
 * - Icon prop: renders the icon element
 * - Token counts: input + output tokens are summed correctly
 * - formatCost / formatTokens formatting (smoke-tests via rendered output)
 *
 * WHY: The cost dashboard is a primary retention driver — users check it
 * regularly to understand AI spending. Incorrect numbers or broken layout
 * erode trust and prompt cancellations.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { CostSummary } from '@/lib/costs';

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

import { CostSummaryCard } from '../CostSummaryCard';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

/**
 * Builds a minimal CostSummary for testing.
 * @param overrides - Fields to override from the defaults
 */
function buildSummary(overrides: Partial<CostSummary> = {}): CostSummary {
  return {
    totalCost: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    requestCount: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CostSummaryCard — basic rendering', () => {
  it('renders the card title', () => {
    render(
      <CostSummaryCard title="Today" summary={buildSummary()} />
    );

    expect(screen.getByText('Today')).toBeInTheDocument();
  });

  it('renders the total cost amount', () => {
    render(
      <CostSummaryCard
        title="This Week"
        summary={buildSummary({ totalCost: 1.5 })}
      />
    );

    // formatCost should produce something like "$1.50"
    expect(screen.getByText(/\$1\.50/)).toBeInTheDocument();
  });

  it('renders $0.00 for zero cost', () => {
    render(
      <CostSummaryCard title="Today" summary={buildSummary({ totalCost: 0 })} />
    );

    expect(screen.getByText(/\$0\.00/)).toBeInTheDocument();
  });
});

describe('CostSummaryCard — token display', () => {
  it('sums input and output tokens for the tokens line', () => {
    render(
      <CostSummaryCard
        title="This Month"
        summary={buildSummary({ inputTokens: 1000, outputTokens: 500 })}
      />
    );

    // 1500 tokens total — formatTokens(1500) returns "1.5K"
    expect(screen.getByText('1.5K tokens')).toBeInTheDocument();
  });

  it('shows 0 tokens when both input and output are zero', () => {
    render(
      <CostSummaryCard
        title="Today"
        summary={buildSummary({ inputTokens: 0, outputTokens: 0 })}
      />
    );

    expect(screen.getByText(/tokens/i)).toBeInTheDocument();
  });
});

describe('CostSummaryCard — request count', () => {
  it('shows request count when requestCount > 0', () => {
    render(
      <CostSummaryCard
        title="Today"
        summary={buildSummary({ requestCount: 42 })}
      />
    );

    expect(screen.getByText(/42 requests/)).toBeInTheDocument();
  });

  it('hides request count when requestCount is 0', () => {
    render(
      <CostSummaryCard
        title="Today"
        summary={buildSummary({ requestCount: 0 })}
      />
    );

    expect(screen.queryByText(/requests/)).not.toBeInTheDocument();
  });

  it('formats large request counts with locale separators', () => {
    render(
      <CostSummaryCard
        title="This Month"
        summary={buildSummary({ requestCount: 12345 })}
      />
    );

    // toLocaleString() produces "12,345" in en-US
    expect(screen.getByText(/12,345 requests/)).toBeInTheDocument();
  });
});

describe('CostSummaryCard — highlight prop', () => {
  it('applies orange text class when highlight is true', () => {
    render(
      <CostSummaryCard
        title="Today"
        summary={buildSummary({ totalCost: 2.0 })}
        highlight
      />
    );

    // The cost paragraph should have the orange class
    const costEl = screen.getByText(/\$2\.00/);
    expect(costEl.className).toMatch(/orange/);
  });

  it('does not apply orange text class when highlight is false', () => {
    render(
      <CostSummaryCard
        title="Today"
        summary={buildSummary({ totalCost: 2.0 })}
        highlight={false}
      />
    );

    const costEl = screen.getByText(/\$2\.00/);
    expect(costEl.className).not.toMatch(/orange/);
  });
});

describe('CostSummaryCard — icon prop', () => {
  it('renders the icon when provided', () => {
    render(
      <CostSummaryCard
        title="Today"
        summary={buildSummary()}
        icon={<span data-testid="test-icon" />}
      />
    );

    expect(screen.getByTestId('test-icon')).toBeInTheDocument();
  });

  it('renders without error when icon is not provided', () => {
    expect(() =>
      render(<CostSummaryCard title="Today" summary={buildSummary()} />)
    ).not.toThrow();
  });
});
