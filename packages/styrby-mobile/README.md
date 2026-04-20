# styrby-mobile

The Styrby mobile app — Expo React Native for iOS and Android.

## Purpose

`styrby-mobile` is the primary consumer-facing product. It receives real-time, end-to-end encrypted output from AI coding agents running on your desktop (via `styrby-cli`), lets you interact with those agents from your phone, and gives you full session management, cost visibility, and configuration control in a native mobile UI.

**Who uses it:** Developers running `styrby-cli` who want mobile remote control of their AI coding agents.

## Key Features

- Real-time streaming of AI agent output from desktop to phone (E2E encrypted)
- Send messages and approve tool calls from mobile
- Session timeline with bookmarks and checkpoints
- Per-session cost breakdown by token type and model
- Budget alert configuration (notify / slow down / stop)
- Agent configuration — auto-approve rules, blocked tools, model overrides
- Prompt template browser with 20 system templates + user-created
- Offline command queue — commands are queued and delivered on reconnect
- Push notifications (APNs + FCM) for session events and budget alerts
- Biometric authentication via Expo Secure Store

## Setup

### Prerequisites

- Node.js >= 20.0.0
- `pnpm` (monorepo package manager)
- Expo CLI: `npm install -g expo-cli`
- For iOS: Xcode 16+ and an Apple Developer account (simulator works without account)
- For Android: Android Studio with an emulator, or a physical device

### Development

```bash
# From repo root
pnpm install

cd packages/styrby-mobile
pnpm dev           # Start Expo dev server (Metro bundler)
pnpm ios           # Open in iOS Simulator
pnpm android       # Open in Android emulator
pnpm typecheck     # TypeScript type-check
pnpm lint          # ESLint
pnpm test          # Jest test suite
```

### EAS Builds (CI/CD)

```bash
pnpm build:dev     # EAS development build
pnpm build:preview # EAS preview build (internal distribution)
pnpm build:prod    # EAS production build
```

EAS configuration is in `eas.json`. Build profiles and signing credentials are managed in the Expo dashboard.

## Commands

| Script | Command | Purpose |
|--------|---------|---------|
| `dev` | `pnpm dev` | Start Metro dev server |
| `ios` | `pnpm ios` | Launch in iOS Simulator |
| `android` | `pnpm android` | Launch in Android emulator |
| `prebuild` | `pnpm prebuild` | Validate config + generate native dirs |
| `build:dev` | `pnpm build:dev` | EAS development build |
| `build:preview` | `pnpm build:preview` | EAS preview build |
| `build:prod` | `pnpm build:prod` | EAS production build |
| `validate` | `pnpm validate` | Validate app.json config before build |
| `typecheck` | `pnpm typecheck` | TypeScript check without emit |
| `lint` | `pnpm lint` | ESLint across `src/` and `app/` |
| `test` | `pnpm test` | Jest + jest-expo test suite |
| `test:watch` | `pnpm test:watch` | Jest in watch mode |
| `test:coverage` | `pnpm test:coverage` | Jest with coverage report |

## Architecture

```
app/                       # Expo Router file-based navigation
├── (auth)/                # Unauthenticated screens (login, signup, OTP)
├── (tabs)/                # Bottom-tab navigation (sessions, costs, settings)
├── session/               # Session detail + replay screens
├── agent-config.tsx        # Agent configuration screen
├── api-keys.tsx            # API key management screen
├── budget-alerts.tsx       # Budget alert configuration
├── devices.tsx             # Registered device management
├── onboarding/             # First-run onboarding flow
├── templates.tsx           # Prompt template browser
└── ...                     # Other screens (support, team, webhooks)

src/
├── components/            # Reusable UI components
├── contexts/              # React contexts (auth, session, theme)
├── hooks/                 # Custom React hooks
├── lib/                   # Core logic (Supabase client, encryption)
├── services/              # API service layer
└── utils/                 # Utility functions

constants.ts               # App-wide constants
design/                    # Design tokens and theme
encryption.ts              # E2E encryption (TweetNaCl via @styrby/shared)
errors/                    # Error types and handling
pricing/                   # Local pricing display logic
relay/                     # Relay WebSocket client
types/                     # TypeScript type definitions
```

## Environment Variables

Environment variables are documented in `docs/infrastructure/environment-variables.md` (local-only planning doc, gitignored). Copy `.env.example` from the repo root for a full list.

| Variable | Required | Purpose |
|----------|----------|---------|
| `EXPO_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Yes | Supabase anon key |
| `EXPO_PUBLIC_API_URL` | Yes | Styrby relay server URL |
| `EXPO_PUBLIC_SENTRY_DSN` | Recommended | Sentry error tracking |

## Relationship to Other Packages

| Package | Relationship |
|---------|-------------|
| `@styrby/shared` | Runtime dependency — shared types, relay protocol, pricing, error classifier, and E2E crypto |
| `styrby-cli` | The CLI installed on desktop; mobile is the remote control for it |
| `styrby-web` | Feature parity partner — every feature in the mobile app must also exist in the web dashboard |

## Contributing

Styrby is proprietary software. Contributions are by invitation only.

If you are an invited contributor:

1. **Tests first.** No production code without a failing test (Jest + `@testing-library/react-native`).
2. **JSDoc every function.** Undocumented code is incomplete code — see the standard in CLAUDE.md (available via repo onboarding docs or your team lead).
3. **400-line file limit.** Screens are orchestrators — UI sections belong in `src/components/`.
4. **Web parity.** Every feature added to mobile must also ship in `styrby-web`.
5. **No direct commits to `main`.** Feature branches only — open a PR and wait for CI.

Report security issues to security@steelmotionllc.com — see `SECURITY.md`.
