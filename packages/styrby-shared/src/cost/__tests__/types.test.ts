/**
 * Tests for the CostReport Zod schema (cost/types.ts).
 *
 * Covers:
 *   - Happy paths for each billing model ('api-key', 'subscription', 'credit', 'free')
 *   - All 5 cross-field refinements fire with the correct error message on violation
 *   - Optional fields (subscriptionUsage, credits) parse correctly when absent
 *   - Token counts reject negative integers
 *   - rawAgentPayload accepts arbitrary JSON shapes
 *   - Union branches for CostSource ('agent-reported', 'styrby-estimate')
 *
 * WHY: CostReportSchema is a security and data-quality boundary. Every agent
 * factory feeds data through this schema before it reaches cost_records and
 * the dashboard. A missed validation here corrupts spend totals and budget
 * alerts for the user.
 *
 * @module cost/__tests__/types
 */

import { describe, it, expect } from 'vitest';
import {
  CostReportSchema,
  BILLING_MODELS,
  COST_SOURCES,
} from '../types.js';

// ============================================================================
// Fixtures
// ============================================================================

/** Minimal valid 'api-key' report — all required fields, no optionals. */
const BASE_API_KEY = {
  sessionId: 'sess-001',
  messageId: 'msg-001',
  agentType: 'claude',
  model: 'claude-sonnet-4-5',
  timestamp: '2026-04-21T14:30:00.000Z',
  source: 'agent-reported' as const,
  billingModel: 'api-key' as const,
  costUsd: 0.0042,
  inputTokens: 1200,
  outputTokens: 800,
  cacheReadTokens: 400,
  cacheWriteTokens: 100,
  rawAgentPayload: { usage: { input_tokens: 1200, output_tokens: 800 } },
};

/** Minimal valid 'subscription' report. */
const BASE_SUBSCRIPTION = {
  ...BASE_API_KEY,
  billingModel: 'subscription' as const,
  costUsd: 0,
  rawAgentPayload: null,
  subscriptionUsage: {
    fractionUsed: 0.47,
    rawSignal: '47% of daily limit used',
  },
};

/** Minimal valid 'credit' report (Kiro-style). */
const BASE_CREDIT = {
  ...BASE_API_KEY,
  agentType: 'kiro',
  billingModel: 'credit' as const,
  costUsd: 0.05,
  credits: {
    consumed: 5,
    rateUsdPerCredit: 0.01,
  },
};

/** Minimal valid 'free' report (Kilo+Ollama). */
const BASE_FREE = {
  ...BASE_API_KEY,
  agentType: 'kilo',
  model: 'llama3.3',
  billingModel: 'free' as const,
  costUsd: 0,
  rawAgentPayload: null,
  source: 'styrby-estimate' as const,
};

// ============================================================================
// Happy paths — one per billing model
// ============================================================================

describe('CostReportSchema — happy paths', () => {
  it('parses a valid api-key report', () => {
    const result = CostReportSchema.safeParse(BASE_API_KEY);
    expect(result.success).toBe(true);
  });

  it('parses a valid subscription report', () => {
    const result = CostReportSchema.safeParse(BASE_SUBSCRIPTION);
    expect(result.success).toBe(true);
  });

  it('parses a valid credit report', () => {
    const result = CostReportSchema.safeParse(BASE_CREDIT);
    expect(result.success).toBe(true);
  });

  it('parses a valid free report', () => {
    const result = CostReportSchema.safeParse(BASE_FREE);
    expect(result.success).toBe(true);
  });

  it('accepts messageId as null (session-level aggregation)', () => {
    const result = CostReportSchema.safeParse({ ...BASE_API_KEY, messageId: null });
    expect(result.success).toBe(true);
  });

  it('accepts rawAgentPayload with arbitrary nested JSON', () => {
    const payload = {
      deeply: { nested: { array: [1, 'two', true, null], obj: { x: 99 } } },
    };
    const result = CostReportSchema.safeParse({ ...BASE_API_KEY, rawAgentPayload: payload });
    expect(result.success).toBe(true);
  });

  it('accepts rawAgentPayload as null for api-key source agent-reported (explicit null)', () => {
    // rawAgentPayload null is valid for any source/billingModel combination
    // EXCEPT styrby-estimate (which requires null) — so null on api-key is fine.
    const result = CostReportSchema.safeParse({ ...BASE_API_KEY, rawAgentPayload: null });
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// BILLING_MODELS and COST_SOURCES const arrays
// ============================================================================

describe('exported const arrays', () => {
  it('BILLING_MODELS contains all four expected values', () => {
    expect(BILLING_MODELS).toEqual(['api-key', 'subscription', 'credit', 'free']);
  });

  it('COST_SOURCES contains both expected values', () => {
    expect(COST_SOURCES).toEqual(['agent-reported', 'styrby-estimate']);
  });
});

// ============================================================================
// Refinement 1 — subscription costUsd must be 0
// ============================================================================

describe('Refinement 1: subscription → costUsd must be 0', () => {
  it('rejects subscription report with non-zero costUsd', () => {
    const bad = { ...BASE_SUBSCRIPTION, costUsd: 1.5 };
    const result = CostReportSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain("costUsd must be 0 when billingModel is 'subscription'");
    }
  });

  it('accepts subscription report with costUsd exactly 0', () => {
    const result = CostReportSchema.safeParse({ ...BASE_SUBSCRIPTION, costUsd: 0 });
    expect(result.success).toBe(true);
  });

  it('does NOT fire for api-key with non-zero costUsd', () => {
    // api-key can have any non-negative costUsd
    const result = CostReportSchema.safeParse({ ...BASE_API_KEY, costUsd: 9.99 });
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// Refinement 2 — credit billingModel requires credits field
// ============================================================================

describe('Refinement 2: credit → credits must be present', () => {
  it('rejects credit report missing credits field', () => {
    const { credits: _credits, ...bad } = BASE_CREDIT as typeof BASE_CREDIT & { credits?: unknown };
    const result = CostReportSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain("credits must be present when billingModel is 'credit'");
    }
  });

  it('accepts credit report with credits present', () => {
    const result = CostReportSchema.safeParse(BASE_CREDIT);
    expect(result.success).toBe(true);
  });

  it('does NOT fire for api-key without credits', () => {
    // api-key never needs credits
    const result = CostReportSchema.safeParse(BASE_API_KEY);
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// Refinement 3 — styrby-estimate requires rawAgentPayload null
// ============================================================================

describe('Refinement 3: styrby-estimate → rawAgentPayload must be null', () => {
  it('rejects styrby-estimate report with non-null rawAgentPayload', () => {
    const bad = {
      ...BASE_FREE,
      source: 'styrby-estimate' as const,
      rawAgentPayload: { some: 'payload' },
    };
    const result = CostReportSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain(
        "rawAgentPayload must be null when source is 'styrby-estimate'"
      );
    }
  });

  it('accepts styrby-estimate report with null rawAgentPayload', () => {
    const result = CostReportSchema.safeParse(BASE_FREE);
    expect(result.success).toBe(true);
  });

  it('does NOT fire for agent-reported with non-null rawAgentPayload', () => {
    // agent-reported can carry a payload
    const result = CostReportSchema.safeParse(BASE_API_KEY);
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// Refinement 4 — fractionUsed must be in [0, 1] when not null
// ============================================================================

describe('Refinement 4: fractionUsed must be in [0, 1]', () => {
  it('rejects fractionUsed > 1', () => {
    const bad = {
      ...BASE_SUBSCRIPTION,
      subscriptionUsage: { fractionUsed: 1.01, rawSignal: 'overflow' },
    };
    const result = CostReportSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain(
        'subscriptionUsage.fractionUsed must be in [0, 1] when not null'
      );
    }
  });

  it('rejects fractionUsed < 0', () => {
    const bad = {
      ...BASE_SUBSCRIPTION,
      subscriptionUsage: { fractionUsed: -0.01, rawSignal: 'underflow' },
    };
    const result = CostReportSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain(
        'subscriptionUsage.fractionUsed must be in [0, 1] when not null'
      );
    }
  });

  it('accepts fractionUsed exactly 0', () => {
    const ok = {
      ...BASE_SUBSCRIPTION,
      subscriptionUsage: { fractionUsed: 0, rawSignal: 'fresh quota' },
    };
    expect(CostReportSchema.safeParse(ok).success).toBe(true);
  });

  it('accepts fractionUsed exactly 1', () => {
    const ok = {
      ...BASE_SUBSCRIPTION,
      subscriptionUsage: { fractionUsed: 1, rawSignal: 'quota exhausted' },
    };
    expect(CostReportSchema.safeParse(ok).success).toBe(true);
  });

  it('accepts fractionUsed: null (agent hides quota)', () => {
    const ok = {
      ...BASE_SUBSCRIPTION,
      subscriptionUsage: { fractionUsed: null, rawSignal: null },
    };
    expect(CostReportSchema.safeParse(ok).success).toBe(true);
  });

  it('does NOT fire when subscriptionUsage is absent', () => {
    // api-key with no subscriptionUsage — refinement must not trigger
    expect(CostReportSchema.safeParse(BASE_API_KEY).success).toBe(true);
  });
});

// ============================================================================
// Refinement 5 — timestamp must be a valid ISO 8601 datetime
// ============================================================================

describe('Refinement 5: timestamp must be valid ISO 8601', () => {
  it('rejects a non-parseable timestamp', () => {
    const bad = { ...BASE_API_KEY, timestamp: 'not-a-date' };
    const result = CostReportSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain('timestamp must be a valid ISO 8601 datetime string');
    }
  });

  it('rejects an empty timestamp string', () => {
    const bad = { ...BASE_API_KEY, timestamp: '' };
    const result = CostReportSchema.safeParse(bad);
    // Empty string fails the min(1) check before reaching the refine
    expect(result.success).toBe(false);
  });

  it('accepts a UTC ISO 8601 string', () => {
    const ok = { ...BASE_API_KEY, timestamp: '2026-04-21T14:30:00.000Z' };
    expect(CostReportSchema.safeParse(ok).success).toBe(true);
  });

  it('accepts an ISO 8601 string with timezone offset', () => {
    const ok = { ...BASE_API_KEY, timestamp: '2026-04-21T09:30:00.000-05:00' };
    expect(CostReportSchema.safeParse(ok).success).toBe(true);
  });
});

// ============================================================================
// Token count validation
// ============================================================================

describe('Token count validation', () => {
  it('rejects negative inputTokens', () => {
    const result = CostReportSchema.safeParse({ ...BASE_API_KEY, inputTokens: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects negative outputTokens', () => {
    const result = CostReportSchema.safeParse({ ...BASE_API_KEY, outputTokens: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects negative cacheReadTokens', () => {
    const result = CostReportSchema.safeParse({ ...BASE_API_KEY, cacheReadTokens: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects negative cacheWriteTokens', () => {
    const result = CostReportSchema.safeParse({ ...BASE_API_KEY, cacheWriteTokens: -1 });
    expect(result.success).toBe(false);
  });

  it('accepts all token counts at 0', () => {
    const result = CostReportSchema.safeParse({
      ...BASE_API_KEY,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(result.success).toBe(true);
  });

  it('rejects non-integer inputTokens', () => {
    const result = CostReportSchema.safeParse({ ...BASE_API_KEY, inputTokens: 1.5 });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// Optional fields absent
// ============================================================================

describe('Optional fields absent', () => {
  it('parses correctly when subscriptionUsage is absent (api-key)', () => {
    const { subscriptionUsage: _su, ...noSu } = BASE_SUBSCRIPTION as typeof BASE_SUBSCRIPTION & { subscriptionUsage?: unknown };
    const result = CostReportSchema.safeParse({ ...noSu, billingModel: 'api-key', costUsd: 0.01 });
    expect(result.success).toBe(true);
  });

  it('parses correctly when credits is absent (api-key)', () => {
    // credits is optional for non-credit billing models
    const result = CostReportSchema.safeParse(BASE_API_KEY);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.credits).toBeUndefined();
    }
  });

  it('subscriptionUsage is undefined in parsed output when not provided', () => {
    const result = CostReportSchema.safeParse(BASE_API_KEY);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subscriptionUsage).toBeUndefined();
    }
  });
});

// ============================================================================
// CostSource union branches
// ============================================================================

describe('CostSource union branches', () => {
  it('accepts source: agent-reported', () => {
    const result = CostReportSchema.safeParse({ ...BASE_API_KEY, source: 'agent-reported' });
    expect(result.success).toBe(true);
  });

  it('accepts source: styrby-estimate with null rawAgentPayload', () => {
    const result = CostReportSchema.safeParse({
      ...BASE_API_KEY,
      source: 'styrby-estimate',
      rawAgentPayload: null,
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown source value', () => {
    const result = CostReportSchema.safeParse({ ...BASE_API_KEY, source: 'made-up' });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// BillingModel enum exhaustiveness
// ============================================================================

describe('BillingModel enum', () => {
  it('rejects unknown billingModel value', () => {
    const result = CostReportSchema.safeParse({ ...BASE_API_KEY, billingModel: 'magic' });
    expect(result.success).toBe(false);
  });

  it.each(BILLING_MODELS)('accepts billingModel: %s in appropriate context', (model) => {
    // Build a valid fixture for each billing model
    const fixtures: Record<string, object> = {
      'api-key': BASE_API_KEY,
      subscription: BASE_SUBSCRIPTION,
      credit: BASE_CREDIT,
      free: BASE_FREE,
    };
    const result = CostReportSchema.safeParse(fixtures[model]);
    expect(result.success).toBe(true);
  });
});
