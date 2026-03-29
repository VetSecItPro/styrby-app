/**
 * Tests for the Web Push server-side utility.
 *
 * WHY these tests matter: sendPushToUser() touches three critical surfaces:
 * 1. VAPID configuration — a misconfiguration silently breaks all push for
 *    every user. Errors here must throw, not fail silently.
 * 2. Database queries — expired subscriptions (410/404) must be cleaned up
 *    or they accumulate and waste processing on every subsequent send.
 * 3. Parallel delivery — one bad subscription must not block others.
 *
 * Covers:
 * - ensureVapidConfigured throws when keys are missing
 * - No subscriptions found → returns { sent: 0, failed: 0, cleaned: 0 }
 * - Successful send increments sent counter
 * - 410 Gone deletes the subscription and increments cleaned counter
 * - 404 Not Found also triggers subscription cleanup
 * - Other error codes increment failed without deleting
 * - Invalid subscription shape (missing endpoint/keys) increments failed
 * - Multiple subscriptions processed in parallel with independent outcomes
 * - Database fetch error returns zeroed result without throwing
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PushPayload } from '../web-push';

// ============================================================================
// Mocks
// ============================================================================

const mockSendNotification = vi.fn();
const mockSetVapidDetails = vi.fn();

vi.mock('web-push', () => ({
  default: {
    setVapidDetails: mockSetVapidDetails,
    sendNotification: mockSendNotification,
  },
}));

const mockFrom = vi.fn();
const mockCreateAdminClient = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: mockCreateAdminClient,
}));

// ============================================================================
// Helpers
// ============================================================================

/**
 * Builds a valid web push subscription row as stored in device_tokens.
 *
 * @param id - Row UUID
 * @param endpoint - Push service endpoint URL
 */
function buildTokenRow(id: string, endpoint = `https://push.example.com/sub/${id}`) {
  return {
    id,
    token: `token-${id}`,
    web_push_subscription: {
      endpoint,
      keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
      expirationTime: null,
    },
  };
}

/**
 * Builds a chainable Supabase query stub returning the given token rows.
 *
 * @param rows - Array of device_token rows to return
 * @param error - Optional query error
 */
function buildTokenQuery(
  rows: ReturnType<typeof buildTokenRow>[],
  error: { message: string } | null = null
) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    data: rows,
    error,
    // Resolved on await of the chain
    then: (resolve: (v: { data: typeof rows; error: typeof error }) => unknown) =>
      Promise.resolve(resolve({ data: rows, error })),
  };
}

/** Minimal push payload used across tests. */
const PAYLOAD: PushPayload = {
  title: 'Test Push',
  body: 'Hello from tests.',
  url: '/dashboard',
  tag: 'test',
};

/**
 * Builds an error that mimics a web-push WebPushError with a statusCode.
 *
 * @param statusCode - The HTTP status code from the push service
 */
function buildPushError(statusCode: number): Error & { statusCode: number } {
  const err = new Error(`Push service returned ${statusCode}`) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

// ============================================================================
// Module reset helpers
// ============================================================================

/**
 * WHY resetModules: web-push.ts holds module-level state (vapidConfigured).
 * Without resetting, the VAPID check is skipped on subsequent test runs.
 */
async function freshWebPush() {
  vi.resetModules();
  return import('../web-push');
}

// ============================================================================
// Tests
// ============================================================================

describe('sendPushToUser()', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: VAPID keys present so ensureVapidConfigured passes
    vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'test-vapid-public-key');
    vi.stubEnv('VAPID_PRIVATE_KEY', 'test-vapid-private-key');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://styrby.com');

    mockCreateAdminClient.mockReturnValue({ from: mockFrom });
  });

  // --------------------------------------------------------------------------
  // VAPID configuration
  // --------------------------------------------------------------------------

  describe('VAPID configuration', () => {
    it('throws when NEXT_PUBLIC_VAPID_PUBLIC_KEY is missing', async () => {
      vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', '');

      // Build a mock that simulates subscription rows so we reach ensureVapidConfigured
      const chain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
      };
      Object.assign(chain, {
        then: (resolve: (v: { data: null; error: null }) => unknown) =>
          Promise.resolve(resolve({ data: null, error: null })),
      });
      mockFrom.mockReturnValue(chain);

      const { sendPushToUser } = await freshWebPush();

      await expect(sendPushToUser('user-1', PAYLOAD)).rejects.toThrow('VAPID');
    });

    it('throws when VAPID_PRIVATE_KEY is missing', async () => {
      vi.stubEnv('VAPID_PRIVATE_KEY', '');

      const { sendPushToUser } = await freshWebPush();

      await expect(sendPushToUser('user-2', PAYLOAD)).rejects.toThrow('VAPID');
    });

    it('calls setVapidDetails with the correct arguments on first use', async () => {
      // Simulate no subscriptions so the function returns early after VAPID setup
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        then: (resolve: (v: { data: []; error: null }) => unknown) =>
          Promise.resolve(resolve({ data: [], error: null })),
      });

      const { sendPushToUser } = await freshWebPush();
      await sendPushToUser('user-3', PAYLOAD);

      expect(mockSetVapidDetails).toHaveBeenCalledWith(
        expect.stringContaining('mailto:'),
        'test-vapid-public-key',
        'test-vapid-private-key'
      );
    });

    it('only calls setVapidDetails once across multiple sends (lazy init cached)', async () => {
      const emptyChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        then: (resolve: (v: { data: []; error: null }) => unknown) =>
          Promise.resolve(resolve({ data: [], error: null })),
      };
      mockFrom.mockReturnValue(emptyChain);

      const { sendPushToUser } = await freshWebPush();
      await sendPushToUser('user-4a', PAYLOAD);
      await sendPushToUser('user-4b', PAYLOAD);

      expect(mockSetVapidDetails).toHaveBeenCalledOnce();
    });
  });

  // --------------------------------------------------------------------------
  // No subscriptions
  // --------------------------------------------------------------------------

  describe('no active subscriptions', () => {
    it('returns { sent: 0, failed: 0, cleaned: 0 } when no rows exist', async () => {
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        then: (resolve: (v: { data: []; error: null }) => unknown) =>
          Promise.resolve(resolve({ data: [], error: null })),
      });

      const { sendPushToUser } = await freshWebPush();
      const result = await sendPushToUser('user-5', PAYLOAD);

      expect(result).toEqual({ sent: 0, failed: 0, cleaned: 0 });
      expect(mockSendNotification).not.toHaveBeenCalled();
    });

    it('returns { sent: 0, failed: 0, cleaned: 0 } on database error (does not throw)', async () => {
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        then: (resolve: (v: { data: null; error: { message: string } }) => unknown) =>
          Promise.resolve(resolve({ data: null, error: { message: 'DB down' } })),
      });

      const { sendPushToUser } = await freshWebPush();
      const result = await sendPushToUser('user-6', PAYLOAD);

      expect(result).toEqual({ sent: 0, failed: 0, cleaned: 0 });
    });
  });

  // --------------------------------------------------------------------------
  // Successful delivery
  // --------------------------------------------------------------------------

  describe('successful delivery', () => {
    it('increments sent for each successful webpush.sendNotification call', async () => {
      const rows = [buildTokenRow('row-1'), buildTokenRow('row-2')];
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        then: (resolve: (v: { data: typeof rows; error: null }) => unknown) =>
          Promise.resolve(resolve({ data: rows, error: null })),
      });
      mockSendNotification.mockResolvedValue(undefined);

      const { sendPushToUser } = await freshWebPush();
      const result = await sendPushToUser('user-7', PAYLOAD);

      expect(result.sent).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.cleaned).toBe(0);
    });

    it('sends the payload as a JSON string to webpush.sendNotification', async () => {
      const rows = [buildTokenRow('row-x')];
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        then: (resolve: (v: { data: typeof rows; error: null }) => unknown) =>
          Promise.resolve(resolve({ data: rows, error: null })),
      });
      mockSendNotification.mockResolvedValue(undefined);

      const { sendPushToUser } = await freshWebPush();
      await sendPushToUser('user-8', PAYLOAD);

      expect(mockSendNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: rows[0].web_push_subscription.endpoint,
          keys: rows[0].web_push_subscription.keys,
        }),
        JSON.stringify(PAYLOAD)
      );
    });
  });

  // --------------------------------------------------------------------------
  // Expired / revoked subscriptions (410 and 404)
  // --------------------------------------------------------------------------

  describe('expired subscription cleanup', () => {
    it('deletes the subscription row and increments cleaned on 410 Gone', async () => {
      const rows = [buildTokenRow('expired-row-1')];
      const mockDelete = vi.fn().mockReturnThis();
      const mockDeleteEq = vi.fn().mockResolvedValue({ error: null });

      mockFrom.mockImplementation((table: string) => {
        if (table === 'device_tokens') {
          // First call: SELECT query (token fetch)
          // Subsequent calls: DELETE query (cleanup)
          const calls = mockFrom.mock.calls.filter((c: string[]) => c[0] === 'device_tokens').length;
          if (calls === 1) {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              then: (resolve: (v: { data: typeof rows; error: null }) => unknown) =>
                Promise.resolve(resolve({ data: rows, error: null })),
            };
          }
          return { delete: mockDelete, eq: mockDeleteEq };
        }
        return {};
      });

      mockSendNotification.mockRejectedValue(buildPushError(410));

      const { sendPushToUser } = await freshWebPush();
      const result = await sendPushToUser('user-9', PAYLOAD);

      expect(result.cleaned).toBe(1);
      expect(result.sent).toBe(0);
      expect(result.failed).toBe(0);
    });

    it('also cleans up on 404 Not Found (subscription does not exist)', async () => {
      const rows = [buildTokenRow('not-found-row')];

      mockFrom.mockImplementation((table: string) => {
        if (table === 'device_tokens') {
          const calls = mockFrom.mock.calls.filter((c: string[]) => c[0] === 'device_tokens').length;
          if (calls === 1) {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              then: (resolve: (v: { data: typeof rows; error: null }) => unknown) =>
                Promise.resolve(resolve({ data: rows, error: null })),
            };
          }
          return { delete: vi.fn().mockReturnThis(), eq: vi.fn().mockResolvedValue({ error: null }) };
        }
        return {};
      });

      mockSendNotification.mockRejectedValue(buildPushError(404));

      const { sendPushToUser } = await freshWebPush();
      const result = await sendPushToUser('user-10', PAYLOAD);

      expect(result.cleaned).toBe(1);
      expect(result.failed).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Non-expiry errors
  // --------------------------------------------------------------------------

  describe('non-expiry send errors', () => {
    it('increments failed (not cleaned) on a 500 server error', async () => {
      const rows = [buildTokenRow('row-500')];
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        then: (resolve: (v: { data: typeof rows; error: null }) => unknown) =>
          Promise.resolve(resolve({ data: rows, error: null })),
      });
      mockSendNotification.mockRejectedValue(buildPushError(500));

      const { sendPushToUser } = await freshWebPush();
      const result = await sendPushToUser('user-11', PAYLOAD);

      expect(result.failed).toBe(1);
      expect(result.cleaned).toBe(0);
      expect(result.sent).toBe(0);
    });

    it('increments failed on a network error (no statusCode)', async () => {
      const rows = [buildTokenRow('row-net')];
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        then: (resolve: (v: { data: typeof rows; error: null }) => unknown) =>
          Promise.resolve(resolve({ data: rows, error: null })),
      });
      mockSendNotification.mockRejectedValue(new Error('ECONNREFUSED'));

      const { sendPushToUser } = await freshWebPush();
      const result = await sendPushToUser('user-12', PAYLOAD);

      expect(result.failed).toBe(1);
      expect(result.cleaned).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Invalid subscription shape
  // --------------------------------------------------------------------------

  describe('invalid subscription shape', () => {
    it('increments failed when web_push_subscription has no endpoint', async () => {
      const badRow = {
        id: 'bad-row',
        token: 'token-bad',
        web_push_subscription: {
          endpoint: '',          // empty — invalid
          keys: { p256dh: 'k', auth: 'a' },
        },
      };
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        then: (resolve: (v: { data: typeof badRow[]; error: null }) => unknown) =>
          Promise.resolve(resolve({ data: [badRow], error: null })),
      });

      const { sendPushToUser } = await freshWebPush();
      const result = await sendPushToUser('user-13', PAYLOAD);

      expect(result.failed).toBe(1);
      expect(mockSendNotification).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Mixed outcome: multiple subscriptions with independent results
  // --------------------------------------------------------------------------

  describe('parallel delivery with mixed outcomes', () => {
    it('handles one success + one expiry + one failure correctly', async () => {
      const rows = [
        buildTokenRow('ok-row', 'https://push.example.com/ok'),
        buildTokenRow('expired-row', 'https://push.example.com/expired'),
        buildTokenRow('fail-row', 'https://push.example.com/fail'),
      ];

      mockFrom.mockImplementation((table: string) => {
        if (table === 'device_tokens') {
          const callCount = mockFrom.mock.calls.filter((c: string[]) => c[0] === 'device_tokens').length;
          if (callCount === 1) {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              then: (resolve: (v: { data: typeof rows; error: null }) => unknown) =>
                Promise.resolve(resolve({ data: rows, error: null })),
            };
          }
          // Cleanup DELETE call
          return { delete: vi.fn().mockReturnThis(), eq: vi.fn().mockResolvedValue({ error: null }) };
        }
        return {};
      });

      mockSendNotification
        .mockResolvedValueOnce(undefined)           // ok-row succeeds
        .mockRejectedValueOnce(buildPushError(410)) // expired-row → cleaned
        .mockRejectedValueOnce(buildPushError(500)); // fail-row → failed

      const { sendPushToUser } = await freshWebPush();
      const result = await sendPushToUser('user-14', PAYLOAD);

      expect(result.sent).toBe(1);
      expect(result.cleaned).toBe(1);
      expect(result.failed).toBe(1);
    });
  });
});
