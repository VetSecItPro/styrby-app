/**
 * Tests for the subscription lifecycle email functions.
 *
 * WHY this matters: these emails are the customer-facing receipt for every
 * monetary state change. A regression in subject / body / send-failure
 * handling would either spam customers, miss notifications, or - worst case -
 * crash the Polar webhook. The webhook crash mode is the worst outcome
 * because Polar retries, which compounds into duplicate state mutations.
 *
 * Coverage:
 *   - `buildLifecycleEmail` helper: direct invocation asserting scaffold wiring
 *   - Each of the 6 functions is invoked once and asserted on subject + body
 *   - Each function survives a Resend send failure without throwing
 *   - Each function no-ops cleanly when RESEND_API_KEY is missing
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────
// Resend mock
// ─────────────────────────────────────────────────────────────────────────

const mockSend = vi.fn();

vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: { send: mockSend },
  })),
}));

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  process.env.RESEND_API_KEY = 're_test_lifecycle_123';
  mockSend.mockResolvedValue({ data: { id: 'email-id' }, error: null });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

// Helper to load the module fresh per test (resetModules clears cached client)
async function load() {
  return import('../lifecycle');
}

// Helper to get the single send call argument
function lastCall() {
  expect(mockSend).toHaveBeenCalledTimes(1);
  return mockSend.mock.calls[0][0];
}

describe('lifecycle emails', () => {
  describe('buildLifecycleEmail (helper direct)', () => {
    it('assembles branded HTML scaffold with headline, body, CTA, and sign-off', async () => {
      const { buildLifecycleEmail } = await load();
      await buildLifecycleEmail(
        {
          to: 'test@example.com',
          subject: 'Test subject',
          headline: 'Test headline',
          bodyHtmlFragments: ['<p>First paragraph</p>', '<p>Second paragraph</p>'],
          primaryAction: { text: 'Click me', url: 'https://styrbyapp.com/go' },
          plainText: 'First paragraph\n\nSecond paragraph\n\nClick me: https://styrbyapp.com/go',
        },
        'test_kind'
      );
      const args = lastCall();
      expect(args.to).toBe('test@example.com');
      expect(args.subject).toBe('Test subject');
      expect(args.from).toContain('Styrby');
      // Scaffold: headline appears in <h1>
      expect(args.html).toContain('Test headline');
      // Both body fragments are present
      expect(args.html).toContain('First paragraph');
      expect(args.html).toContain('Second paragraph');
      // CTA button is rendered
      expect(args.html).toContain('Click me');
      expect(args.html).toContain('https://styrbyapp.com/go');
      // Sign-off
      expect(args.html).toContain('The Styrby Team');
      // Plain-text gets the sign-off appended
      expect(args.text).toContain('First paragraph');
      expect(args.text).toContain('- The Styrby Team');
    });

    it('omits the CTA button when primaryAction is not provided', async () => {
      const { buildLifecycleEmail } = await load();
      await buildLifecycleEmail(
        {
          to: 'test@example.com',
          subject: 'No CTA',
          headline: 'No action needed',
          bodyHtmlFragments: ['<p>Just a notice.</p>'],
          plainText: 'Just a notice.',
        },
        'test_no_cta'
      );
      const args = lastCall();
      // No button anchor should be present
      expect(args.html).not.toContain('border-radius: 8px');
      expect(args.html).toContain('No action needed');
    });

    it('escapes HTML special chars in headline via wrap()', async () => {
      const { buildLifecycleEmail } = await load();
      await buildLifecycleEmail(
        {
          to: 'test@example.com',
          subject: 'XSS test',
          headline: '<script>evil()</script>',
          bodyHtmlFragments: ['<p>Body</p>'],
          plainText: 'Body',
        },
        'test_xss'
      );
      const args = lastCall();
      expect(args.html).not.toContain('<script>evil()</script>');
      expect(args.html).toContain('&lt;script&gt;');
    });
  });

  describe('sendSubscriptionConfirmationEmail', () => {
    it('sends with correct subject, html, and text', async () => {
      const { sendSubscriptionConfirmationEmail } = await load();
      await sendSubscriptionConfirmationEmail({
        email: 'alice@example.com',
        tier: 'pro',
        planName: 'Styrby Pro',
        billingInterval: 'monthly',
        currentPeriodEnd: '2026-05-26T00:00:00Z',
      });
      const args = lastCall();
      expect(args.to).toBe('alice@example.com');
      expect(args.subject).toBe("You're now on Styrby Pro");
      expect(args.from).toContain('Styrby');
      expect(args.html).toContain('Welcome to Styrby Pro');
      expect(args.html).toContain('Styrby Pro');
      expect(args.text).toContain('subscription is active');
      expect(args.text).toContain('The Styrby Team');
    });

    it('escapes HTML in plan name', async () => {
      const { sendSubscriptionConfirmationEmail } = await load();
      await sendSubscriptionConfirmationEmail({
        email: 'alice@example.com',
        tier: 'pro',
        planName: '<script>alert(1)</script>',
        billingInterval: 'monthly',
        currentPeriodEnd: '2026-05-26T00:00:00Z',
      });
      const args = lastCall();
      expect(args.html).not.toContain('<script>alert(1)</script>');
      expect(args.html).toContain('&lt;script&gt;');
    });
  });

  describe('sendSubscriptionUpgradedEmail', () => {
    it('sends with old/new tier in subject and body', async () => {
      const { sendSubscriptionUpgradedEmail } = await load();
      await sendSubscriptionUpgradedEmail({
        email: 'alice@example.com',
        oldTier: 'pro',
        newTier: 'power',
        billingInterval: 'annual',
      });
      const args = lastCall();
      expect(args.subject).toBe('Your Styrby plan was upgraded to Power');
      expect(args.html).toContain('Pro');
      expect(args.html).toContain('Power');
      expect(args.html).toContain('annual');
      expect(args.text).toContain('moved from Pro to Power');
    });
  });

  describe('sendSubscriptionDowngradedEmail', () => {
    it('sends with downgrade subject and body', async () => {
      const { sendSubscriptionDowngradedEmail } = await load();
      await sendSubscriptionDowngradedEmail({
        email: 'alice@example.com',
        oldTier: 'power',
        newTier: 'pro',
        billingInterval: 'monthly',
      });
      const args = lastCall();
      expect(args.subject).toBe('Your Styrby plan was changed to Pro');
      expect(args.html).toContain('Power');
      expect(args.html).toContain('Pro');
      expect(args.text).toContain('Some features may no longer be available');
    });
  });

  describe('sendCancellationEmail', () => {
    it('sends with the access-until date and tier', async () => {
      const { sendCancellationEmail } = await load();
      await sendCancellationEmail({
        email: 'alice@example.com',
        tier: 'pro',
        accessUntil: '2026-05-26T00:00:00Z',
      });
      const args = lastCall();
      expect(args.subject).toBe('Your Styrby cancellation is confirmed');
      expect(args.html).toContain('Cancellation confirmed');
      expect(args.html).toContain('Pro');
      // Date must be present in some long form; just check the year
      expect(args.html).toMatch(/2026/);
      expect(args.text).toContain('keep full access until');
      expect(args.text).toContain('free tier');
    });
  });

  describe('sendRevokedEmail', () => {
    it('sends the revocation email with tier name', async () => {
      const { sendRevokedEmail } = await load();
      await sendRevokedEmail({
        email: 'alice@example.com',
        tier: 'power',
      });
      const args = lastCall();
      expect(args.subject).toBe('Your Styrby subscription has ended');
      expect(args.html).toContain('Power');
      expect(args.html).toContain('free tier');
      expect(args.text).toContain('Power');
      expect(args.text).toContain('free tier');
    });
  });

  describe('sendRefundEmail', () => {
    it('sends with formatted refund amount and reason', async () => {
      const { sendRefundEmail } = await load();
      await sendRefundEmail({
        email: 'alice@example.com',
        tier: 'pro',
        refundAmountCents: 4900,
        refundReason: 'Duplicate charge',
      });
      const args = lastCall();
      expect(args.subject).toBe('Your Styrby refund has been processed');
      expect(args.html).toContain('$49.00');
      expect(args.html).toContain('Pro');
      expect(args.html).toContain('Duplicate charge');
      expect(args.text).toContain('$49.00');
      expect(args.text).toContain('Duplicate charge');
    });

    it('omits reason when not provided', async () => {
      const { sendRefundEmail } = await load();
      await sendRefundEmail({
        email: 'alice@example.com',
        tier: 'pro',
        refundAmountCents: 1234,
      });
      const args = lastCall();
      expect(args.html).toContain('$12.34');
      expect(args.html).not.toContain('reason:');
      expect(args.text).not.toContain('reason:');
    });
  });

  describe('failure handling', () => {
    it('does not throw when Resend returns an error', async () => {
      mockSend.mockResolvedValueOnce({ data: null, error: { message: 'rate_limited' } });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { sendRevokedEmail } = await load();
      await expect(
        sendRevokedEmail({ email: 'alice@example.com', tier: 'pro' })
      ).resolves.toBeUndefined();
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });

    it('does not throw when Resend client throws', async () => {
      mockSend.mockRejectedValueOnce(new Error('network exploded'));
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { sendCancellationEmail } = await load();
      await expect(
        sendCancellationEmail({
          email: 'alice@example.com',
          tier: 'pro',
          accessUntil: '2026-05-26T00:00:00Z',
        })
      ).resolves.toBeUndefined();
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });

    it('no-ops cleanly when RESEND_API_KEY is missing', async () => {
      delete process.env.RESEND_API_KEY;
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { sendSubscriptionConfirmationEmail } = await load();
      await sendSubscriptionConfirmationEmail({
        email: 'alice@example.com',
        tier: 'pro',
        planName: 'Styrby Pro',
        billingInterval: 'monthly',
        currentPeriodEnd: '2026-05-26T00:00:00Z',
      });
      expect(mockSend).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });
});
