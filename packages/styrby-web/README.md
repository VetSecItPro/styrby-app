# styrby-web

The Styrby web dashboard and marketing site.

## Purpose

`styrby-web` is a Next.js 15 application that serves two roles: (1) the public-facing marketing site with pricing, docs, and blog, and (2) the authenticated user dashboard for managing sessions, costs, agent configs, budget alerts, and account settings.

**Who uses it:** End users managing their Styrby subscription and settings; visitors evaluating Styrby.

## Key Features

- Authenticated session dashboard with real-time cost tracking and activity graphs
- Agent configuration management (auto-approve rules, blocked tools, per-agent settings)
- Budget alert setup with configurable thresholds and actions (notify/slowdown/stop)
- Prompt template library (20 system templates + user-created)
- OTP-based auth (email magic link via Supabase + Resend)
- Subscription management via Polar (webhook-synced to Supabase)
- Progressive Web App (PWA) with offline support and service worker via Serwist
- Push notification management (Web Push)
- Admin dashboard with access gate
- Marketing pages: pricing, blog, docs, privacy, security, DPA, terms

## Setup

### Prerequisites

- Node.js >= 20.0.0
- `pnpm` (monorepo package manager)
- Supabase project (see `docs/infrastructure/environment-variables.md`)
- Upstash Redis instance for rate limiting

### Development

```bash
# From repo root
pnpm install

cd packages/styrby-web
pnpm dev           # Start Next.js dev server on http://localhost:3000
pnpm build         # Production build
pnpm start         # Serve production build locally
pnpm lint          # ESLint
pnpm typecheck     # TypeScript type-check
pnpm test          # Vitest unit tests
pnpm test:e2e      # Playwright end-to-end tests
```

## Commands

| Script | Command | Purpose |
|--------|---------|---------|
| `dev` | `pnpm dev` | Start Next.js dev server |
| `build` | `pnpm build` | Production build (webpack mode) |
| `start` | `pnpm start` | Serve production build |
| `lint` | `pnpm lint` | Run ESLint across `src/` |
| `typecheck` | `pnpm typecheck` | TypeScript check without emit |
| `test` | `pnpm test` | Vitest unit test suite |
| `test:watch` | `pnpm test:watch` | Vitest in watch mode |
| `test:coverage` | `pnpm test:coverage` | Vitest with coverage report |
| `test:e2e` | `pnpm test:e2e` | Playwright E2E (all browsers) |
| `test:e2e:chromium` | `pnpm test:e2e:chromium` | Playwright E2E (Chromium only) |

## Architecture

```
src/
├── app/                   # Next.js App Router pages
│   ├── api/               # API routes (auth, billing, sessions, push, webhooks)
│   ├── auth/              # Auth flow pages (login, signup, OTP)
│   ├── dashboard/         # Authenticated dashboard pages
│   ├── blog/              # Blog and article pages
│   ├── pricing/           # Pricing page
│   ├── docs/              # Documentation pages
│   ├── shared/            # Shared layout segments
│   └── ...                # Marketing pages (privacy, security, terms, DPA, etc.)
├── components/            # React components
│   ├── ui/                # Primitive UI components (shadcn/radix-ui)
│   ├── dashboard/         # Dashboard-specific components
│   ├── landing/           # Marketing page components
│   ├── costs/             # Cost chart and breakdown components
│   └── session-replay/    # Session replay viewer
├── lib/                   # Server-side utilities
│   ├── supabase/          # Supabase client setup (server + browser)
│   ├── admin.ts           # Admin guard utilities
│   ├── costs.ts           # Cost aggregation helpers
│   ├── encryption.ts      # Server-side encryption helpers
│   ├── model-pricing.ts   # Token pricing table
│   ├── notifications.ts   # Push notification dispatch
│   ├── polar.ts           # Polar billing SDK setup
│   ├── rateLimit.ts       # Upstash rate limiting
│   ├── resend.ts          # Transactional email (Resend)
│   ├── tier-enforcement.ts # Subscription tier gating
│   └── web-push.ts        # Web Push VAPID helpers
├── hooks/                 # React hooks
├── emails/                # React Email templates
└── middleware.ts           # Route protection + auth middleware
```

## Environment Variables

Environment variables are documented in `docs/infrastructure/environment-variables.md` (local-only planning doc, gitignored). Copy `.env.example` from the repo root for a full list.

| Variable | Required | Purpose |
|----------|----------|---------|
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL (public) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Supabase anon key (public) |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role (server-only) |
| `UPSTASH_REDIS_REST_URL` | Yes | Upstash Redis URL for rate limiting |
| `UPSTASH_REDIS_REST_TOKEN` | Yes | Upstash Redis token |
| `POLAR_WEBHOOK_SECRET` | Yes | Polar webhook signature secret |
| `POLAR_ACCESS_TOKEN` | Yes | Polar API access token |
| `RESEND_API_KEY` | Yes | Resend API key for transactional email |
| `VAPID_PUBLIC_KEY` | Yes | Web Push VAPID public key |
| `VAPID_PRIVATE_KEY` | Yes | Web Push VAPID private key |
| `NEXT_PUBLIC_SENTRY_DSN` | Recommended | Sentry error tracking |

## Relationship to Other Packages

| Package | Relationship |
|---------|-------------|
| `@styrby/shared` | Runtime dependency — shared types, relay protocol, pricing, error classifier |
| `styrby-cli` | The CLI that users install; web dashboard is the companion management UI |
| `styrby-mobile` | Feature parity partner — every dashboard feature ships on mobile too |

## Deployment

Auto-deploys to Vercel on push to `main`. Environment variables are managed in the Vercel dashboard — never in the repo.

## Contributing

Styrby is proprietary software. Contributions are by invitation only.

If you are an invited contributor:

1. **Tests first.** No production code without a failing test that the code fixes.
2. **JSDoc every function and API route.** See the documentation standard in CLAUDE.md (available via repo onboarding docs or your team lead).
3. **400-line file limit.** Page files are orchestrators only — UI sections go in `src/components/{page}/`.
4. **Mobile parity.** Every feature added to the web dashboard must also ship in `styrby-mobile`.
5. **No direct commits to `main`.** Feature branches only — open a PR and wait for CI.

Report security issues to security@steelmotionllc.com — see `SECURITY.md`.
