# REFACTOR-1: Splitting `/api/webhooks/polar/route.ts` (2136 lines)

**Why this exists:** the polar webhook route is the single largest file in the codebase (5.4× the CLAUDE.md 400-line ceiling). Per the Component-First Architecture rule, files this large must be split. This is the money-path code that handles every billing event from Polar — refactor must be careful + tested + reviewable end-to-end.

This file is the operator playbook. Don't execute it without the operator green-light, and don't merge any step without 100% green tests.

## Why it's grown to 2136 lines

The file started as a thin webhook receiver but accumulated:

1. Signature verification + idempotency checks (~150 lines)
2. Schema validation (Zod for the team event shape) (~50 lines)
3. Team-tier event handler (~600 lines: 4 event types × seat reconciliation × audit_log writes)
4. Individual-tier event handler (~700 lines: 4 event types × override-decision logic × tier-rank guard)
5. Subscription cancellation cascade (~250 lines: cascade-cancel orphan seat addons)
6. Helper functions (`getTierFromProductId`, `getBillingCycleFromProductId`, `resolvePolarProductId`, `sha256Hex`) (~150 lines)
7. Refund event handler (~100 lines)
8. Other event types (charge.succeeded, etc.) (~80 lines)
9. Constants + types + JSDoc (~100 lines)

## Target architecture

```
api/webhooks/polar/
├── route.ts                       # ORCHESTRATOR (≤ 300 lines)
│                                  # - signature verify + idempotency
│                                  # - parse + route to handler
│                                  # - top-level error wrapping
├── handlers/
│   ├── subscription-created.ts    # ≤ 200 lines
│   ├── subscription-updated.ts    # ≤ 250 lines
│   ├── subscription-canceled.ts   # ≤ 200 lines (incl. cascade)
│   ├── subscription-revoked.ts    # ≤ 200 lines (incl. cascade)
│   └── refund-created.ts          # ≤ 100 lines
├── lib/
│   ├── product-resolver.ts        # getTierFromProductId, getBillingCycleFromProductId, resolvePolarProductId
│   ├── event-schema.ts            # Zod TeamSubscriptionDataSchema, PolarEventIdSchema
│   ├── idempotency.ts             # sha256Hex + the dedup-table upsert pattern
│   ├── override-decision.ts       # shouldHonorManualOverride wrapper
│   └── tier-rank-guard.ts         # downgrade-protection logic
└── __tests__/
    ├── route.test.ts              # routing + signature + dedup (orchestrator tests)
    ├── subscription-created.test.ts
    ├── subscription-updated.test.ts
    ├── ... (one per handler)
    └── product-resolver.test.ts
```

## Extraction order (lowest risk first)

Each step is its own PR. Do NOT batch. Run the full webhook test suite after every step.

### Step 1: extract pure helpers (no behavior change, no Polar I/O)

Move to `lib/`:
- `getTierFromProductId(productId: string): 'pro'|'power'|'growth'|null`
- `getBillingCycleFromProductId(productId: string): 'monthly'|'annual'`
- `resolvePolarProductId(...)`
- `sha256Hex(input: string): string`
- All Zod schemas (`PolarEventIdSchema`, `TeamSubscriptionDataSchema`)

**Risk:** very low — these are pure functions. Just import them in `route.ts`. ~150 lines extracted.
**Test:** existing webhook tests must all pass; add 1-2 unit tests per extracted helper for documentation.

### Step 2: extract `handleTeamSubscriptionEvent` to `handlers/team-subscription.ts`

Already a single function in the existing code (lines 491-820 ish). Move it as-is. Keep the type signatures stable. ~330 lines extracted.

**Risk:** low — single named export, callers unchanged.
**Test:** team-subscription tests in `__tests__/team-subscription.test.ts` must pass unchanged.

### Step 3: split individual switch into per-event handlers

This is the biggest step. The current `switch (event.type)` block has 4 cases (`subscription.created`, `subscription.updated`, `subscription.canceled`, `subscription.revoked`) plus `subscription.past_due` and `refund.created` and others. Each case is 100-300 lines of inline logic.

For each case, extract to `handlers/<event-name>.ts` exporting a single function:

```ts
export async function handleSubscriptionCreated(
  event: PolarSubscriptionEvent,
  context: WebhookContext
): Promise<NextResponse> { ... }
```

`WebhookContext` is `{ supabase, rawParsed, isDev }` to avoid recreating per call.

**Risk:** medium — the cases share variable names (e.g. `data`, `eventId`, `payloadHash`) that get destructured fresh in each handler. Easy to miss a closure capture.
**Test:** every existing webhook test must pass after every individual extraction. Run the full suite after extracting EACH case, not after batching all 4.

### Step 4: extract cascade-cancel logic to `lib/cascade-cancel.ts`

The seat-addon cascade logic (Bug #4 / Phase H2) appears in TWO places — `subscription.revoked` and `subscription.canceled` paths. Extract to one helper, call from both.

**Risk:** medium-high — this is the seat-billing reconciliation path. Add tests proving the cascade still fires for both event types AND only for Growth subscriptions (not Pro).

### Step 5: extract `shouldHonorManualOverride` wrapper if it's 50+ lines

If the override-decision logic in `subscription.created`/`subscription.updated` is duplicated, factor it.

### Step 6: route.ts is now the orchestrator

What's left in route.ts:
- Signature verify + idempotency check
- Body parse + Zod validate
- Top-level routing: team_id present → team handler; otherwise → switch on event.type → call handler
- Top-level try/catch → 500 with sanitized error

Should be ≤ 300 lines. Verify via `wc -l`.

## What NOT to do

- **Don't change behavior.** This refactor is structural. ANY behavior change goes in a separate PR with its own tests.
- **Don't deduplicate the audit_log inserts** in this refactor. Each handler writing its own audit row is intentional — the action enum values differ per event type.
- **Don't introduce a new abstraction layer** (e.g. an EventRouter class). Plain async functions suffice and are easier to test.
- **Don't merge any step where webhook tests aren't 100% green.**
- **Don't run this refactor immediately after a billing PR (e.g. PR #247).** Let recent billing changes bake for at least a week so any latent issue surfaces against the known-clean monolith before code is moved.

## Verification per step

After each step's PR opens:
1. Local: `npm test -- src/app/api/webhooks/polar` must be 100% green.
2. CI: Postgres Migrations + Web Unit Tests must pass.
3. Manual smoke: trigger a Polar sandbox `subscription.updated` event (via Polar dashboard test webhook) and confirm `audit_log` gets the expected row in the linked Supabase project.

## Why this isn't being done autonomously right now

Per Steel Discipline: refactoring money-path code in the same session that just shipped a major billing change (PR #247) is the wrong sequencing. The refactor is correct but the bake-time isn't. File this for a dedicated session at least 7 days post-#247 (i.e. on or after 2026-05-12) when any latent issue from the billing pipeline change has had time to surface.

When the time comes, follow this playbook step-by-step, one PR per step, and the 5.4× ceiling overrun gets back under control without risking the seat-based pricing pipeline that just shipped.
