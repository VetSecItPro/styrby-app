/**
 * CookieConsent Component Tests
 *
 * Tests the GDPR/ePrivacy cookie notice banner:
 * - Hidden when localStorage key is already set
 * - Visible when localStorage key is absent
 * - Dismiss button sets the localStorage key and hides the banner
 * - Privacy Policy link points to /privacy
 * - Banner has correct aria attributes (role="alert", aria-label)
 *
 * WHY: This component reads/writes localStorage and conditionally renders
 * itself — both paths (shown/hidden) must work correctly. A broken dismiss
 * causes an annoying persistent banner; a permanently hidden banner fails
 * GDPR disclosure requirements.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ---------------------------------------------------------------------------
// localStorage stub
// ---------------------------------------------------------------------------

/**
 * Simple in-memory localStorage stub.
 * WHY: jsdom ships with a partial localStorage implementation that can behave
 * unexpectedly when reset between tests. A manual stub gives full control.
 */
const localStorageStub: Record<string, string> = {};

const localStorageMock = {
  getItem: (key: string) => localStorageStub[key] ?? null,
  setItem: (key: string, value: string) => { localStorageStub[key] = value; },
  removeItem: (key: string) => { delete localStorageStub[key]; },
  clear: () => { Object.keys(localStorageStub).forEach((k) => delete localStorageStub[k]); },
};

beforeEach(() => {
  localStorageMock.clear();
  Object.defineProperty(window, 'localStorage', {
    value: localStorageMock,
    writable: true,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

import { CookieConsent } from '../cookie-consent';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CookieConsent — visibility', () => {
  it('renders the banner when the dismiss key is not in localStorage', () => {
    // No key set — banner should be visible
    render(<CookieConsent />);

    // WHY role="region" (was "alert"): the banner switched from
    // assertive interrupt to a polite landmark region during the
    // 2026-04-26 a11y pass — see cookie-consent.tsx WHY note.
    expect(screen.getByRole('region', { name: /cookie notice/i })).toBeInTheDocument();
  });

  it('does NOT render the banner when already dismissed (key present)', () => {
    localStorageMock.setItem('styrby-cookie-notice-dismissed', 'true');

    render(<CookieConsent />);

    expect(screen.queryByRole('region', { name: /cookie notice/i })).not.toBeInTheDocument();
  });
});

describe('CookieConsent — dismiss action', () => {
  it('hides the banner after clicking the dismiss button', async () => {
    const user = userEvent.setup();
    render(<CookieConsent />);

    expect(screen.getByRole('region', { name: /cookie notice/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /dismiss cookie notice/i }));

    expect(screen.queryByRole('region', { name: /cookie notice/i })).not.toBeInTheDocument();
  });

  it('writes the dismiss key to localStorage on dismiss', async () => {
    const user = userEvent.setup();
    render(<CookieConsent />);

    await user.click(screen.getByRole('button', { name: /dismiss cookie notice/i }));

    expect(localStorageMock.getItem('styrby-cookie-notice-dismissed')).toBe('true');
  });
});

describe('CookieConsent — content', () => {
  it('includes a link to the privacy policy', () => {
    render(<CookieConsent />);

    const link = screen.getByRole('link', { name: /privacy policy/i });
    expect(link).toHaveAttribute('href', '/privacy');
  });

  it('mentions authentication and sidebar preference cookies', () => {
    render(<CookieConsent />);

    const banner = screen.getByRole('region', { name: /cookie notice/i });
    expect(banner.textContent).toMatch(/authentication/i);
    expect(banner.textContent).toMatch(/sidebar/i);
  });

  it('has the dismiss button with correct accessible label', () => {
    render(<CookieConsent />);

    expect(
      screen.getByRole('button', { name: 'Dismiss cookie notice' })
    ).toBeInTheDocument();
  });
});
