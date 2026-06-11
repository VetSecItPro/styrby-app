# Security Policy - styrby-cli

This file covers the published `styrby-cli` npm package. The full monorepo
security policy (web, mobile, database, edge functions) lives in the repository
root `SECURITY.md`.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email: security@styrby.app

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested mitigations

We acknowledge receipt within 48 hours and provide a resolution timeline.

## Supported Versions

| Version | Supported |
| ------- | --------- |
| Latest  | Yes       |

Only the latest published release receives security patches.

## Disclosure Policy

- Coordinated disclosure.
- We aim to patch critical vulnerabilities within 7 days.
- We credit researchers who responsibly disclose (unless they prefer anonymity).
- We notify affected users if user data may have been at risk.

## What the CLI does and does not do

- **Code stays local.** The CLI relays only agent I/O (prompts, responses, tool
  events) to your paired mobile device. It does not upload your source tree.
- **Outbound network surface** is limited to the Styrby API and your Supabase
  project over HTTPS. The CLI does not follow cross-domain redirects.
- **Agent binaries run as you.** `styrby start --agent <name>` spawns the
  agent's own CLI binary (claude, codex, gemini, opencode, aider, goose, amp,
  crush, kilo, kiro, droid) with your local permissions. Styrby does not
  sandbox the agent; it gates tool calls (for agents that support it) behind
  per-tool mobile approval.

## End-to-End Encryption

Messages relayed between the CLI and the mobile app are end-to-end encrypted.
At-rest session messages are encrypted before they leave the machine.

| Use case | Primitive | Key size | Nonce |
|----------|-----------|----------|-------|
| CLI to mobile message E2E | crypto_box (Curve25519 + XSalsa20-Poly1305) | 32-byte keypair per party | 24 bytes |
| At-rest session messages | crypto_secretbox (XSalsa20-Poly1305) | 32-byte symmetric (HMAC-SHA512 KDF) | 24 bytes |

All authenticated ciphers append a 16-byte Poly1305 MAC. Encryption is provided
by `libsodium-wrappers` (pinned exact). Forward secrecy is not yet provided
(static Curve25519 keys); see the root `SECURITY.md` for the roadmap.

## Local Secret Storage

CLI credentials (Supabase JWT, machine keys, agent API keys) are stored in the
OS keychain via `keytar` when available, falling back to an AES-256-GCM
encrypted file (`0o600`) on systems without a keychain (e.g. headless Linux
without libsecret).

## Local MCP / Permission Server

When driving `claude` with per-tool approval, the CLI runs an in-process HTTP
MCP server bound to localhost. It is protected by a 256-bit capability token in
the request path; requests without the token receive a 404. The MCP config is
written to a temp file with `0o600` permissions. No remote network surface is
exposed by this server.

## Dependency Security

Dependencies are monitored via `pnpm audit` and patched transitive versions are
forced via `pnpm.overrides` in the repository root `package.json`. See the root
`SECURITY.md` for the current override floors and any accepted risks.
