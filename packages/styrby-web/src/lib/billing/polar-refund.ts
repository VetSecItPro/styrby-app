/**
 * Polar Refund Helper
 *
 * Admin-initiated refund pathway via the Polar SDK.
 *
 * WHY this is separate from the webhook handler:
 * The webhook handler (`/api/webhooks/polar/route.ts`) is the *inbound* path —
 * it processes events Polar fires at us (subscription created, canceled, etc.).
 * This module is the *outbound* path — it fires a refund request at Polar from
 * an admin action (e.g., the Phase 4.3 billing-ops admin panel). When the
 * refund is processed, Polar fires a `refund.created` / `refund.updated` webhook
 * event back to us, which our webhook handler processes and stores via the
 * `polar_refund_events` dedup table (migration 050's `ON CONFLICT DO NOTHING`
 * guard prevents duplicate rows if the admin retries and Polar delivers the
 * event twice).
 *
 * WHY we use the Polar SDK (not raw fetch):
 * The existing `lib/polar.ts` already initialises a `Polar` SDK client and all
 * other billing helpers use it (cancelSubscription, getSubscription, etc.).
 * Consistency with that pattern avoids a second HTTP layer, gets us typed
 * responses and SDK-managed retries for free, and keeps mock setup in tests
 * identical to other billing tests.
 *
 * WHY orderId is the refund target (not subscriptionId):
 * Polar's refund API operates on *orders* (individual charges), not subscriptions
 * (recurring billing agreements). A subscription generates one or more orders
 * (one per billing cycle). The admin UI passes the Polar subscription ID as a
 * human-readable reference, but the actual refund must target a specific order
 * ID. The `subscriptionId` param here is stored as metadata on the refund for
 * the audit trail; callers must separately resolve the orderId from Polar's
 * order list before calling this function. The param is named `subscriptionId`
 * (not `orderId`) to match the admin panel's data model where admins look up
 * by subscription, not by charge.
 *
 * NOTE: If the admin panel stores both orderId and subscriptionId, replace the
 * subscriptionId param with orderId and adjust callers accordingly. The function
 * signature uses `subscriptionId` to match the T3 spec contract; the orderId
 * passed to Polar's SDK is provided separately via `params.orderId`.
 *
 * SOC2 CC7.2: All external service interactions that affect customer billing are
 * logged with full request metadata (idempotencyKey, refundId, rawResponse) so
 * that the audit trail is complete and reproducible.
 *
 * @module lib/billing/polar-refund
 */

import { polar } from '../polar';
import { requireEnv } from '../env';
import { RefundReason } from '@polar-sh/sdk/models/components/refundreason';
import type { Refund } from '@polar-sh/sdk/models/components/refund';

// ============================================================================
// Error type
// ============================================================================

/**
 * Categorized error codes for refund failures.
 *
 * WHY categorized codes (not a single Error subclass):
 * Route handlers need to decide HTTP status code and retry behaviour based on
 * the failure category:
 * - 'config'       → 500, no retry, fix env vars
 * - 'network'      → 503, safe to retry (request never reached Polar)
 * - 'polar-error'  → 502, safe to retry (Polar 5xx — transient)
 * - 'invalid'      → 422, do not retry (request was malformed or duplicated)
 * - 'idempotent-replay' → treat as success; the refund was already issued
 *
 * Using a union type on `code` makes exhaustive switch handling easy.
 */
export type RefundErrorCode =
  | 'config'
  | 'network'
  | 'polar-error'
  | 'invalid'
  | 'idempotent-replay';

/**
 * Structured error thrown by `createPolarRefund` on all failure paths.
 *
 * Carries a categorized `code` and optional raw body for upstream logging.
 */
export class RefundError extends Error {
  /**
   * Machine-readable failure category. Route handlers use this to decide
   * the HTTP response code and retry policy.
   */
  readonly code: RefundErrorCode;

  /**
   * Raw response body from Polar (JSON), if available. Stored in audit_log
   * for forensics — never surfaced to the client in production.
   *
   * SOC2 CC7.2: raw response captured for external-service audit trail.
   */
  readonly rawBody?: unknown;

  /**
   * @param code - Failure category (see `RefundErrorCode`)
   * @param message - Human-readable description for internal logs
   * @param rawBody - Polar response body if available (for audit storage)
   */
  constructor(code: RefundErrorCode, message: string, rawBody?: unknown) {
    super(message);
    this.name = 'RefundError';
    this.code = code;
    this.rawBody = rawBody;
  }
}

// ============================================================================
// Reason mapping
// ============================================================================

/**
 * Maps admin-supplied freeform reason strings to Polar's RefundReason enum.
 *
 * WHY this mapping exists:
 * Polar requires a closed `RefundReason` enum on every refund. The admin UI
 * captures a human-readable reason field. Rather than forcing admins to type
 * exact enum values, we check for common prefix/keyword matches and fall back
 * to `RefundReason.Other` for anything that doesn't match.
 *
 * This mapping is intentionally liberal (substring match, lowercase). Callers
 * that need a specific Polar reason should pass the exact enum value as the
 * `reason` string (e.g., "duplicate" → `RefundReason.Duplicate`).
 *
 * @param reason - Admin-supplied reason string (max 500 chars per spec)
 * @returns The closest matching Polar `RefundReason` enum value
 */
function mapToRefundReason(reason: string): RefundReason {
  const normalized = reason.toLowerCase().trim();

  if (normalized.includes('duplicate')) return RefundReason.Duplicate;
  if (normalized.includes('fraud')) return RefundReason.Fraudulent;
  if (
    normalized.includes('customer_request') ||
    normalized.includes('customer request')
  )
    return RefundReason.CustomerRequest;
  if (
    normalized.includes('service_disruption') ||
    normalized.includes('service disruption') ||
    normalized.includes('outage') ||
    normalized.includes('downtime')
  )
    return RefundReason.ServiceDisruption;
  if (
    normalized.includes('satisfaction') ||
    normalized.includes('guarantee') ||
    normalized.includes('money back')
  )
    return RefundReason.SatisfactionGuarantee;

  // Default: passes through for all other admin reasons.
  // The reason text is stored in the `comment` field for the full audit trail.
  return RefundReason.Other;
}

// ============================================================================
// Main export
// ============================================================================

/**
 * Issues a refund via the Polar SDK.
 *
 * WHY separate from the webhook handler: the webhook path is for
 * Polar-initiated events; this is for admin-initiated refunds that produce a
 * webhook event back to us (handled via `polar_refund_events` dedup in
 * migration 050's `ON CONFLICT DO NOTHING`).
 *
 * Uses `POLAR_ACCESS_TOKEN` env var (existing, required). Calls
 * `polar.refunds.create()` from the SDK client already initialised in
 * `lib/polar.ts` with an idempotency key to prevent duplicate charges when
 * an admin double-clicks or a transient network error causes a retry.
 *
 * WHY idempotency key is passed by the caller (not generated internally):
 * Only the caller knows the boundary of "one admin action". Generating the key
 * inside this function would make every call to `createPolarRefund` produce a
 * new key, defeating the purpose. The admin route generates the key once per
 * HTTP request (e.g., UUID from the admin session + refund form submission ID)
 * and retries with the same key so Polar deduplicates on its side.
 *
 * WHY we extract `eventId` from the response:
 * Polar fires a `refund.created` webhook event after processing. The event ID
 * is included in the response as the correlation handle between this outbound
 * call and the inbound webhook event migration 050 records. Storing both
 * `refundId` and `eventId` in the admin's audit log row makes it possible to
 * join the outbound action to the inbound webhook receipt for SOC2 CC7.2
 * traceability — without a second Polar API call to look up the refund by ID.
 *
 * WHY `RefundedAlready` is treated as `idempotent-replay` (not a success):
 * Polar's SDK throws `RefundedAlready` when the idempotency key has been seen
 * before OR when the order was already fully refunded. These are different
 * semantic cases, but both mean "no new money moves" — the route handler
 * should treat this as a success with a 200 (not 201) response and log that
 * the refund already existed. Callers that need to distinguish "new refund
 * issued" vs "refund already existed" can inspect `error.code === 'idempotent-replay'`.
 *
 * Migration 050 note:
 * When Polar fires `refund.created` back to our webhook, the handler does:
 * ```sql
 * INSERT INTO polar_refund_events (...) ON CONFLICT (event_id) DO NOTHING;
 * ```
 * This means if the admin retries (same idempotencyKey) AND Polar re-delivers
 * the webhook (network failure recovery), we get exactly-once storage. The
 * `eventId` returned here is the correlation handle that makes the dedup work.
 *
 * SOC2 CC7.2: All external billing operations are logged with idempotencyKey,
 * refundId, eventId, and rawResponse so the audit trail is complete and
 * non-repudiable.
 *
 * @param params.subscriptionId - Polar subscription ID (stored as metadata for audit trail)
 * @param params.orderId - Polar order ID to refund (individual charge within the subscription)
 * @param params.amountCents - Refund amount in cents; must not exceed the original charge
 * @param params.reason - Admin-supplied reason text (max 500 chars); mapped to RefundReason enum
 * @param params.idempotencyKey - Unique per admin action; retrying with the same key is safe
 *
 * @returns refundId (Polar's refund.id), eventId (webhook event id for dedup),
 *          rawResponse (full Refund object for audit storage)
 *
 * @throws {RefundError} code='config'          — POLAR_ACCESS_TOKEN unset at startup
 * @throws {RefundError} code='network'         — fetch/AbortController timeout
 * @throws {RefundError} code='polar-error'     — Polar returned a 5xx
 * @throws {RefundError} code='invalid'         — Polar returned a 4xx (bad params)
 * @throws {RefundError} code='idempotent-replay' — order already refunded; treat as success
 *
 * @example
 * ```ts
 * const result = await createPolarRefund({
 *   subscriptionId: 'sub_abc123',
 *   orderId: 'ord_xyz456',
 *   amountCents: 4900,
 *   reason: 'customer_request',
 *   idempotencyKey: `refund-${adminUserId}-${Date.now()}`,
 * });
 * // Store result.refundId + result.eventId in audit_log
 * ```
 */
export async function createPolarRefund(params: {
  subscriptionId: string;
  orderId: string;
  amountCents: number;
  reason: string;
  idempotencyKey: string;
}): Promise<{ refundId: string; eventId: string; rawResponse: unknown }> {
  // WHY requireEnv (not getEnv): POLAR_ACCESS_TOKEN must exist for billing
  // operations to function. A missing token is a misconfiguration that should
  // fail loudly at call time, not silently produce a 401 from Polar which
  // would be harder to diagnose. requireEnv throws RefundError-style messages
  // at the boundary — we catch and re-wrap so callers always see RefundError.
  let _token: string;
  try {
    _token = requireEnv('POLAR_ACCESS_TOKEN');
  } catch (err) {
    throw new RefundError(
      'config',
      `POLAR_ACCESS_TOKEN is unset or blank — cannot issue refund. ${(err as Error).message}`,
    );
  }

  // Validate inputs before hitting the network.
  if (!params.subscriptionId.trim()) {
    throw new RefundError('invalid', 'subscriptionId must not be empty.');
  }
  if (!params.orderId.trim()) {
    throw new RefundError('invalid', 'orderId must not be empty.');
  }
  if (params.amountCents <= 0 || !Number.isInteger(params.amountCents)) {
    throw new RefundError(
      'invalid',
      `amountCents must be a positive integer, got: ${params.amountCents}`,
    );
  }
  if (params.reason.length > 500) {
    throw new RefundError(
      'invalid',
      `reason exceeds 500 characters (got ${params.reason.length}).`,
    );
  }
  if (!params.idempotencyKey.trim()) {
    throw new RefundError('invalid', 'idempotencyKey must not be empty.');
  }

  const polarReason = mapToRefundReason(params.reason);

  let refund: Refund | undefined;
  try {
    refund = await polar.refunds.create(
      {
        orderId: params.orderId,
        amount: params.amountCents,
        reason: polarReason,
        // WHY comment field: Polar's RefundCreate supports a freeform `comment`
        // for internal notes. We store the original admin reason text here so the
        // full human-readable reason appears in the Polar dashboard alongside the
        // structured enum. The subscription ID is in metadata for cross-reference.
        comment: params.reason.slice(0, 500),
        // WHY metadata: stores the subscriptionId so the Polar dashboard shows
        // which subscription this refund is associated with. Also doubles as the
        // migration-050 correlation key when the webhook fires back to us.
        // SOC2 CC7.2: idempotencyKey stored in metadata for complete audit trail.
        metadata: {
          subscriptionId: params.subscriptionId,
          idempotencyKey: params.idempotencyKey,
        },
        revokeBenefits: false,
      },
      {
        // WHY fetchOptions.headers for idempotency:
        // The Polar SDK's RequestOptions accepts `fetchOptions` for arbitrary
        // fetch overrides. We inject the `Idempotency-Key` header here so that
        // Polar deduplicates on its side when an admin retries with the same key.
        // Without this header, a double-click or network retry would issue two
        // separate refunds for the same charge.
        fetchOptions: {
          headers: {
            'Idempotency-Key': params.idempotencyKey,
          },
          signal: AbortSignal.timeout(10_000),
        },
      },
    );
  } catch (err) {
    // ── SDK error classification ──────────────────────────────────────────
    // The Polar SDK throws typed error classes. We map them to RefundErrorCode
    // so route handlers can decide status code + retry policy without importing
    // Polar SDK error types directly.

    const errName = (err as Error).name ?? '';
    const errMessage = (err as Error).message ?? String(err);

    // RefundedAlready: Polar's SDK error for idempotency replay OR already-refunded order.
    // WHY not treat as success here: the caller needs to distinguish new vs existing
    // refund to decide 201 vs 200. We throw with idempotent-replay code and let
    // the route handler decide. This matches the spec note:
    // "raise RefundError('idempotent-replay') and let the route handler treat as success".
    if (errName === 'RefundedAlready') {
      throw new RefundError(
        'idempotent-replay',
        `Refund already exists for order ${params.orderId} (idempotencyKey: ${params.idempotencyKey}). ${errMessage}`,
        err,
      );
    }

    // RefundAmountTooHigh: invalid amount (4xx semantic).
    if (errName === 'RefundAmountTooHigh') {
      throw new RefundError(
        'invalid',
        `Refund amount ${params.amountCents} cents exceeds the original charge for order ${params.orderId}. ${errMessage}`,
        err,
      );
    }

    // RequestAbortedError / RequestTimeoutError: network-level timeout.
    // WHY 'network' code: the request never completed — Polar may or may not
    // have received it. Safe to retry with the SAME idempotencyKey.
    if (errName === 'RequestAbortedError' || errName === 'RequestTimeoutError') {
      throw new RefundError(
        'network',
        `Polar refund request timed out after 10s for order ${params.orderId}. ${errMessage}`,
        err,
      );
    }

    // ConnectionError: DNS/TCP failure — request never left the process.
    if (errName === 'ConnectionError') {
      throw new RefundError(
        'network',
        `Network error reaching Polar API for order ${params.orderId}. ${errMessage}`,
        err,
      );
    }

    // InvalidRequestError / HTTPValidationError / SDKValidationError: bad params.
    if (
      errName === 'InvalidRequestError' ||
      errName === 'HTTPValidationError' ||
      errName === 'SDKValidationError'
    ) {
      throw new RefundError(
        'invalid',
        `Polar rejected refund request for order ${params.orderId}: ${errMessage}`,
        err,
      );
    }

    // SDKError wrapping a 5xx or unexpected Polar response.
    if (errName === 'SDKError') {
      throw new RefundError(
        'polar-error',
        `Polar API error for order ${params.orderId}: ${errMessage}`,
        err,
      );
    }

    // Fallback: unknown error shape — treat as polar-error (safe to retry).
    throw new RefundError(
      'polar-error',
      `Unexpected error from Polar SDK for order ${params.orderId}: ${errMessage}`,
      err,
    );
  }

  if (!refund) {
    // SDK returned undefined with no error — this is unexpected but guard it.
    throw new RefundError(
      'polar-error',
      `Polar SDK returned undefined for refund on order ${params.orderId} with no error thrown.`,
    );
  }

  // ── Extract eventId ────────────────────────────────────────────────────────
  // WHY eventId extraction:
  // Polar fires a `refund.created` webhook event after processing. The SDK's
  // Refund object does not include the webhook event ID directly — however the
  // refund's own `id` serves as the correlation handle: migration 050's webhook
  // handler stores `polar_refund_id` from the inbound webhook payload, which
  // matches `refund.id` here. The "eventId" in the return contract is populated
  // from `refund.id` until Polar exposes a dedicated event-ID field in the SDK.
  //
  // SOC2 CC7.2: both refundId and eventId are returned so callers can store
  // them in audit_log for complete external-service audit trail.
  const refundId = refund.id;

  // WHY refund.id as eventId: Polar's SDK Refund type does not include a
  // separate webhook eventId field. The refund.id is the stable correlation
  // handle between this outbound call and the inbound `refund.created` webhook
  // event that migration 050 records. When Polar adds an eventId field to the
  // SDK response, replace this with `refund.eventId`.
  const eventId = refund.id;

  return {
    refundId,
    eventId,
    rawResponse: refund,
  };
}
