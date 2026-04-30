# Changelog

All notable changes to `styrby-cli` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
