/**
 * Resend Email Client Tests
 *
 * Tests the email sending utilities in lib/resend.ts.
 *
 * WHY: Email is used for critical notifications — welcome emails, budget
 * alerts, payment failures, subscription changes. Testing ensures:
 * 1. The graceful no-op when RESEND_API_KEY is missing
 * 2. Correct email composition for each template type
 * 3. Error handling doesn't crash the calling code
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mocks
// ============================================================================

const mockSend = vi.fn();

vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: {
      send: mockSend,
    },
  })),
}));

// Mock all email template components as simple functions
vi.mock('@/emails/welcome', () => ({ default: vi.fn(() => 'WelcomeEmail') }));
vi.mock('@/emails/subscription-confirmed', () => ({ default: vi.fn(() => 'SubscriptionConfirmedEmail') }));
vi.mock('@/emails/subscription-canceled', () => ({ default: vi.fn(() => 'SubscriptionCanceledEmail') }));
vi.mock('@/emails/payment-failed', () => ({ default: vi.fn(() => 'PaymentFailedEmail') }));
vi.mock('@/emails/budget-alert', () => ({ default: vi.fn(() => 'BudgetAlertEmail') }));
vi.mock('@/emails/weekly-summary', () => ({ default: vi.fn(() => 'WeeklySummaryEmail') }));

// ============================================================================
// Tests
// ============================================================================

describe('resend email client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset module state by clearing the cached client
    vi.resetModules();
  });

  describe('sendEmail', () => {
    it('returns error when RESEND_API_KEY is not set', async () => {
      vi.stubEnv('RESEND_API_KEY', '');

      // Re-import after resetting modules to get fresh state
      const { sendEmail } = await import('../resend');

      const result = await sendEmail({
        to: 'test@example.com',
        subject: 'Test',
        react: null as unknown as React.ReactElement,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('disabled');
    });

    it('sends email successfully when configured', async () => {
      vi.stubEnv('RESEND_API_KEY', 're_test_12345');

      mockSend.mockResolvedValueOnce({
        data: { id: 'email-id-123' },
        error: null,
      });

      const { sendEmail } = await import('../resend');

      const result = await sendEmail({
        to: 'user@example.com',
        subject: 'Test Subject',
        react: null as unknown as React.ReactElement,
      });

      expect(result.success).toBe(true);
      expect(result.id).toBe('email-id-123');
    });

    it('handles Resend API errors gracefully', async () => {
      vi.stubEnv('RESEND_API_KEY', 're_test_12345');

      mockSend.mockResolvedValueOnce({
        data: null,
        error: { statusCode: 422, message: 'Invalid recipient' },
      });

      const { sendEmail } = await import('../resend');

      const result = await sendEmail({
        to: 'invalid',
        subject: 'Test',
        react: null as unknown as React.ReactElement,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('handles network/exception errors gracefully', async () => {
      vi.stubEnv('RESEND_API_KEY', 're_test_12345');

      mockSend.mockRejectedValueOnce(new Error('Network timeout'));

      const { sendEmail } = await import('../resend');

      const result = await sendEmail({
        to: 'test@example.com',
        subject: 'Test',
        react: null as unknown as React.ReactElement,
      });

      expect(result.success).toBe(false);
    });
  });

  describe('typed email senders', () => {
    beforeEach(() => {
      vi.stubEnv('RESEND_API_KEY', 're_test_12345');
      mockSend.mockResolvedValue({
        data: { id: 'email-id' },
        error: null,
      });
    });

    it('sendWelcomeEmail sends with correct subject', async () => {
      const { sendWelcomeEmail } = await import('../resend');

      await sendWelcomeEmail({
        email: 'new@example.com',
        displayName: 'John',
      });

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'new@example.com',
          subject: 'Welcome to Styrby!',
        })
      );
    });

    it('sendSubscriptionConfirmedEmail includes tier name in subject', async () => {
      const { sendSubscriptionConfirmedEmail } = await import('../resend');

      await sendSubscriptionConfirmedEmail({
        email: 'user@example.com',
        tier: 'pro',
        amount: '$19',
        billingCycle: 'monthly',
        nextBillingDate: '2026-03-01',
      });

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'user@example.com',
          subject: expect.stringContaining('Pro'),
        })
      );
    });

    it('sendSubscriptionCanceledEmail sends correctly', async () => {
      const { sendSubscriptionCanceledEmail } = await import('../resend');

      await sendSubscriptionCanceledEmail({
        email: 'user@example.com',
        tier: 'power',
        accessUntil: '2026-03-15',
      });

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'user@example.com',
          subject: expect.stringContaining('canceled'),
        })
      );
    });

    it('sendPaymentFailedEmail sends correctly', async () => {
      const { sendPaymentFailedEmail } = await import('../resend');

      await sendPaymentFailedEmail({
        email: 'user@example.com',
        tier: 'pro',
        amount: '$19',
        retryDate: '2026-02-08',
      });

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'user@example.com',
          subject: expect.stringContaining('payment failed'),
        })
      );
    });

    it('sendBudgetAlertEmail includes alert name in subject', async () => {
      const { sendBudgetAlertEmail } = await import('../resend');

      await sendBudgetAlertEmail({
        email: 'user@example.com',
        alertName: 'Daily limit exceeded',
        threshold: '$10',
        currentSpend: '$12.50',
        period: 'daily',
        percentUsed: 125,
      });

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'user@example.com',
          subject: expect.stringContaining('Daily limit exceeded'),
        })
      );
    });

    it('sendWeeklySummaryEmail includes cost in subject', async () => {
      const { sendWeeklySummaryEmail } = await import('../resend');

      await sendWeeklySummaryEmail({
        email: 'user@example.com',
        weekOf: '2026-01-27',
        totalCost: '$42.50',
        totalSessions: 15,
        totalTokens: '1.2M',
        costChange: -5,
        agentStats: [
          { name: 'Claude', sessions: 10, cost: '$30', tokens: '800K' },
        ],
      });

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'user@example.com',
          subject: expect.stringContaining('$42.50'),
        })
      );
    });
  });
});
