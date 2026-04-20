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
