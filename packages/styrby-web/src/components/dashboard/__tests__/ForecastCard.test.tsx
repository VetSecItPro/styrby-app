/**
 * Component tests for ForecastCard (web).
 *
 * WHY: The ForecastCard shows the EMA-blend prediction and "cap on <date>"
 * copy that drives user upgrade decisions. Regressions here could:
 *   - Show "Forecast unavailable" when data is valid (error display bug)
 *   - Render wrong color bands (wrong threshold applied to fraction)
 *   - Miss the acceleration badge (isBurnAccelerating check broken)
 *   - Show wrong exhaustion date format
 *
 * @module components/dashboard/__tests__/ForecastCard
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ForecastCard } from '../ForecastCard';

// ============================================================================
// Mock fetch
// ============================================================================

const mockFetch = vi.fn();
global.fetch = mockFetch;

/**
 * Builds a minimal forecast API response.
 *
 * @param overrides - Partial override of the default payload
 */
function makeForecastPayload(overrides: Record<string, unknown> = {}) {
  return {
    dailyAverageCents: 100,
    trailingWeekAverageCents: 100,
    weightedForecastCents: { '7d': 700, '14d': 1400, '30d': 3000 },
    predictedExhaustionDate: null,
    isBurnAccelerating: false,
    tier: 'pro',
    quotaCents: 5000,
    elapsedCents: 500,
    ...overrides,
  };
}

function setupFetch(payload: unknown, ok = true) {
  mockFetch.mockResolvedValueOnce({
    ok,
    json: () => Promise.resolve(payload),
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('ForecastCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading skeleton initially', () => {
    // Never resolves — keeps loading state visible
    mockFetch.mockReturnValueOnce(new Promise(() => {}));
    const { container } = render(<ForecastCard />);
    expect(container.querySelector('[aria-label="Loading forecast"]')).toBeTruthy();
  });

  it('renders forecast data after successful fetch', async () => {
    setupFetch(makeForecastPayload());
    render(<ForecastCard />);

    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Spend forecast' })).toBeTruthy();
    });

    // Horizon forecasts should be present
    expect(screen.getByText('Next 7d')).toBeTruthy();
    expect(screen.getByText('Next 14d')).toBeTruthy();
    expect(screen.getByText('Next 30d')).toBeTruthy();
  });

  it('shows error state when fetch fails', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));
    render(<ForecastCard />);

    await waitFor(() => {
      expect(screen.getByText(/forecast unavailable/i)).toBeTruthy();
    });
  });

  it('shows error state when API returns non-OK', async () => {
    setupFetch({ error: 'Internal error' }, false);
    render(<ForecastCard />);

    await waitFor(() => {
      expect(screen.getByText(/forecast unavailable/i)).toBeTruthy();
    });
  });

  it('shows "at current burn you will hit your cap" when exhaustion date is set', async () => {
    setupFetch(makeForecastPayload({
      predictedExhaustionDate: '2026-04-28',
      quotaCents: 5000,
      elapsedCents: 4500,
    }));
    render(<ForecastCard />);

    await waitFor(() => {
      const el = screen.getByText(/at current burn you.*ll hit your cap on/i);
      expect(el).toBeTruthy();
    });
  });

  it('shows general spend projection when no exhaustion date', async () => {
    setupFetch(makeForecastPayload({
      predictedExhaustionDate: null,
      elapsedCents: 500,
      weightedForecastCents: { '7d': 700, '14d': 1400, '30d': 3000 },
    }));
    render(<ForecastCard />);

    await waitFor(() => {
      // "on track to spend $X by end of month"
      expect(screen.getByText(/on track to spend/i)).toBeTruthy();
    });
  });

  it('shows acceleration badge when isBurnAccelerating is true', async () => {
    setupFetch(makeForecastPayload({
      isBurnAccelerating: true,
      dailyAverageCents: 100,
      trailingWeekAverageCents: 130, // 30% above 30-day avg
    }));
    render(<ForecastCard />);

    await waitFor(() => {
      // Badge shows "burn rate up X%"
      expect(screen.getByText(/burn rate up/i)).toBeTruthy();
    });
  });

  it('does not show acceleration badge when isBurnAccelerating is false', async () => {
    setupFetch(makeForecastPayload({ isBurnAccelerating: false }));
    render(<ForecastCard />);

    await waitFor(() => {
      expect(screen.queryByText(/burn rate up/i)).toBeNull();
    });
  });
});
