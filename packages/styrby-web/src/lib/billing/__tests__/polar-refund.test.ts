/**
 * Tests for lib/billing/polar-refund.ts
 *
 * Unit tests only — no network calls. The Polar SDK client and the env module
 * are mocked at the module boundary.
 *
 * WHY we mock `../polar` (not the SDK directly):
 * `polar-refund.ts` imports the singleton `polar` client from `lib/polar.ts`
 * (the same pattern as cancelSubscription, getSubscription, etc.). Mocking
 * the SDK at import level would require intercepting `@polar-sh/sdk` globally
 * and re-exporting a typed stub — fragile. Mocking `../polar` is simpler and
 * exactly what the other billing tests do.
 *
 * WHY we mock `../env`:
 * `requireEnv('POLAR_ACCESS_TOKEN')` is called at the top of createPolarRefund
 * to fail fast on misconfiguration. In test, we control that call so we can
 * test the missing-token path without mutating process.env.
 *
 * Test matrix:
 * 1. Happy path — SDK returns a valid Refund → returns extracted fields
 * 2. RefundedAlready — SDK throws → RefundError('idempotent-replay')
 * 3. RefundAmountTooHigh — SDK throws → RefundError('invalid')
 * 4. HTTPValidationError / SDKValidationError — SDK throws → RefundError('invalid')
 * 5. SDKError (5xx wrap) — SDK throws → RefundError('polar-error')
 * 6. RequestTimeoutError — SDK throws → RefundError('network')
 * 7. ConnectionError — SDK throws → RefundError('network')
 * 8. Missing POLAR_ACCESS_TOKEN — requireEnv throws → RefundError('config')
 * 9. SDK returns undefined → RefundError('polar-error')
 * 10. Idempotency-Key header assertion — createRefund called with correct options
 * 11. Request body shape — SDK called with orderId, amount, reason, comment, metadata
 * 12. reason mapping — various reason strings → correct RefundReason enum values
 * 13. Input validation — empty subscriptionId, orderId; non-positive amountCents;
 *     oversized reason; empty idempotencyKey → RefundError('invalid')
 *
 * SOC2 CC7.2: Test coverage of refund audit-trail fields (refundId, eventId,
 * rawResponse) ensures the external-service event log is complete.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoist mock stubs ─────────────────────────────────────────────────────────
// WHY vi.hoisted: vi.mock factories are hoisted to the top of the file by
// Vitest's transform — before any `const` declarations. Variables declared
// with `const` outside the factory are in the temporal dead zone when the
// factory runs, causing a ReferenceError. vi.hoisted() runs its callback in
// the same hoisted position as vi.mock(), so the returned refs are valid when
// the factories execute.
const { mockRefundsCreate, mockOrdersList, mockRequireEnv } = vi.hoisted(() => ({
  mockRefundsCreate: vi.fn(),
  mockOrdersList: vi.fn(),
  mockRequireEnv: vi.fn().mockReturnValue('test-token'),
}));

vi.mock('../../polar', () => ({
  polar: {
    refunds: {
      create: mockRefundsCreate,
    },
    orders: {
      list: mockOrdersList,
    },
  },
}));

// ── Mock requireEnv ──────────────────────────────────────────────────────────
// Default: returns 'test-token' (token present). Individual tests override
// with mockRequireEnv.mockImplementationOnce().

vi.mock('../../env', () => ({
  requireEnv: (...args: unknown[]) => mockRequireEnv(...args),
  getEnv: vi.fn(),
  getEnvOr: vi.fn(),
  getHttpsUrlEnv: vi.fn(),
}));

// ── Import SUT after mocks ───────────────────────────────────────────────────
import {
  createPolarRefund,
  findRefundableOrderForSubscription,
  RefundError,
} from '../polar-refund';
import { RefundReason } from '@polar-sh/sdk/models/components/refundreason';

// ── Shared test fixtures ─────────────────────────────────────────────────────

/** Minimal valid params for happy-path tests. */
const BASE_PARAMS = {
  subscriptionId: 'sub_abc123',
  orderId: 'ord_xyz456',
  amountCents: 4900,
  reason: 'customer_request',
  idempotencyKey: 'ikey-admin-001',
};

/** Minimal valid Polar Refund response object. */
const MOCK_REFUND = {
  id: 'refund_001',
  createdAt: new Date('2026-04-23T12:00:00Z'),
  modifiedAt: new Date('2026-04-23T12:00:01Z'),
  metadata: { subscriptionId: 'sub_abc123', idempotencyKey: 'ikey-admin-001' },
  status: 'succeeded',
  reason: RefundReason.CustomerRequest,
  amount: 4900,
  taxAmount: 0,
  currency: 'usd',
  organizationId: 'org_001',
  orderId: 'ord_xyz456',
  subscriptionId: 'sub_abc123',
  customerId: 'cus_001',
  revokeBenefits: false,
};

// ─────────────────────────────────────────────────────────────────────────────

describe('createPolarRefund', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: token present, SDK succeeds.
    mockRequireEnv.mockReturnValue('test-token');
    mockRefundsCreate.mockResolvedValue(MOCK_REFUND);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── 1. Happy path ──────────────────────────────────────────────────────────

  describe('happy path', () => {
    it('returns refundId, eventId, and rawResponse on successful SDK call', async () => {
      const result = await createPolarRefund(BASE_PARAMS);

      expect(result.refundId).toBe('refund_001');
      // WHY same as refundId: see implementation note — Polar SDK Refund type
      // does not expose a separate eventId; refund.id is the correlation handle.
      expect(result.eventId).toBe('refund_001');
      expect(result.rawResponse).toStrictEqual(MOCK_REFUND);
    });

    it('calls polar.refunds.create with correct orderId and amount', async () => {
      await createPolarRefund(BASE_PARAMS);

      expect(mockRefundsCreate).toHaveBeenCalledOnce();
      const [payload] = mockRefundsCreate.mock.calls[0] as [{ orderId: string; amount: number }];
      expect(payload.orderId).toBe('ord_xyz456');
      expect(payload.amount).toBe(4900);
    });

    it('maps customer_request reason string to RefundReason.CustomerRequest enum', async () => {
      await createPolarRefund({ ...BASE_PARAMS, reason: 'customer_request' });

      const [payload] = mockRefundsCreate.mock.calls[0] as [{ reason: string }];
      expect(payload.reason).toBe(RefundReason.CustomerRequest);
    });

    it('stores original reason text in comment field (max 500 chars)', async () => {
      const longReason = 'a'.repeat(500);
      await createPolarRefund({ ...BASE_PARAMS, reason: longReason });

      const [payload] = mockRefundsCreate.mock.calls[0] as [{ comment: string }];
      expect(payload.comment).toBe(longReason);
      expect(payload.comment.length).toBe(500);
    });

    it('stores subscriptionId and idempotencyKey in metadata', async () => {
      await createPolarRefund(BASE_PARAMS);

      const [payload] = mockRefundsCreate.mock.calls[0] as [
        { metadata: Record<string, string> },
      ];
      expect(payload.metadata.subscriptionId).toBe('sub_abc123');
      expect(payload.metadata.idempotencyKey).toBe('ikey-admin-001');
    });

    it('passes Idempotency-Key header via fetchOptions', async () => {
      await createPolarRefund(BASE_PARAMS);

      const [, options] = mockRefundsCreate.mock.calls[0] as [
        unknown,
        { fetchOptions: { headers: Record<string, string> } },
      ];
      expect(options.fetchOptions.headers['Idempotency-Key']).toBe('ikey-admin-001');
    });

    it('passes an AbortSignal via fetchOptions for timeout', async () => {
      await createPolarRefund(BASE_PARAMS);

      const [, options] = mockRefundsCreate.mock.calls[0] as [
        unknown,
        { fetchOptions: { signal: AbortSignal } },
      ];
      expect(options.fetchOptions.signal).toBeDefined();
      // AbortSignal.timeout() returns an AbortSignal — verify it's the right type.
      expect(options.fetchOptions.signal).toBeInstanceOf(AbortSignal);
    });
  });

  // ── 2. Idempotent replay (RefundedAlready) ─────────────────────────────────

  describe('RefundedAlready (idempotent-replay)', () => {
    it('throws RefundError with code idempotent-replay when SDK throws RefundedAlready', async () => {
      const sdkErr = new Error('Order already refunded');
      sdkErr.name = 'RefundedAlready';
      mockRefundsCreate.mockRejectedValue(sdkErr);

      await expect(createPolarRefund(BASE_PARAMS)).rejects.toThrow(RefundError);

      try {
        await createPolarRefund(BASE_PARAMS);
      } catch (err) {
        expect((err as RefundError).code).toBe('idempotent-replay');
        expect((err as RefundError).rawBody).toBe(sdkErr);
      }
    });

    it('error message includes orderId and idempotencyKey for traceability', async () => {
      const sdkErr = new Error('Order already refunded');
      sdkErr.name = 'RefundedAlready';
      mockRefundsCreate.mockRejectedValue(sdkErr);

      await expect(createPolarRefund(BASE_PARAMS)).rejects.toThrow(
        /ord_xyz456/,
      );
      await expect(createPolarRefund(BASE_PARAMS)).rejects.toThrow(
        /ikey-admin-001/,
      );
    });
  });

  // ── 3. RefundAmountTooHigh (invalid) ──────────────────────────────────────

  describe('RefundAmountTooHigh', () => {
    it('throws RefundError with code invalid', async () => {
      const sdkErr = new Error('Amount exceeds original charge');
      sdkErr.name = 'RefundAmountTooHigh';
      mockRefundsCreate.mockRejectedValue(sdkErr);

      const call = createPolarRefund({ ...BASE_PARAMS, amountCents: 999_999 });
      await expect(call).rejects.toThrow(RefundError);

      try {
        await createPolarRefund({ ...BASE_PARAMS, amountCents: 999_999 });
      } catch (err) {
        expect((err as RefundError).code).toBe('invalid');
      }
    });
  });

  // ── 4. HTTPValidationError / SDKValidationError (invalid) ─────────────────

  describe('HTTPValidationError and SDKValidationError', () => {
    it.each(['HTTPValidationError', 'SDKValidationError'])(
      'throws RefundError(invalid) for %s',
      async (errName) => {
        const sdkErr = new Error(`Validation failure: ${errName}`);
        sdkErr.name = errName;
        mockRefundsCreate.mockRejectedValue(sdkErr);

        try {
          await createPolarRefund(BASE_PARAMS);
          expect.fail('should have thrown');
        } catch (err) {
          expect(err).toBeInstanceOf(RefundError);
          expect((err as RefundError).code).toBe('invalid');
        }
      },
    );
  });

  // ── 5. SDKError (polar-error) ─────────────────────────────────────────────

  describe('SDKError (5xx wrap)', () => {
    it('throws RefundError with code polar-error', async () => {
      const sdkErr = new Error('Internal server error');
      sdkErr.name = 'SDKError';
      mockRefundsCreate.mockRejectedValue(sdkErr);

      try {
        await createPolarRefund(BASE_PARAMS);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(RefundError);
        expect((err as RefundError).code).toBe('polar-error');
      }
    });
  });

  // ── 6 & 7. Timeout + network errors ──────────────────────────────────────

  describe('network errors', () => {
    it.each(['RequestAbortedError', 'RequestTimeoutError'])(
      'throws RefundError(network) for %s',
      async (errName) => {
        const sdkErr = new Error('Timeout');
        sdkErr.name = errName;
        mockRefundsCreate.mockRejectedValue(sdkErr);

        try {
          await createPolarRefund(BASE_PARAMS);
          expect.fail('should have thrown');
        } catch (err) {
          expect(err).toBeInstanceOf(RefundError);
          expect((err as RefundError).code).toBe('network');
        }
      },
    );

    it('throws RefundError(network) for ConnectionError', async () => {
      const sdkErr = new Error('ECONNREFUSED');
      sdkErr.name = 'ConnectionError';
      mockRefundsCreate.mockRejectedValue(sdkErr);

      try {
        await createPolarRefund(BASE_PARAMS);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(RefundError);
        expect((err as RefundError).code).toBe('network');
      }
    });
  });

  // ── 8. Missing POLAR_ACCESS_TOKEN ─────────────────────────────────────────

  describe('missing POLAR_ACCESS_TOKEN', () => {
    it('throws RefundError(config) when requireEnv throws', async () => {
      mockRequireEnv.mockImplementationOnce(() => {
        throw new Error(
          'Required environment variable "POLAR_ACCESS_TOKEN" is unset or blank.',
        );
      });

      try {
        await createPolarRefund(BASE_PARAMS);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(RefundError);
        expect((err as RefundError).code).toBe('config');
        expect((err as RefundError).message).toMatch(/POLAR_ACCESS_TOKEN/);
      }
    });

    it('does not call polar.refunds.create when token is missing', async () => {
      mockRequireEnv.mockImplementationOnce(() => {
        throw new Error('unset');
      });

      try {
        await createPolarRefund(BASE_PARAMS);
      } catch {
        // expected
      }

      expect(mockRefundsCreate).not.toHaveBeenCalled();
    });
  });

  // ── 9. SDK returns undefined ──────────────────────────────────────────────

  describe('SDK returns undefined', () => {
    it('throws RefundError(polar-error) when create resolves to undefined', async () => {
      mockRefundsCreate.mockResolvedValue(undefined);

      try {
        await createPolarRefund(BASE_PARAMS);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(RefundError);
        expect((err as RefundError).code).toBe('polar-error');
        expect((err as RefundError).message).toMatch(/undefined/i);
      }
    });
  });

  // ── 10. Reason string → RefundReason enum mapping ─────────────────────────

  describe('reason mapping', () => {
    const cases: Array<[string, string]> = [
      ['duplicate charge', RefundReason.Duplicate],
      ['DUPLICATE', RefundReason.Duplicate],
      ['fraudulent transaction', RefundReason.Fraudulent],
      ['customer request', RefundReason.CustomerRequest],
      ['customer_request', RefundReason.CustomerRequest],
      ['service disruption', RefundReason.ServiceDisruption],
      ['service_disruption', RefundReason.ServiceDisruption],
      ['outage', RefundReason.ServiceDisruption],
      ['downtime', RefundReason.ServiceDisruption],
      ['satisfaction guarantee', RefundReason.SatisfactionGuarantee],
      ['money back guarantee', RefundReason.SatisfactionGuarantee],
      ['generic admin note', RefundReason.Other],
      ['', RefundReason.Other],
    ];

    it.each(cases)(
      'maps reason "%s" to RefundReason %s',
      async (reasonInput, expectedEnum) => {
        await createPolarRefund({ ...BASE_PARAMS, reason: reasonInput });

        const [payload] = mockRefundsCreate.mock.calls[0] as [{ reason: string }];
        expect(payload.reason).toBe(expectedEnum);
      },
    );
  });

  // ── 11. Input validation ──────────────────────────────────────────────────

  describe('input validation', () => {
    it('throws RefundError(invalid) for empty subscriptionId', async () => {
      const call = createPolarRefund({ ...BASE_PARAMS, subscriptionId: '   ' });
      await expect(call).rejects.toThrow(RefundError);
      try {
        await createPolarRefund({ ...BASE_PARAMS, subscriptionId: '' });
      } catch (err) {
        expect((err as RefundError).code).toBe('invalid');
      }
    });

    it('throws RefundError(invalid) for empty orderId', async () => {
      try {
        await createPolarRefund({ ...BASE_PARAMS, orderId: '' });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(RefundError);
        expect((err as RefundError).code).toBe('invalid');
      }
    });

    it('throws RefundError(invalid) for amountCents of 0', async () => {
      try {
        await createPolarRefund({ ...BASE_PARAMS, amountCents: 0 });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(RefundError);
        expect((err as RefundError).code).toBe('invalid');
      }
    });

    it('throws RefundError(invalid) for negative amountCents', async () => {
      try {
        await createPolarRefund({ ...BASE_PARAMS, amountCents: -100 });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(RefundError);
        expect((err as RefundError).code).toBe('invalid');
      }
    });

    it('throws RefundError(invalid) for non-integer amountCents', async () => {
      try {
        await createPolarRefund({ ...BASE_PARAMS, amountCents: 49.99 });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(RefundError);
        expect((err as RefundError).code).toBe('invalid');
      }
    });

    it('throws RefundError(invalid) when reason exceeds 500 chars', async () => {
      const tooLong = 'x'.repeat(501);
      try {
        await createPolarRefund({ ...BASE_PARAMS, reason: tooLong });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(RefundError);
        expect((err as RefundError).code).toBe('invalid');
        expect((err as RefundError).message).toMatch(/501/);
      }
    });

    it('throws RefundError(invalid) for empty idempotencyKey', async () => {
      try {
        await createPolarRefund({ ...BASE_PARAMS, idempotencyKey: '  ' });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(RefundError);
        expect((err as RefundError).code).toBe('invalid');
      }
    });

    it('does not call polar.refunds.create on validation failure', async () => {
      try {
        await createPolarRefund({ ...BASE_PARAMS, amountCents: 0 });
      } catch {
        // expected
      }
      expect(mockRefundsCreate).not.toHaveBeenCalled();
    });
  });

  // ── 12. Fallback error classification ─────────────────────────────────────

  describe('unknown SDK error shape', () => {
    it('throws RefundError(polar-error) for an unrecognized error class', async () => {
      const unknownErr = new Error('Something weird happened');
      unknownErr.name = 'WeirdPolarError';
      mockRefundsCreate.mockRejectedValue(unknownErr);

      try {
        await createPolarRefund(BASE_PARAMS);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(RefundError);
        expect((err as RefundError).code).toBe('polar-error');
      }
    });

    it('throws RefundError(polar-error) for a plain string rejection', async () => {
      mockRefundsCreate.mockRejectedValue('plain string error');

      try {
        await createPolarRefund(BASE_PARAMS);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(RefundError);
        expect((err as RefundError).code).toBe('polar-error');
      }
    });
  });

  // ── 13. RefundError class contract ───────────────────────────────────────

  describe('RefundError class', () => {
    it('is an instance of Error', () => {
      const err = new RefundError('network', 'test');
      expect(err).toBeInstanceOf(Error);
    });

    it('has name "RefundError"', () => {
      const err = new RefundError('polar-error', 'test');
      expect(err.name).toBe('RefundError');
    });

    it('exposes code and rawBody', () => {
      const raw = { status: 422 };
      const err = new RefundError('invalid', 'bad request', raw);
      expect(err.code).toBe('invalid');
      expect(err.rawBody).toBe(raw);
    });

    it('rawBody is undefined when not provided', () => {
      const err = new RefundError('config', 'missing token');
      expect(err.rawBody).toBeUndefined();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// findRefundableOrderForSubscription (SEC-REFUND-001)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds a fake async-iterable page result mirroring Polar SDK 0.29.3's
 * `orders.list` return shape. The SDK returns an async iterable of pages,
 * each `{ result: { items: Order[] } }`. We provide one page per call here;
 * tests that need pagination can override.
 */
function makeOrdersPage(items: Array<Record<string, unknown>>) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { result: { items } };
    },
  };
}

describe('findRefundableOrderForSubscription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the first paid order matching the subscription with refundable balance', async () => {
    mockOrdersList.mockResolvedValue(
      makeOrdersPage([
        // Most-recent first per `-created_at` sort
        {
          id: 'ord_recent',
          status: 'paid',
          amount: 4900,
          refundedAmount: 0,
          subscriptionId: 'sub_abc',
        },
        {
          id: 'ord_older',
          status: 'paid',
          amount: 4900,
          refundedAmount: 0,
          subscriptionId: 'sub_abc',
        },
      ]),
    );

    const result = await findRefundableOrderForSubscription('cus_123', 'sub_abc');

    expect(result.orderId).toBe('ord_recent');
    expect(result.refundableCents).toBe(4900);
    expect(mockOrdersList).toHaveBeenCalledWith({
      customerId: 'cus_123',
      sorting: ['-created_at'],
      limit: 50,
    });
  });

  it('returns refundableCents as amount minus refundedAmount', async () => {
    mockOrdersList.mockResolvedValue(
      makeOrdersPage([
        { id: 'ord_partial', status: 'paid', amount: 10_000, refundedAmount: 3_000, subscriptionId: 'sub_abc' },
      ]),
    );

    const result = await findRefundableOrderForSubscription('cus_123', 'sub_abc');
    expect(result.refundableCents).toBe(7_000);
  });

  it('skips orders for a different subscription_id', async () => {
    mockOrdersList.mockResolvedValue(
      makeOrdersPage([
        { id: 'ord_other_sub', status: 'paid', amount: 4900, refundedAmount: 0, subscriptionId: 'sub_OTHER' },
        { id: 'ord_match', status: 'paid', amount: 4900, refundedAmount: 0, subscriptionId: 'sub_abc' },
      ]),
    );

    const result = await findRefundableOrderForSubscription('cus_123', 'sub_abc');
    expect(result.orderId).toBe('ord_match');
  });

  it('skips fully-refunded orders (remaining = 0)', async () => {
    mockOrdersList.mockResolvedValue(
      makeOrdersPage([
        { id: 'ord_fully_refunded', status: 'paid', amount: 4900, refundedAmount: 4900, subscriptionId: 'sub_abc' },
        { id: 'ord_partial', status: 'paid', amount: 4900, refundedAmount: 1000, subscriptionId: 'sub_abc' },
      ]),
    );

    const result = await findRefundableOrderForSubscription('cus_123', 'sub_abc');
    expect(result.orderId).toBe('ord_partial');
    expect(result.refundableCents).toBe(3900);
  });

  it('skips non-paid orders (e.g., pending, failed)', async () => {
    mockOrdersList.mockResolvedValue(
      makeOrdersPage([
        { id: 'ord_pending', status: 'pending', amount: 4900, refundedAmount: 0, subscriptionId: 'sub_abc' },
        { id: 'ord_failed', status: 'failed', amount: 4900, refundedAmount: 0, subscriptionId: 'sub_abc' },
        { id: 'ord_paid', status: 'paid', amount: 4900, refundedAmount: 0, subscriptionId: 'sub_abc' },
      ]),
    );

    const result = await findRefundableOrderForSubscription('cus_123', 'sub_abc');
    expect(result.orderId).toBe('ord_paid');
  });

  it('accepts snake_case subscription_id from SDK serializer (defensive)', async () => {
    mockOrdersList.mockResolvedValue(
      makeOrdersPage([
        { id: 'ord_snake', status: 'paid', amount: 4900, refunded_amount: 0, subscription_id: 'sub_abc' },
      ]),
    );

    const result = await findRefundableOrderForSubscription('cus_123', 'sub_abc');
    expect(result.orderId).toBe('ord_snake');
  });

  it('throws RefundError(invalid) when no matching orders exist', async () => {
    mockOrdersList.mockResolvedValue(makeOrdersPage([]));

    await expect(
      findRefundableOrderForSubscription('cus_123', 'sub_abc'),
    ).rejects.toThrow(RefundError);
    await expect(
      findRefundableOrderForSubscription('cus_123', 'sub_abc'),
    ).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringContaining('No refundable orders'),
    });
  });

  it('throws RefundError(invalid) when all matching orders are fully refunded', async () => {
    mockOrdersList.mockResolvedValue(
      makeOrdersPage([
        { id: 'ord_a', status: 'paid', amount: 4900, refundedAmount: 4900, subscriptionId: 'sub_abc' },
        { id: 'ord_b', status: 'paid', amount: 4900, refundedAmount: 4900, subscriptionId: 'sub_abc' },
      ]),
    );

    await expect(
      findRefundableOrderForSubscription('cus_123', 'sub_abc'),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('throws RefundError(network) on AbortError from SDK', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    mockOrdersList.mockRejectedValue(abortErr);

    await expect(
      findRefundableOrderForSubscription('cus_123', 'sub_abc'),
    ).rejects.toMatchObject({ code: 'network' });
  });

  it('throws RefundError(network) on TypeError ("fetch failed") from SDK', async () => {
    mockOrdersList.mockRejectedValue(new TypeError('fetch failed'));

    await expect(
      findRefundableOrderForSubscription('cus_123', 'sub_abc'),
    ).rejects.toMatchObject({ code: 'network' });
  });

  it('throws RefundError(polar-error) on generic SDK error', async () => {
    mockOrdersList.mockRejectedValue(new Error('Polar 503 service unavailable'));

    await expect(
      findRefundableOrderForSubscription('cus_123', 'sub_abc'),
    ).rejects.toMatchObject({ code: 'polar-error' });
  });

  it('throws RefundError(invalid) on empty customerId', async () => {
    await expect(
      findRefundableOrderForSubscription('', 'sub_abc'),
    ).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringContaining('customerId'),
    });
    expect(mockOrdersList).not.toHaveBeenCalled();
  });

  it('throws RefundError(invalid) on empty subscriptionId', async () => {
    await expect(
      findRefundableOrderForSubscription('cus_123', ''),
    ).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringContaining('subscriptionId'),
    });
    expect(mockOrdersList).not.toHaveBeenCalled();
  });
});
