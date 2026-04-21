# Security Policy

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

To report a security vulnerability, email: security@styrby.app

Include in your report:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested mitigations

We will acknowledge receipt within 48 hours and provide a timeline for resolution.

## Supported Versions

| Version | Supported |
| ------- | --------- |
| Latest  | Yes       |

Only the latest release receives security patches.

## Disclosure Policy

- We follow coordinated disclosure
- We aim to patch critical vulnerabilities within 7 days
- We credit researchers who responsibly disclose (unless they prefer anonymity)
- We will notify affected users if user data may have been at risk

## Dependency Security

We actively monitor dependencies via `pnpm audit` and apply `pnpm.overrides` in `package.json` to force patched versions across transitive dependency trees.

Current override floors (as of 2026-04-19):

| Package | Override Floor | Resolves |
| ------- | -------------- | -------- |
| `hono` | `>=4.12.14` | GHSA-wmmm-f939-6g9c, GHSA-458j-xx4x-4375 |
| `@hono/node-server` | `>=1.19.13` | Pairs with hono CVEs above |
| `@xmldom/xmldom` | `>=0.8.12` | HIGH - malformed XML DoS in plist 3.0.6 path |
| `nodemailer` | `>=8.0.4` | SMTP CRLF injection (GHSA-vvjj-xcjg-gr5g) |
| `undici` | `>=7.24.5` | Various HTTP smuggling CVEs |
| `rollup` | `>=4.59.0` | DOM clobbering vulnerability |
| `tar` | `>=7.5.13` | Path traversal |

## Cryptographic Primitives (Phase 1.3 - libsodium migration)

As of 2026-04-20, all E2E encryption uses libsodium-wrappers@0.7.15.
Previous versions used TweetNaCl; see "Migration notes" below for the
compatibility guarantees that let us switch without re-encrypting data.

### Cipher matrix

| Use case | Primitive | Key size | Nonce size | Where |
|----------|-----------|----------|------------|-------|
| CLI - mobile message E2E | crypto_box (Curve25519 + XSalsa20-Poly1305) | 32-byte pub + 32-byte sec per party | 24 bytes | `@styrby/shared/encryption` |
| At-rest session messages | crypto_secretbox (XSalsa20-Poly1305) | 32-byte symmetric (HMAC-SHA512 derived from user seed) | 24 bytes | `styrby-cli/src/session/encryption` |
| Future: file attachments, streaming | XChaCha20-Poly1305 IETF AEAD | 32-byte symmetric | 24 bytes | `@styrby/shared/encryption.encryptStream` |
| Key fingerprint (display only) | SHA-256, truncated to first 8 bytes | N/A | N/A | `Web Crypto API` |

All authenticated ciphers use Poly1305 for the MAC tag (16 bytes appended).

### WHY libsodium (over TweetNaCl)

- **Active maintenance**: TweetNaCl has been frozen since 2019. libsodium ships
  regular releases with CVE response, which matters for audit posture and
  acquirer due diligence.
- **Expanded primitive set**: XChaCha20-Poly1305 (extended 192-bit nonce AEAD),
  BLAKE2b, Argon2id, HKDF, and AEGIS are available for future feature work
  without adding a second cryptography dependency.
- **Constant-time guarantees**: The underlying C core has stronger
  constant-time properties than the hand-audited pure-JS NaCl.
- **Ecosystem alignment**: Signal, libsignal, FIDO2 reference libraries, and
  most enterprise-grade cryptography depend on libsodium. Matches the library
  that auditors expect to see.

### WHY async API (`await sodium.ready`)

libsodium is distributed as a WebAssembly module. The WASM binary must be
compiled and loaded before any crypto call runs. The public API in
`@styrby/shared/encryption` is therefore async: every function returns a
`Promise` and internally awaits `ensureReady()`. Callers must `await` the
call.

Hiding this behind a sync facade would require either:
1. A manual `init()` step callers forget until a user session crashes, or
2. A ~3x-larger sync-only WASM build with fewer primitives.

Neither is acceptable. Async API keeps the contract honest and
TypeScript-checkable at every callsite.

### Migration notes (2026-04-20)

- **Wire format unchanged**: libsodium's `crypto_box_easy` and
  `crypto_secretbox_easy` produce byte-for-byte identical ciphertext to
  TweetNaCl's `nacl.box` / `nacl.secretbox` for the same inputs. Existing
  rows in `session_messages` decrypt unchanged.
- **Base64 variant**: Using `sodium.base64_variants.ORIGINAL` (standard
  base64 with padding) to match tweetnacl-util's output. libsodium defaults
  to URL-safe without padding, which would break existing stored values.
- **Compatibility test**: `packages/styrby-shared/tests/encryption-compat.test.ts`
  runs every migration CI cycle and asserts byte-for-byte interop between
  TweetNaCl and libsodium. If this file ever fails, the migration has
  introduced a regression and must be rolled back.
- **Key rotation not required**: No user re-keying needed. All previously
  generated keypairs in `machine_keys` continue to work unchanged.

### Attack surface

| Surface | Mitigations |
|---------|-------------|
| Nonce reuse | Fresh `randombytes_buf(24)` per message; 192-bit space makes collisions infeasible at any realistic volume |
| Weak keys | 32-byte keys from `crypto_box_keypair` (Curve25519) or HMAC-SHA512 KDF (secretbox) |
| Tamper detection | Poly1305 MAC on every ciphertext; `crypto_box_open_easy` throws on mismatch |
| Key compromise | Forward secrecy NOT provided (Curve25519 static keys). For forward-secret sessions, future work: X3DH or Noise handshake on top |
| WASM supply chain | `libsodium-wrappers@0.7.15` pinned exact; dependency audit in CI; SRI checks not applicable (bundler-emitted) |
| Timing leaks | libsodium's C core uses constant-time comparisons; pure-JS NaCl was already acceptable here but the C impl is stronger |

### Standards referenced

- NIST SP 800-175B (cryptographic module selection)
- RFC 8439 (ChaCha20-Poly1305)
- NaCl / libsodium Cryptography Library documentation
- OWASP ASVS V6 (Stored Cryptography) + V7 (Error Handling and Logging)
- AICPA TSC CC6.7 (Transmission and movement of information) - authenticated encryption in transit + at rest

---

## Passkey UX + Key Management (Phase 1.2)

Migration 020 adds a `passkeys` table and the `verify-passkey` Supabase Edge Function
implementing WebAuthn Level 3 (FIDO2 / NIST 800-63B AAL3).

### Enrollment flow

1. User taps "Add a passkey" in **Settings > Passkeys** (web or mobile).
2. Client POSTs `action: challenge-register` to the Next.js proxy (`/api/auth/passkey/challenge`).
   The proxy forwards the request - with the user's Supabase JWT - to the edge function.
3. The edge function reads the user record from the JWT, issues a random 32-byte challenge
   (stored in-memory for 5 minutes), and returns `PublicKeyCredentialCreationOptions`.
4. The browser or device calls `navigator.credentials.create()` (web) / `Passkey.create()` (mobile).
   The user approves with Face ID, Touch ID, or their device PIN.
5. Client POSTs the attestation to `action: verify-register`. The edge function verifies the
   signature, checks the challenge, and inserts a row into `passkeys` using the service role key
   (INSERT is blocked from the anon key by RLS).
6. The new credential row is owned by the user (RLS: `user_id = auth.uid()`).

### Authentication flow

1. User taps "Continue with Passkey" on the login screen (email optional).
2. Client POSTs `action: challenge-login` with optional email. The edge function returns an empty
   `allowCredentials` list for unknown emails (account-enumeration resistance per WebAuthn L3 §14.5).
3. Browser/device resolves credentials. User approves biometric/PIN.
4. Client POSTs `action: verify-login`. The edge function verifies the assertion counter
   (clone-detection per L3 §7.2 step 19), updates `last_used_at` and the counter, then mints
   a Supabase session and returns `access_token` + `refresh_token`.

### Revocation semantics

- Revoked credentials are **soft-deleted** (`revoked_at = now()`), never hard-deleted.
  Hard deletion would cause a 404 on a revoked-credential presentation, making it
  indistinguishable from a misconfigured RP ID. A row with `revoked_at` set lets the server
  return a clear `CREDENTIAL_REVOKED` error. (SOC2 CC6.6)
- Users revoke via Settings > Passkeys. Revocation takes effect immediately - the edge function
  checks `revoked_at` before verifying signatures.
- Admins can revoke any user's credential via the admin dashboard (audit-logged).

### Cross-device considerations

Passkeys are synced by the platform (iCloud Keychain on Apple, Google Password Manager on Android,
Windows Hello on Windows). Revoking one credential revokes the logical key; the platform may have
synced it to multiple physical devices. Revoking in Styrby removes it from the server's trust list
regardless of which physical device holds the key material.

### Attack surface

| Surface | Mitigations |
|---------|-------------|
| Challenge issuance (`/api/auth/passkey/challenge`) | Rate-limited 10/min per IP (distributed via Upstash Redis); no auth required but edge fn enforces auth for `challenge-register` |
| Assertion verification (`/api/auth/passkey/verify`) | Rate-limited 10/min per IP; counter-rollback check (clone detection); revoked_at check before any verification |
| Service role key | Never in browser; only in edge function env and Next.js server context (never NEXT_PUBLIC_) |
| Account enumeration | `challenge-login` returns empty `allowCredentials` for unknown emails - identical response shape, no timing oracle |
| RP ID binding | RP ID derived from request host via `extractRpId(url)` - mismatched origins (e.g. phishing sites) produce SecurityError in browser before any server call |
| Replay attacks | 5-minute challenge TTL enforced in edge function; signature counter monotonicity enforced per L3 §7.2 step 19 |

---

## MCP Server Surface (Phase 1 wedge — full Phase 4)

Styrby exposes a Model Context Protocol (MCP) server via `styrby mcp serve`
so MCP-aware coding agents (Claude Code, Codex, Cursor) can call back into
Styrby for capabilities only Styrby has. The Phase 1 wedge ships a single
tool — `request_approval` — that delivers a push to the user's mobile
device and awaits the user's decision before returning to the agent.

### Trust model

The MCP server runs as a child process spawned by the user's local coding
agent. It inherits the user's authenticated CLI context (the same
persisted credentials as `styrby start`). The agent process and the MCP
server communicate over stdio (JSON-RPC); no network surface is exposed.

| Trust boundary | What crosses it |
|----------------|-----------------|
| Agent → MCP server (stdio JSON-RPC) | Tool calls + arguments — already inside the user's local trust zone |
| MCP server → Supabase (HTTPS) | Approval requests, audit log writes, future tool DB calls |
| Supabase trigger → Edge Function (HTTPS) | Push delivery payload (no plaintext credentials) |
| Edge Function → APNs/FCM | Push notification body (action summary; **no secrets, no message content**) |
| Mobile device → Supabase (HTTPS) | User decision (approve/deny + optional reason) |

### Authentication and session

- The MCP server **must** have a valid Supabase JWT in the persisted CLI
  credentials. If the user hasn't onboarded or paired, the server exits
  rather than starting in a degraded state.
- All Supabase calls use the user's anon-key + Authorization header. The
  service role key is never read or required by the MCP server process.
- The MCP server is a one-shot process bound to the agent's lifetime; it
  exits when stdin closes (parent agent quit). No long-lived state.

### `request_approval` tool — privacy properties

| Property | Mitigation |
|----------|------------|
| **Action description visibility** | The action + reason strings are written to `audit_log.metadata` (RLS-scoped to the user) and rendered on the user's mobile device. Both flows are user-only — Styrby admins cannot see arbitrary user actions absent explicit DB privilege. |
| **Push notification body** | The push payload contains only the action summary text (max 500 chars). No agent output, no file contents, no diffs are pushed. |
| **Optional context object** | Free-form JSONB stored in `audit_log.metadata`. Same RLS scope. Callers should avoid putting secrets in `context`; we will add a Zod refinement to redact common secret patterns in Phase 4. |
| **Decision metadata** | The user's decision (approve/deny) and optional message string are written back to `audit_log` via the mobile client. Same RLS scope. |
| **Timeout default** | 5 minutes (matches WebAuthn challenge TTL and push round-trip budget). Caller can override per-request up to 30 minutes. Beyond 30 min the tool returns a denied + "request timed out" reason. |

### Threat model

| Threat | Mitigation |
|--------|------------|
| Malicious agent calls `request_approval` to phish user with confusing prompts | The mobile UI shows the agent's source process metadata + risk level in the approval card. The user is the trust gate; Styrby surfaces enough context for them to decide. |
| Compromised MCP server fabricates a "decision" return value | The server **only** returns what the audit_log decision row says. It cannot synthesize approvals. The decision row is written by the authenticated mobile client; an attacker would need the user's mobile session to forge one. |
| Race condition between two concurrent approval requests | Each request gets a fresh UUID `approval_id`. The poll loop matches on that ID, so two simultaneous requests cannot resolve to the same decision. |
| Timeout-spoofing by the server (claiming user approved when they didn't) | The audit log's INSERT is server-side; the user's decision INSERT comes from the mobile client. A server fabrication would require write access from the CLI, which it has — but the audit log is append-only and tamper-evident (no UPDATE/DELETE permissions on user rows). |
| Stdio framing corruption from stray stdout writes | All Styrby logging routes to stderr. `console.log` is forbidden in the `commands/mcpServe.ts` path; tests assert this. |

### Phase 4 expansions

When the full MCP implementation lands:
- Dedicated `mcp_approvals` table (replaces audit_log overload) with
  realtime subscription instead of poll
- Per-team policy table that the new `get_team_policy` tool reads
- Rate-limiting at the tool layer (per-user, per-tool quotas)
- HTTP/SSE transport for remote agents (today: stdio only)
- MCP client side (consume user-configured MCP servers per `agent_configs`)
- Registry browser at `/dashboard/tools` expanded with install/authorize
  flow for third-party MCP servers (modelcontextprotocol/registry)

### Standards

- **MCP Specification 2024-11-05** (Anthropic) — protocol, tool annotations
- **OWASP ASVS V13 (API)** — input validation via Zod schemas on every tool
- **AICPA TSC CC7.2 (System Operations)** — tool calls + decisions are
  audit-logged for compliance trails
- **NIST SP 800-53 AC-3 (Access Enforcement)** — request_approval is the
  human-in-the-loop control for agent actions that should require explicit
  authorization

---

## Push Notification Attack Surface (Phase 0.5)

Migration 017 adds a PostgreSQL trigger (`trigger_push_on_session_message`) that
fires outbound HTTP requests to the Supabase Edge Function via `pg_net`.

**New attack surface introduced:**

| Surface | Mitigations |
|---------|-------------|
| `pg_net` async HTTP from trigger | Service role key stored in Supabase Vault (encrypted), not hardcoded in SQL |
| Admin test endpoint (`POST /api/internal/test-push`) | Admin-only gate (`isAdmin()`), input validated with Zod UUID schema, all actions logged to `audit_log` with `control_ref: SOC2 CC7.2` |
| Edge function `send-push-notification` | Timing-safe service role key comparison (XOR comparison, constant-time) |
| Dead-letter token deactivation | Invalid tokens set `is_active=false`, not deleted - preserves audit trail |
| Quiet hours enforcement | Checked at both trigger level (`push_enabled` fast-path) and edge function level (full quiet hours window logic) - GDPR Art. 25 privacy by design |

**Not in scope for this route:**

The admin test endpoint can send to any user's device. This is intentional admin
capability and is audited. Restrict `isAdmin` grants accordingly.

## Accepted Risks

The following known vulnerabilities are present in this codebase and have been evaluated and accepted. They will not be patched via overrides because no upstream fix exists or the exposure is limited to non-production contexts.

---

### lodash `_.template` CVE - GHSA-r5fr-rjxr-66jc

| Field | Value |
| ----- | ----- |
| Severity | HIGH |
| Package | `lodash` |
| CVE | GHSA-r5fr-rjxr-66jc |
| Attack vector | Template injection via `_.template()` with attacker-controlled input |

**Why accepted:**

- **Exposure path:** `jest-expo` (dev dependency only, used as test runner)
- **Production exposure:** None - `jest-expo` is never bundled into production builds
- **Context:** In the `jest-expo` test runner context, there are no attacker-controlled template strings. All lodash template calls originate from Jest internals running in a sandboxed test environment.
- **Upstream status:** Lodash 4.x is security-frozen. No patch exists. Lodash 5.x is not yet stable. A `pnpm.overrides` entry would fail because version `4.18.*` does not exist.
- **recharts path:** Previously exposed via recharts 2.x (which vendors lodash). Resolved by upgrading recharts to 3.x, which does not vendor lodash.

**Mitigation:** `jest-expo` is a `devDependency` only. It is excluded from production bundles via Next.js build system and Expo build pipeline. CI confirms no lodash code ships in production artifacts.

**Review trigger:** When we migrate off `jest-expo` to a modern test runner (e.g., Vitest with Expo support), re-evaluate and remove this entry.

---

### follow-redirects auth header leak - GHSA-r4q5-vmmm-2653

| Field | Value |
| ----- | ----- |
| Severity | MODERATE |
| Package | `follow-redirects` |
| CVE | GHSA-r4q5-vmmm-2653 |
| Attack vector | Custom auth headers leaked on cross-domain redirects |

**Why accepted:**

- **Exposure path:** `styrby-cli` > `axios` > `follow-redirects`
- **Context:** The CLI only makes outbound requests to known Styrby API endpoints and Supabase. It does not follow cross-domain redirects in practice.
- **Mitigation:** All CLI API calls target hardcoded `https://api.styrby.app` and `https://akmtmxunjhsgldjztdtt.supabase.co` - both under our control. A redirect to a hostile domain would require a server-side compromise first.
- **Override status:** `follow-redirects >=1.16.0` is patched. Will be applied in the next regular dependency maintenance cycle.

**Review trigger:** Next `pnpm` deps maintenance pass.
