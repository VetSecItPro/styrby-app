# styrby-cli

Control AI coding agents from your phone.

## Purpose

`styrby-cli` is the bridge between your desktop AI coding agent and the Styrby mobile app. Install it on any machine running an AI agent, authenticate once, and your phone becomes a real-time remote control - read session output, send messages, approve tool calls, and monitor costs from anywhere.

**Who uses it:** Developers who run AI agents on a desktop or server and want mobile visibility without leaving their current environment.

## Key Features

- Connects 11 AI agents: Claude Code, Codex, Gemini CLI, OpenCode, Aider, Goose, Amp, Crush, Kilo, Kiro, Droid
- End-to-end encrypted message relay (TweetNaCl) - the server never sees plaintext
- QR-code pairing - one scan to link CLI to mobile app
- Real-time streaming of agent output to mobile via WebSocket relay
- Offline command queue - commands sent from mobile are delivered when reconnected
- Cost tracking per session, per token, per model
- Daemon mode for persistent background operation (`styrby daemon`)
- Machine key management - register/deregister devices with public-key crypto

## Setup

### Prerequisites

- Node.js >= 20.0.0
- `pnpm` (monorepo package manager)
- An active Styrby account and subscription (see [styrbyapp.com/pricing](https://styrbyapp.com/pricing))

### Install (end users)

```bash
npm install -g styrby-cli
styrby onboard
```

### Install (monorepo development)

```bash
# From repo root
pnpm install
cd packages/styrby-cli
pnpm dev           # Run CLI in dev mode via tsx
pnpm build         # Compile to dist/
pnpm test          # Run Vitest test suite
pnpm typecheck     # TypeScript type-check only
```

### First run

```bash
styrby onboard     # Authenticate + pair with mobile app
styrby             # Start interactive agent session
styrby daemon      # Run as background daemon
```

## Commands

### Build scripts

| Script | Command | Purpose |
|--------|---------|---------|
| `dev` | `pnpm dev` | Run CLI with hot-reload via tsx |
| `build` | `pnpm build` | Compile TypeScript + bundle to `dist/` |
| `build:types` | `pnpm build:types` | Emit `.d.ts` declaration files only |
| `typecheck` | `pnpm typecheck` | Type-check without emitting |
| `test` | `pnpm test` | Run Vitest test suite |
| `audit` | `pnpm audit` | Check for high-severity npm vulnerabilities |

### CLI commands (runtime)

| Command | Purpose |
|---------|---------|
| `styrby` | Start interactive session (agent auto-detected) |
| `styrby onboard` | Authenticate and pair with mobile app |
| `styrby daemon` | Run in background daemon mode |
| `styrby stop` | Stop running daemon |
| `styrby doctor` | Diagnose connection and config issues |
| `styrby logs` | Tail daemon logs |
| `styrby cloud` | Manage cloud sync settings |
| `styrby checkpoint` | Save a named checkpoint in the current session |
| `styrby template` | Browse and apply prompt templates |
| `styrby upgrade` | Check for and apply CLI updates |
| `styrby export` | Export session history |
| `styrby install-agent` | Install a supported AI agent |

## Architecture

```
src/
├── agent/          # Agent abstraction layer - unified interface across all 11 agents
├── claude/         # Claude Code integration
├── codex/          # OpenAI Codex integration
├── gemini/         # Gemini CLI integration
├── opencode/       # OpenCode integration
├── aider/          # Aider integration
├── goose/          # Goose integration
├── amp/            # Amp integration
├── crush/          # Crush integration
├── kilo/           # Kilo integration
├── kiro/           # Kiro integration
├── droid/          # Droid integration
├── commands/       # CLI sub-command implementations
├── modules/        # Core modules: encryption, file watching, proxy, watcher
├── parsers/        # Agent output parsers (tool calls, cost lines, diff blocks)
├── session/        # Session lifecycle, storage, E2E encryption
├── ui/             # Ink-based terminal UI components
├── costs/          # Token cost tracking and aggregation
├── auth/           # Supabase auth flows
├── api/            # HTTP API client for Styrby backend
├── daemon/         # Background daemon process management
├── telemetry/      # Usage telemetry (opt-in)
├── utils/          # Shared utilities
├── configuration.ts # Config loading and validation
├── env.ts          # Environment variable validation
├── persistence.ts  # Local state persistence
└── projectPath.ts  # Project directory resolution
```

## Environment Variables

Environment variables are documented in `docs/infrastructure/environment-variables.md` (local-only planning doc, gitignored - not in the public repo). For development, copy `.env.example` from the repo root and fill in values.

| Variable | Required | Purpose |
|----------|----------|---------|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_ANON_KEY` | Yes | Supabase public anon key |
| `STYRBY_API_URL` | Yes | Relay server URL |
| `STYRBY_TOKEN` | Set at runtime | Machine auth token (written by `styrby onboard`) |

## Relationship to Other Packages

| Package | Relationship |
|---------|-------------|
| `@styrby/shared` | Runtime dependency - imports shared types, relay protocol, pricing, and error classifier |
| `styrby-web` | Companion web dashboard - shares the same Supabase project and relay |
| `styrby-mobile` | Primary consumer - CLI sends encrypted messages that the mobile app displays |

## Attribution

Portions of `src/agent/`, `src/claude/`, `src/codex/`, and `src/gemini/` are derived from [Happy Coder](https://github.com/slopus/happy) (MIT License). The required copyright notice is preserved in `packages/styrby-cli/LICENSE`. Styrby as a whole is proprietary software owned by Steel Motion LLC.

## Contributing

Styrby is proprietary software. Contributions are by invitation only.

If you are an invited contributor:

1. **Tests first.** No production code without a failing test that the code fixes.
2. **JSDoc every function.** Undocumented code is incomplete code - see the JSDoc standard in CLAUDE.md (available via repo onboarding docs or your team lead).
3. **400-line file limit.** If a file exceeds 400 lines, split it before opening a PR.
4. **No monoliths.** Pages are orchestrators only. UI sections belong in `src/ui/` components.
5. **Fix errors immediately.** TypeScript errors, lint warnings, and test failures are not "for later."
6. **Feature branches only.** No direct commits to `main`. Open a PR and wait for CI.

Report security issues to security@steelmotionllc.com - see `SECURITY.md`.
