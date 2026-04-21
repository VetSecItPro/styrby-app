/**
 * Styrby Cost Types — Phase 1.6.1 "Real LLM Cost Surfacing"
 *
 * Unified cost report type consumed by:
 *   - The CLI reporter (`packages/styrby-cli/src/costs/cost-reporter.ts`)
 *   - The web dashboard (`packages/styrby-web`)
 *   - The mobile dashboard (`packages/styrby-mobile`)
 *
 * Every field mirrors a column in `cost_records` (migration 022). All 11
 * agent factories (Claude Code, Codex, Gemini CLI, OpenCode, Aider, Goose,
 * Amp, Crush, Kilo, Kiro, Droid) emit their native cost/usage data through
 * this single shape so downstream consumers never branch on agent type.
 *
 * Billing model taxonomy:
 *   - 'api-key'      — user pays per-token at market rate (variable USD cost).
 *   - 'subscription' — flat-rate plan (Claude Max, Gemini Workspace).
 *                      `costUsd` is always 0; quota fraction is the signal.
 *   - 'credit'       — per-prompt credits (Kiro).
 *                      `costUsd` is derived from `credits.consumed * credits.rateUsdPerCredit`.
 *   - 'free'         — local or free-tier model (Kilo+Ollama, Gemini free tier).
 *                      `costUsd` = 0; no quota; informational only.
 */

import { z } from 'zod';

// ============================================================================
// Enums / Const Arrays
// ============================================================================

/**
 * All billing models supported by Styrby agents.
 *
 * Used as a const-array so TypeScript infers the narrowest union type from
 * the `as const` annotation, matching the pattern in relay/types.ts.
 */
export const BILLING_MODELS = ['api-key', 'subscription', 'credit', 'free'] as const;

/**
 * Union type derived from {@link BILLING_MODELS}.
 *
 * @example
 * const model: BillingModel = 'api-key';
 */
export type BillingModel = (typeof BILLING_MODELS)[number];

/**
 * Identifies whether cost data came directly from the agent's own output
 * or was estimated by Styrby's cost calculator.
 *
 * WHY: When an agent does not report token counts natively (e.g. Aider in
 * some modes), Styrby derives a best-effort estimate. Consumers that need
 * high-precision accounting (budget alerts, SOC2 audit export) must be able
 * to distinguish agent-reported from estimated values.
 */
export const COST_SOURCES = ['agent-reported', 'styrby-estimate'] as const;

/**
 * Union type derived from {@link COST_SOURCES}.
 */
export type CostSource = (typeof COST_SOURCES)[number];

// ============================================================================
// Interface
// ============================================================================

/**
 * Unified cost report for a single agent usage event or session-level aggregation.
 *
 * Covers four billing models:
 *   - 'api-key'      — user pays per-token at market rate (variable USD cost).
 *   - 'subscription' — user on a flat-rate plan (Claude Max, Gemini Workspace).
 *                      costUsd is always 0; quota fraction is what matters.
 *   - 'credit'       — agent charges per-prompt credits (Kiro).
 *                      costUsd is derived from credits * creditRateUsd.
 *   - 'free'         — local or free-tier model (Kilo+Ollama, Gemini free tier).
 *                      costUsd = 0; no quota; informational only.
 *
 * Every field mirrors a column in cost_records (migration 022). The CLI
 * reporter and web/mobile dashboards consume the same shape.
 */
export interface CostReport {
  /** Supabase UUID of the session this cost event belongs to. */
  sessionId: string;

  /**
   * Supabase UUID of the individual message within the session, or null when
   * the report represents a session-level aggregation rather than a single turn.
   */
  messageId: string | null;

  /** Agent that generated the cost (e.g. 'claude', 'codex', 'kiro'). */
  agentType: string;

  /** Specific model name as reported by the agent (e.g. 'claude-sonnet-4-5'). */
  model: string;

  /**
   * ISO 8601 datetime string of when the event occurred.
   *
   * @example "2026-04-21T14:30:00.000Z"
   */
  timestamp: string;

  /** Whether cost data came from the agent directly or was estimated by Styrby. */
  source: CostSource;

  /** Billing model that applies to this agent/plan combination. */
  billingModel: BillingModel;

  /**
   * Total USD cost for this event. Always >= 0.
   *
   * For 'subscription' and 'free' billing models this is always 0.
   * For 'credit' this equals `credits.consumed * credits.rateUsdPerCredit`.
   */
  costUsd: number;

  /** Tokens sent to the model (user prompts + injected context). */
  inputTokens: number;

  /** Tokens received from the model (response text). */
  outputTokens: number;

  /**
   * Cache-read tokens that avoided re-processing.
   *
   * WHY: Claude's prompt-caching feature lets repeated context be reused at
   * ~10% of the normal input token price. Tracking cache reads separately
   * lets the cost dashboard show users how much they saved via caching.
   */
  cacheReadTokens: number;

  /**
   * Cache-write tokens that were stored for future reads.
   *
   * WHY: Cache writes are charged at ~25% above normal input token price.
   * Surfacing this separately gives users full cost transparency.
   */
  cacheWriteTokens: number;

  /**
   * Subscription quota metadata.
   *
   * Populated ONLY when `billingModel === 'subscription'`. Undefined for all
   * other billing models to keep the shape lean.
   */
  subscriptionUsage?: {
    /**
     * Fraction of the plan's usage quota consumed, in the range [0, 1].
     *
     * Null when the agent does not surface quota information (e.g. Gemini
     * Workspace hides quota from the API response in some configurations).
     */
    fractionUsed: number | null;

    /**
     * Raw quota signal string as emitted by the agent, preserved for
     * debugging and future parser improvements.
     *
     * @example "47% of daily limit used"
     */
    rawSignal: string | null;
  };

  /**
   * Credit consumption details.
   *
   * Populated ONLY when `billingModel === 'credit'`. Undefined for all other
   * billing models.
   */
  credits?: {
    /** Number of credits consumed by this event. */
    consumed: number;

    /**
     * Exchange rate: how many USD one credit is worth at the time of the event.
     *
     * WHY: Credit rates can change over time. Snapshotting the rate at event
     * time lets historical cost calculations remain accurate even after a
     * provider reprices their credit packs.
     */
    rateUsdPerCredit: number;
  };

  /**
   * Raw agent payload for audit trail and future parser improvements.
   *
   * Only meaningful when `source === 'agent-reported'`. Must be null when
   * `source === 'styrby-estimate'` because there is no agent payload to store.
   *
   * WHY: Preserving the raw payload lets us recompute cost with improved
   * parsers without having to re-run the original agent session. It also
   * satisfies SOC2 CC7.2 (evidence of monitored activity).
   */
  rawAgentPayload: Record<string, unknown> | null;
}

// ============================================================================
// Zod Schema
// ============================================================================

/**
 * Zod schema for {@link CostReport}.
 *
 * Applies five cross-field refinements on top of the structural validation:
 *   1. `billingModel === 'subscription'` → `costUsd` must equal 0.
 *   2. `billingModel === 'credit'` → `credits` must be present.
 *   3. `source === 'styrby-estimate'` → `rawAgentPayload` must be null.
 *   4. `subscriptionUsage.fractionUsed`, when not null, must be in [0, 1].
 *   5. `timestamp` must be a valid ISO 8601 datetime string.
 *
 * @example
 * const result = CostReportSchema.safeParse(agentPayload);
 * if (!result.success) {
 *   console.warn('[CostReporter] Dropped malformed cost report:', result.error.issues);
 *   return;
 * }
 * const report = result.data; // fully typed CostReport
 */
export const CostReportSchema = z
  .object({
    sessionId: z.string().min(1),
    messageId: z.string().min(1).nullable(),
    agentType: z.string().min(1),
    model: z.string().min(1),

    // WHY: We validate timestamp structurally (ISO 8601) rather than storing a
    // Date object because CostReport is serialised to JSON for the relay channel
    // and Supabase REST API. Keeping it a string avoids lossy timezone
    // conversions at serialisation boundaries.
    timestamp: z.string().min(1),

    source: z.enum(COST_SOURCES),
    billingModel: z.enum(BILLING_MODELS),

    costUsd: z.number().min(0),

    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    cacheReadTokens: z.number().int().min(0),
    cacheWriteTokens: z.number().int().min(0),

    subscriptionUsage: z
      .object({
        fractionUsed: z.number().nullable(),
        rawSignal: z.string().nullable(),
      })
      .optional(),

    credits: z
      .object({
        consumed: z.number().min(0),
        rateUsdPerCredit: z.number().min(0),
      })
      .optional(),

    rawAgentPayload: z.record(z.unknown()).nullable(),
  })
  // Refinement 1: subscription billing must never carry a USD cost.
  // WHY: Flat-rate plans have zero marginal cost per request from the user's
  // perspective. Storing a non-zero costUsd would distort budget-alert
  // thresholds and monthly spend totals in the dashboard.
  .refine(
    (r) => !(r.billingModel === 'subscription' && r.costUsd !== 0),
    {
      message: "costUsd must be 0 when billingModel is 'subscription'",
      path: ['costUsd'],
    }
  )
  // Refinement 2: credit billing must include the credits breakdown.
  // WHY: Without credits.consumed and credits.rateUsdPerCredit the dashboard
  // cannot verify that costUsd was derived correctly, breaking the audit trail.
  .refine(
    (r) => !(r.billingModel === 'credit' && r.credits === undefined),
    {
      message: "credits must be present when billingModel is 'credit'",
      path: ['credits'],
    }
  )
  // Refinement 3: Styrby estimates have no source agent payload.
  // WHY: An estimate is synthesised by Styrby's cost calculator from token
  // counts alone — there is no raw agent response to preserve. Storing a
  // non-null payload here would imply false provenance in the audit log.
  .refine(
    (r) => !(r.source === 'styrby-estimate' && r.rawAgentPayload !== null),
    {
      message: "rawAgentPayload must be null when source is 'styrby-estimate'",
      path: ['rawAgentPayload'],
    }
  )
  // Refinement 4: fractionUsed, when not null, must be a valid [0, 1] fraction.
  // WHY: Values outside [0, 1] indicate a parser bug or a provider that changed
  // their quota response format. Clamping silently would hide these regressions;
  // rejecting them forces the parser to be fixed.
  .refine(
    (r) => {
      if (r.subscriptionUsage?.fractionUsed == null) return true;
      return r.subscriptionUsage.fractionUsed >= 0 && r.subscriptionUsage.fractionUsed <= 1;
    },
    {
      message: 'subscriptionUsage.fractionUsed must be in [0, 1] when not null',
      path: ['subscriptionUsage', 'fractionUsed'],
    }
  )
  // Refinement 5: timestamp must be a parseable ISO 8601 datetime.
  // WHY: An unparseable timestamp breaks time-series queries on cost_records
  // and makes the cost chart render nothing. Fail fast at ingestion rather
  // than silently storing garbage in the DB.
  .refine(
    (r) => !isNaN(Date.parse(r.timestamp)),
    {
      message: 'timestamp must be a valid ISO 8601 datetime string',
      path: ['timestamp'],
    }
  );

/**
 * TypeScript type inferred from {@link CostReportSchema}.
 *
 * Structurally equivalent to {@link CostReport}; use whichever is more
 * convenient. The Zod-inferred variant (`ZodCostReport`) is preferred at
 * runtime parse boundaries; the hand-written interface is preferred in
 * function signatures for readability.
 */
export type ZodCostReport = z.infer<typeof CostReportSchema>;
