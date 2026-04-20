# @styrby/shared

Shared TypeScript library for the Styrby monorepo.

## Purpose

`@styrby/shared` is the single source of truth for types, schemas, crypto primitives, relay protocol, pricing logic, and error classification used across `styrby-cli`, `styrby-web`, and `styrby-mobile`. Keeping this logic in one place ensures that all three packages agree on message formats, pricing calculations, and error codes without duplicating code.

**Who uses it:** Every other package in the Styrby monorepo — it is an internal library, not published to npm.

## Key Features

- Zod schemas for all shared data structures (sessions, messages, configs, billing events)
- TypeScript type definitions inferred from schemas — one source of truth, no manual syncing
- E2E encryption helpers built on TweetNaCl (key generation, encrypt/decrypt, base64 codec)
- Relay protocol types and message envelope definitions for CLI-to-mobile communication
- Static and LiteLLM-backed pricing tables for all supported models
- Error classifier — maps raw agent stderr/stdout to structured error codes with recovery suggestions
- Context template definitions used by both CLI and web template browser

## Setup

This package is private and consumed via the `workspace:*` protocol in `pnpm`. It is built automatically as part of the monorepo `pnpm install`.

```bash
# From repo root
pnpm install       # Installs all workspace packages

# To work on @styrby/shared specifically:
cd packages/styrby-shared
pnpm build         # Compile TypeScript to dist/
pnpm typecheck     # Type-check without emit
pnpm test          # Run Vitest tests
```

### Import paths

```typescript
// Main entry — types, schemas, encryption, utilities
import { SessionSchema, encrypt, classify } from '@styrby/shared';

// Relay protocol types and message builders
import { RelayMessage, buildEnvelope } from '@styrby/shared/relay';

// Pricing tables and cost calculation
import { getModelPrice, calculateCost } from '@styrby/shared/pricing';
```

## Commands

| Script | Command | Purpose |
|--------|---------|---------|
| `build` | `pnpm build` | Compile TypeScript to `dist/` |
| `typecheck` | `pnpm typecheck` | TypeScript check without emit |
| `test` | `pnpm test` | Vitest test suite |

## Architecture

```
src/
├── types/                 # TypeScript interfaces and Zod schemas
│   └── context-templates.ts  # Prompt template type definitions
├── relay/                 # Relay protocol
│   ├── types.ts           # Message envelope and event type definitions
│   ├── client.ts          # WebSocket relay client helpers
│   ├── pairing.ts         # QR-code pairing handshake protocol
│   └── offline-queue.ts   # Offline command queue types
├── pricing/               # Model pricing
│   ├── static-pricing.ts  # Hardcoded pricing table (fast, no network)
│   ├── litellm-pricing.ts # LiteLLM-backed pricing (live rates)
│   └── pricing.test.ts    # Pricing accuracy tests
├── errors/                # Error classification
│   ├── classifier.ts      # Maps agent output to structured error codes
│   ├── patterns.ts        # Regex patterns per agent type
│   ├── suggestions.ts     # Recovery suggestions per error code
│   └── types.ts           # Error type definitions
├── design/                # Design tokens (shared between web + mobile)
├── encryption.ts          # TweetNaCl wrappers (keygen, encrypt, decrypt)
├── utils/                 # General utilities (date formatting, truncation, etc.)
├── types.ts               # Top-level type re-exports
└── index.ts               # Main barrel export
```

## Environment Variables

This package has no runtime environment variable dependencies. It is pure TypeScript compiled to ESM — consumers pass any needed configuration in at the call site.

## Relationship to Other Packages

| Package | Relationship |
|---------|-------------|
| `styrby-cli` | Primary consumer — uses types, encryption, relay protocol, pricing, and error classifier |
| `styrby-web` | Consumer — uses types, pricing, relay types, and error classifier in API routes and UI |
| `styrby-mobile` | Consumer — uses types, encryption, relay protocol, and pricing for display |

Changes to `@styrby/shared` require rebuilding all consumer packages. CI handles this automatically; locally run `pnpm build` in this package before running consumers.

**Breaking changes policy:** Because all three packages are in the same monorepo and deployed together, breaking changes to shared types must be coordinated — update all consumers in the same PR. Do not merge a type change that leaves any consumer broken.

## Contributing

Styrby is proprietary software. Contributions are by invitation only.

If you are an invited contributor:

1. **Tests first.** Pricing calculations and error classifiers are business-critical — every change needs a test.
2. **Schemas are the source of truth.** If you add a field to a Zod schema, the TypeScript type is inferred automatically — don't manually duplicate it.
3. **No breaking changes in isolation.** A PR that changes shared types must also update every consumer in the same PR.
4. **JSDoc every exported symbol.** Other package authors rely on hover-docs to understand the API.
5. **400-line file limit applies here too.** Split large files before opening a PR.
6. **No direct commits to `main`.** Feature branches only.

Report security issues to security@steelmotionllc.com — see `SECURITY.md`.
