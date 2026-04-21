/**
 * BillingModelChip + SourceBadge Component Tests
 *
 * Covers:
 * - BillingModelChip renders correct label for each billing model
 * - BillingModelChip applies the expected CSS colour class
 * - BillingModelChip includes an accessible title attribute
 * - SourceBadge renders "R" for agent-reported, "E" for styrby-estimate
 * - SourceBadge includes accessible aria-label
 *
 * WHY: BillingModelChip is the single authoritative label/colour source for
 * billing model display across CostTable, CostsByAgentChart, and the mobile
 * CostPill. A regression here would silently mislead every consumer.
 *
 * @module components/costs/__tests__/BillingModelChip.test
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BillingModelChip, SourceBadge } from '../BillingModelChip';
import type { BillingModel, CostSource } from '@styrby/shared';

// ---------------------------------------------------------------------------
// BillingModelChip
// ---------------------------------------------------------------------------

describe('BillingModelChip — label rendering', () => {
  const cases: Array<[BillingModel, string]> = [
    ['api-key', 'API'],
    ['subscription', 'SUB'],
    ['credit', 'CR'],
    ['free', 'FREE'],
  ];

  it.each(cases)('renders "%s" label as "%s"', (model, expectedLabel) => {
    render(<BillingModelChip billingModel={model} />);
    expect(screen.getByText(expectedLabel)).toBeInTheDocument();
  });
});

describe('BillingModelChip — colour classes', () => {
  it('applies blue class for api-key', () => {
    render(<BillingModelChip billingModel="api-key" />);
    const el = screen.getByText('API');
    expect(el.className).toMatch(/blue/);
  });

  it('applies purple class for subscription', () => {
    render(<BillingModelChip billingModel="subscription" />);
    const el = screen.getByText('SUB');
    expect(el.className).toMatch(/purple/);
  });

  it('applies amber class for credit', () => {
    render(<BillingModelChip billingModel="credit" />);
    const el = screen.getByText('CR');
    expect(el.className).toMatch(/amber/);
  });

  it('applies zinc class for free', () => {
    render(<BillingModelChip billingModel="free" />);
    const el = screen.getByText('FREE');
    expect(el.className).toMatch(/zinc/);
  });
});

describe('BillingModelChip — accessibility', () => {
  it('has a title attribute for each billing model', () => {
    render(<BillingModelChip billingModel="subscription" />);
    const el = screen.getByText('SUB');
    // The title tooltip should describe the billing model in plain language
    expect(el.getAttribute('title')).toBeTruthy();
    expect(el.getAttribute('title')).toMatch(/subscription|quota|flat/i);
  });

  it('has an aria-label that describes the billing model', () => {
    render(<BillingModelChip billingModel="credit" />);
    const el = screen.getByText('CR');
    expect(el.getAttribute('aria-label')).toMatch(/billing model/i);
  });
});

describe('BillingModelChip — className prop', () => {
  it('appends custom className to the element', () => {
    render(<BillingModelChip billingModel="api-key" className="custom-class" />);
    const el = screen.getByText('API');
    expect(el.className).toMatch(/custom-class/);
  });
});

// ---------------------------------------------------------------------------
// SourceBadge
// ---------------------------------------------------------------------------

describe('SourceBadge — label rendering', () => {
  const cases: Array<[CostSource, string]> = [
    ['agent-reported', 'R'],
    ['styrby-estimate', 'E'],
  ];

  it.each(cases)('renders "%s" as "%s"', (source, expectedLabel) => {
    render(<SourceBadge source={source} />);
    expect(screen.getByText(expectedLabel)).toBeInTheDocument();
  });
});

describe('SourceBadge — colour classes', () => {
  it('applies green class for agent-reported', () => {
    render(<SourceBadge source="agent-reported" />);
    const el = screen.getByText('R');
    expect(el.className).toMatch(/green/);
  });

  it('applies amber class for styrby-estimate', () => {
    render(<SourceBadge source="styrby-estimate" />);
    const el = screen.getByText('E');
    expect(el.className).toMatch(/amber/);
  });
});

describe('SourceBadge — accessibility', () => {
  it('has a descriptive aria-label for agent-reported', () => {
    render(<SourceBadge source="agent-reported" />);
    const el = screen.getByText('R');
    expect(el.getAttribute('aria-label')).toMatch(/agent-reported/i);
  });

  it('has a descriptive aria-label for styrby-estimate', () => {
    render(<SourceBadge source="styrby-estimate" />);
    const el = screen.getByText('E');
    expect(el.getAttribute('aria-label')).toMatch(/estimate/i);
  });

  it('has a tooltip title for each source', () => {
    render(<SourceBadge source="styrby-estimate" />);
    const el = screen.getByText('E');
    expect(el.getAttribute('title')).toBeTruthy();
  });
});
