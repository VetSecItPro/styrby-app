# Changelog

All notable changes to `styrby-cli` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### 2026-06-11 - Managed agent sessions + real-binary reconciliation + relay hardening

The CLI now drives **all 11 agents through a uniform managed-spawn path** and every
integration has been **verified against its real installed binary**. The prior
integrations were largely written against imagined protocols and several never
fired. Two security fixes ship alongside. PRs #339-#353.

#### Added

- **Managed-spawn for `claude` and `codex`** (PR #339). `styrby start --agent claude`
  and `--agent codex` now open a real managed session (relay-to-chat dispatcher, live
  session row) instead of the old connect-3s-then-disconnect informational stub.
  `claude` is a clean-room `StreamingAgentBackendBase` spawn of the `claude` binary
  (`-p --output-format stream-json --verbose`). It **preserves Max/Pro subscription
  billing** by spawning the user's binary rather than adopting the official Agent SDK.
  `codex` wraps the MCP transport (`codex mcp-server`).
- **Interactive per-tool mobile approval for `claude`** (PR #349). claude now pauses
  at each gated tool (`Bash`, `Edit`, `Write`, `NotebookEdit`, `WebFetch`, `WebSearch`)
  and relays a `permission-request` to mobile; the user approves/denies per call.
  Implemented via an in-process HTTP MCP server (`claudePermissionServer.ts`) bound to
  claude's `--permission-prompt-tool` contract plus a `--settings` `permissions.ask`
  list (precedence deny > ask > allow).

#### Changed

- **All 11 agent integrations reconciled against real binaries** (PRs #352/#353). Each
  invocation + stdout parser was rewritten to match what the installed binary actually
  emits:
  - `opencode`: `run <prompt> --format json`, parses `{step_start|text|step_finish, part:{cost,tokens}}`.
  - `amp`: `amp -x <prompt> --stream-json` (Claude-compatible stream-json; reuses `parseClaudeJsonlLine`).
  - `droid`: `droid exec <prompt> --output-format stream-json` (Claude-shaped; usage has no cost, so styrby-estimated).
  - `kilo`: opencode-fork `run <prompt> --format json` (the prior "memory-bank protocol" was fabricated).
  - `crush`: plain-text passthrough (`crush run <prompt>`); has no machine-readable output, `supportsTools:false`.
  - `goose`: `goose run -t <prompt> --output-format stream-json`.
  - `kiro`: plain-text agent spawning **`kiro-cli`** (not `kiro`; Kiro CLI = rebranded
    Amazon Q Developer CLI). `kiro-cli chat --no-interactive --trust-all-tools <prompt>`,
    ANSI-stripped to model-output; `KIRO_API_KEY` auth; no cost telemetry.
  - `claude`, `codex`, `gemini`, `aider`: verified already-correct, no change.
- **`AGENT_TYPES` is now a single source of truth** (`@styrby/shared`). The `styrby start`
  allowlist had drifted to 5 agents, leaving 6 registered factories (goose/amp/crush/
  kilo/kiro/droid) **unreachable**. Type, relay Zod enum, and CLI gate now all derive
  from one const, so drift is impossible.
- **claude billing detection** now reads the live stream-json `apiKeySource` instead of a
  potentially-stale `~/.claude/auth.json` (PR #346), so subscription vs. API-key billing
  is classified from the actual running session.
- **Install hints** registry-verified and corrected: `amp` to `@ampcode/cli`,
  `crush` to `charmbracelet/tap/crush`, `kiro` to `curl cli.kiro.dev/install` (binary `kiro-cli`),
  `goose` to its curl installer, plus added `claude`/`codex`/`gemini`.

#### Security

- **Relay channels are now private** (PR #351, SEC-RELAY-AUTH-001, the one HIGH).
  `relay:{userId}` was a public Supabase broadcast channel (read-all-chat + forge-chat =
  RCE-class). `RelayClient` now sets `private:true` + pushes the session JWT pre-subscribe;
  migration 100 adds `realtime.messages` RLS gating each user to their own `relay:{uid}` topic.
- **Hardening batch** (PR #350): capability-URL token on the in-process permission MCP
  server (SEC-CLAUDEPERM-001), `mcp-config` temp file written `0o600` (SEC-CLAUDEPERM-002),
  and `assertSafeArgValue` arg-confusion guard rejecting control chars in spawn args
  (SEC-CLIINJ-002). `amp` no longer dual-injects `ANTHROPIC_API_KEY`; it uses `AMP_API_KEY` only.

#### Removed

- **Stale Happy-derived dead code**: the old claude engine (~7k LOC, PR #344) and the
  gemini turn-loop sub-island (PR #347), both superseded by the managed-spawn backends.

#### Fixed

- **Type declarations are shipped again.** The build invoked `npx tsc`, which (because
  `typescript` is a hoisted workspace devDependency, not a direct dep of this package)
  silently downloaded the unrelated registry package named `tsc` and failed. The failure
  was swallowed as "non-fatal," so every publish shipped **zero `.d.ts` files**. The build
  now resolves the real compiler via `require.resolve('typescript/bin/tsc')`; the tarball
  now includes all 141 declaration files for the `dist/lib.js` programmatic entry point.
- **`styrby --help` lists all 11 agents.** The help text advertised only 5
  (claude/codex/gemini/opencode/aider) and the `install <agent>` line listed the same 5,
  while 11 are supported. Both are now derived from the canonical `AGENT_TYPES` const, with
  a unit test asserting every agent appears (drift-proof).
- **`SECURITY.md` is now included in the package.** It was declared in `files[]` but did
  not exist on disk, so it never shipped. Added a CLI-focused security policy (reporting,
  E2E crypto matrix, local MCP/permission-server trust model, secret storage).
- **Cost/token parsing hardened against malformed agent output.** A parser-fuzz pass
  (malformed-input corpus through every rewritten stdout parser) found that the
  `opencode` and `kilo` backends assigned `part.tokens.{input,output}` and `part.cost`
  straight through. A buggy or schema-drifted binary sending a string or negative would
  propagate a non-number into the `number`-typed cost-report and into token arithmetic
  (string concatenation), corrupting the cost dashboard. Both now coerce at the parse
  boundary via a new `toNonNegativeNumber` helper (numeric strings accepted; NaN,
  Infinity, negatives, and non-numbers degrade to a safe fallback). The other parsers
  (amp/droid/goose/crush/kiro) already handled the corpus cleanly.

### 2026-05-05 — CLI optimization sprint + B4 error-handling completeness

Single-day sprint hardening the CLI across five dimensions: cold-start
performance, type safety, test coverage on security gates, security-
critical refactors, and **error-handling completeness** (B4) — the latter
under [ADR-006](../../docs/decisions/ADR-006-error-handling-conventions.md)
joining [ADR-003](../../docs/decisions/ADR-003-extract-decision-then-test-pattern.md),
[ADR-004](../../docs/decisions/ADR-004-b1-refactor-roi-deferral.md), and
[ADR-005](../../docs/decisions/ADR-005-as-any-forbidden-in-production-code.md).
24 PRs touching the CLI; full per-PR list below.

### Performance

- **CLI cold-start cut by 54-60%** (PR #265).
  - `styrby --version`: 676 ms → **305 ms** (now under the 500 ms perf budget).
  - `styrby status`: 1041 ms → **420 ms** (now under the 600 ms budget).
  - Implementation: every command handler is now loaded via dynamic
    `import()` in `commandRouter.ts`. Previously every static import at
    the top of the router pulled in the full transitive module graph
    (agent factories, daemon, Supabase SDK) for every CLI invocation,
    even `styrby --version`.
  - Ultra-fast path added in `index.ts` for `--version` / `--help` /
    `version` / `help` / `-v` / `-h` — bypasses Sentry init + the router
    entirely. These two commands are the most common (CI scripts, shell
    completions, first-time discovery).
- **`axios` removed** (PR #265). Only one consumer in the codebase
  (`utils/serverConnectionErrors.ts`). Replaced with native `fetch +
  AbortSignal.timeout()`. Tree-shaken from the bundle (`grep axios
  dist/index.js` returns 0). Saves ~80 KB minified.

### Security

- **CLI-008 + CLI-009 regression coverage** (PR #279).
  - Extracted `api/relayMessageDispatch.ts` from `apiSession.ts`.
    The schema-validation gate (CLI-008) and permission-response
    nonce-verification gate (CLI-009) — both shipped as defenses in
    PR #262 — were at 0% test coverage. Now covered by 23 unit tests
    against the pure `classifyRelayMessage()` helper.
  - Discriminated-union `RelayDispatchVerdict` makes the dispatch
    obviously-correct: one branch per variant, no nested conditions,
    TS exhaustiveness checking on missing cases.
- **Bash-permission auto-approval rules** now tested (PR #280).
  - Extracted `claude/utils/bashPermissionRules.ts` from
    `permissionHandler.ts`. The `parseBashPermission()` and
    `isBashCommandAllowed()` decisions gate every `Bash(command)`
    auto-approval. Now covered by 24 unit tests including the
    SECURITY-CRITICAL "prefix at START, not anywhere" assertion that
    catches a naive `.includes()` regression.
- **`HAPPY_CLAUDE_PATH` validator regression coverage** (PR #278).
  - `validateHappyClaudePath()` (CLI-003 hardening) is the gate
    against an attacker poisoning the env var to redirect the agent-
    binary spawn to `/tmp/evil`. Was at 0% coverage. Now covered by
    14 unit tests (control-char rejection, path-traversal rejection,
    allowed-root enforcement, existence checks, positive-path fixtures).

### Type safety

- **`as any` count in production: 32 → 1** (-97%, 5 PRs).
  - Single remaining instance is intentional + ESLint-disabled +
    documented in [ADR-005](../../docs/decisions/ADR-005-as-any-forbidden-in-production-code.md)
    (Headers constructor union narrowing limitation).
  - `CostReportMessage` variant added to `AgentMessage` union (PR #266)
    — eliminates `as any` cast at every cost-report emit site across
    8 agent factories + the ACP session-update handler.
  - `gemini/messageHandler.ts` rewritten with proper switch-case
    narrowing (PR #270) — 10 `as any` casts removed in one file.
  - 6 approved narrowing patterns documented in ADR-005 cover ~95% of
    cases where `as any` is tempting.

### Tests

- **Suite size: 2696 → 2918 tests** (+222 net new tests across the day,
  including +38 from the B4 error-handling waves below).
- 9 files moved from 0% test coverage to ~95-100% coverage:
  - `auth/local-server.ts` (OAuth callback server, PR #267) — 11 tests
  - `cli/handlers/status-helpers.ts` (extracted, PR #268) — 20 tests
  - `cli/handlers/costs-helpers.ts` (extracted, PR #273) — 10 tests
  - `gemini/utils/errorFormatter.ts` (PR #275) — 30 tests
  - `ui/ink/messageBuffer.ts` (PR #276) — 15 tests
  - `claude/sdk/stream.ts` (PR #277) — 11 tests
  - `claude/sdk/utils.ts: validateHappyClaudePath` (PR #278) — 14 tests
  - `api/relayMessageDispatch.ts` (extracted, PR #279) — 23 tests
  - `claude/utils/bashPermissionRules.ts` (extracted, PR #280) — 24 tests
- **Conformance test for the 9 streaming agent factories** (PR #269).
  Catches the recurring "added agent #12 but forgot to wire it into
  the registry / index barrel" bug class at build time with a clear
  "X is not registered" message.
- Vitest config updated (PR #265): perf tests now excluded from default
  `pnpm test` runs (env-gated via `STYRBY_SKIP_PERF_TESTS=1` in the
  package.json script). They were unreliable under parallel test load
  (~2x inflated measurements). CI's dedicated `perf-budgets` job runs
  them in isolation where measurements are stable.

### Error-handling completeness (B4)

3-wave audit + fix sprint closing 17 real error-handling smells across the
CLI's security, data-integrity, and operational tiers. Audit produced 67
candidates; read-the-code triage rejected 33 false positives (66% false-
positive rate overall), leaving 17 actionable fixes shipped as 3 PRs.

- **Auth + token-refresh resilience** (PR #281). `TokenManager` now emits
  a typed `'refresh-failed'` event with `trigger: 'hydrate' | 'scheduled'`
  on background refresh failure (was silent `logger.debug`). Subscribers
  (daemon, session manager) can react to stale auth instead of waiting
  for the next API call to 401.
- **OAuth + GDPR fetch timeouts** (PR #281). `AbortSignal.timeout(15_000)`
  added to `exchangeCodeForTokens` (Supabase OAuth POST) and
  `AbortSignal.timeout(30_000)` to both `/api/account/export` and
  `/api/account/delete` fetches in `commands/privacy.ts`. A hung backend
  no longer wedges the CLI indefinitely.
- **Relay-send wrapper** (PR #282). NEW `api/safeRelaySend.ts` (~70 LOC)
  replaces 10 disparate `.catch(() => {})` and `.catch((e) => logger.debug
  (...))` sites in `apiSession.ts` with a single typed wrapper. Returns
  `{ ok: true; result } | { ok: false; error }` and always logs at
  `logger.warn` with structured `{ sessionId, messageType, detail, error }`
  context. Single seam for future Sentry capture + telemetry.
- **Budget-stop notification visibility** (PR #282). `budget-actions.ts`
  stop-notification failure now uses `logger.warn` with `{ alertId,
  alertName, error }` instead of `this.log()` (which only emitted in
  debug mode). Local stop callback still fires; only the mobile-side
  notification was previously silent.
- **Bounded launch retry** (PR #283). `claudeLocalLauncher.ts` now uses
  the new `claude/utils/launchRetryPolicy.ts` decision helper to cap
  consecutive fast failures at 3 (each within a 2s window). Previously
  `while (true) { try { spawn } catch { continue } }` could burn CPU
  forever on persistent synchronous spawn failures (missing PATH,
  corrupt install). Give-up path emits an actionable error message
  pointing at `styrby doctor`.

### Documentation

- NEW [ADR-006: Error-handling conventions](../../docs/decisions/ADR-006-error-handling-conventions.md)
  codifies the 4 allowed error-handling shapes (Surface-loudly /
  Wrap-and-warn / Best-effort-with-WHY-comment / Structured-emit-and-
  continue), the false-positive checklist (8 patterns future audits
  should NOT re-flag), the 5-site rule for wrapper extraction, and
  the audit-vs-reality calibration (66% false-positive rate by tier).

### Discovered + filed for future cleanup

- `readReconnectHistory()` parser has an off-by-one quirk: with `[close,
  connected]` (only 2 lines, fresh log), produces 2 orphan events instead
  of 1 paired-success. For 3+ events the pairing works. Documented in
  the PR #268 tests; fix queued.
- `createGeminiBackend()` does heavy work at construction time (5+ s) —
  likely an eager spawn of the gemini CLI binary. All 8 other streaming
  agent factories construct in <1 ms. Filed; gemini is `skipIf`'d in the
  factory-matrix conformance test until fixed.

### Per-PR ledger (CLI-touching only)

| PR | Title | Squash |
|----|-------|--------|
| #265 | perf(cli): lazy-load command router + drop axios = 56% startup win | `3df7896` |
| #266 | clean(cli): add CostReportMessage to AgentMessage union, drop 8 `as any` | `ad38611` |
| #267 | test(cli): add 11 tests for auth/local-server.ts (0% → ~95% coverage) | `1f3ea39` |
| #268 | test(cli): extract + test status-helpers (3 pure fns, +20 tests) | `43f068a` |
| #269 | test(cli): conformance matrix for 9 streaming agent factories (C3) | `325b730` |
| #270 | clean(cli): proper type narrowing in gemini messageHandler (-10 `as any`) | `48a4272` |
| #271 | clean(cli): drop 6 more `as any` across 3 files (B2 batch 2) | `4c68153` |
| #273 | test(cli): extract + test costs.ts formatters (formatTokens, formatCost) | `5d0ead1` |
| #274 | clean(cli): final B2 batch — drop 6 more `as any` (1 intentional remains) | `2442eaa` |
| #275 | test(cli): 30 tests for gemini errorFormatter (0% → ~95% coverage) | `ca5e070` |
| #276 | test(cli): 15 tests for ui/ink/messageBuffer (0% → 100%) | `06b7296` |
| #277 | test(cli): 11 tests for claude/sdk/stream (0% → 100%) | `3cde2f3` |
| #278 | test(cli): export + test validateHappyClaudePath (CLI-003 security gate) | `b125933` |
| #279 | refactor+test(cli): extract relay-dispatch decision logic + 23 tests | `5923ca3` |
| #280 | refactor+test(cli): extract bash-permission rules + 24 tests | `7d2ca96` |
| #281 | fix(cli): B4-Wave1 — security-tier error-handling completeness | `e5258c4` |
| #282 | fix(cli): B4-Wave2 — data-integrity error-handling via safeRelaySend wrapper | `4b1a3ca` |
| #283 | fix(cli): B4-Wave3 — operational error-handling (bounded launch retry) | `4bc77d6` |

(Earlier-day non-CLI PRs — #258 webhook health monitor, #259 polar env
schema fix, #260 OR credit-monitor non-fatal, #261 web hardening,
#262 CLI security+UX bundle (already in the 0.2.0-beta.1 entry below),
#263 + #264 db hardening, #272 uptime monitor recovery-loop fix —
not listed here as they don't change the CLI shape.)

---

## [0.2.0-beta.1] — 2026-04-30

### H41 Strategy C — CLI architectural refactor

The 0.2.x line removes the embedded Supabase project anon key from the CLI
bundle. Every Postgres operation that previously ran through the
`@supabase/supabase-js` client (templates, contexts, audit log, sessions,
session groups, cost records, notification preferences, MCP approvals) is
now routed through `/api/v1/*` endpoints behind a per-user `styrby_*`
bearer key minted at onboard time.

This reduces the CLI's attack surface and brings it in line with the
zero-shared-secret model used by mobile and web clients.

### Added

- `StyrbyApiClient` (`src/api/styrbyApiClient.ts`) — typed HTTP client for
  every `/api/v1/*` endpoint. Single retry/backoff policy, single
  `StyrbyApiError` shape, automatic Sentry breadcrumbs.
- `getApiClient()` / `MissingStyrbyKeyError` (`src/api/clientFromPersistence.ts`)
  — central factory that mints an authenticated client from persisted
  credentials and surfaces a clean re-onboard prompt when the key is
  missing.
- `/api/v1/auth/exchange` server bridge — the CLI's onboarding flow now
  exchanges the bootstrap Supabase JWT for a per-user `styrby_*` key on
  first run. Existing onboarded installs upgrade transparently.
- `/api/v1/sessions/groups/[id]/focus`, `/api/v1/sessions/[id]` (PATCH),
  `/api/v1/notification_preferences` (GET), `/api/v1/cost-records` (POST)
  — server-side endpoints that back the CLI swap.
- Migration 069 — `mcp_approval_*` audit_action enum values for the MCP
  approval lifecycle.

### Changed (breaking for v0.1.x → v0.2.x consumers)

- `commands/template.ts`, `commands/context.ts`, `mcp/approvalHandler.ts`,
  `agent/multiAgentOrchestrator.ts`, `costs/budget-actions.ts`,
  `costs/cost-reporter.ts` no longer construct or accept a Supabase client
  for the swapped callsites. They now require a `StyrbyApiClient` (or
  call `getApiClient()` themselves).
- The orchestrator's `MultiAgentConfig` gains a required `httpClient`
  field; `supabase` is retained transitionally for the still-Supabase-backed
  `ApiSessionManager.startManagedSession`.
- Group IDs are now server-generated (POST `/api/v1/sessions/groups`
  returns the new `group_id`); the CLI no longer mints UUIDs.
- The optimistic-locking retry loop in `commands/context.ts` is gone —
  POST `/api/v1/contexts` resolves concurrent writes server-side via
  `INSERT … ON CONFLICT (session_group_id) DO UPDATE`.

### Security

- The Supabase project anon JWT is no longer present in the compiled CLI
  bundle. `grep "eyJhbGci" packages/styrby-cli/dist/index.js` returns no
  matches at v0.2.0-beta.1.
- Every `/api/v1/*` endpoint enforces ownership server-side and returns
  404 (not 403) on cross-user resource lookups, defeating IDOR
  enumeration.
- All POST/PATCH bodies are guarded by Zod `.strict()` schemas on the
  server (mass-assignment defense).

### Deferred

- `costs/cost-reporter.ts` — the `finalizePending` UPDATE callsite still
  hits Supabase directly. A `PATCH /api/v1/cost-records/[id]` endpoint
  is needed to retire it; tracked as a follow-up.
- Supabase-Auth-based onboarding paths (`auth/browser-auth.ts`,
  `auth/token-manager.ts`, `auth/machine-registration.ts`), the
  `ApiSessionManager` relay client, and a handful of UI command paths
  (`commands/interactive.ts`, `commands/export.ts`, `cli/handlers/start.ts`)
  still consume `@supabase/supabase-js` at runtime. The package remains
  a CLI dependency at 0.2.0-beta.1; full extraction is tracked as
  post-launch work.

## [0.1.0-beta.7] — earlier

Initial closed-beta releases before the Strategy C refactor. Bundled the
Supabase project anon key directly. Use 0.2.0-beta.1 going forward.
