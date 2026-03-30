# Styrby

Control your AI coding agents from your phone.

Styrby connects Claude Code, Codex, Gemini CLI, and 8 more agents to a mobile app — so you can monitor sessions, approve permissions, track costs, and review diffs from anywhere.

**Live:** [https://styrbyapp.com](https://styrbyapp.com)

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| CLI | Node.js + TypeScript |
| Mobile | Expo SDK 54 + NativeWind + expo-router |
| Web dashboard | Next.js 15 + Tailwind CSS |
| Backend | Supabase (Postgres + Auth + Realtime + Edge Functions) |
| Payments | Polar (merchant of record) |
| Hosting | Vercel (web) + Supabase (backend) |

## Supported Agents

Claude Code, Codex, Gemini CLI, OpenCode, Aider, Goose, Amp, Crush, Kilo, Kiro, Droid

## Quick Start

```bash
# Install dependencies
pnpm install

# Copy environment variables
cp .env.example .env.local
# Fill in your Supabase URL, anon key, and Polar keys

# Start the web dashboard
pnpm --filter styrby-web dev

# Start the CLI (in a project directory)
pnpm --filter styrby-cli dev
```

## Monorepo Structure

```
styrby-app/
├── packages/
│   ├── styrby-cli/      # CLI — connects AI agents to your phone
│   ├── styrby-mobile/   # Expo React Native app
│   ├── styrby-web/      # Next.js dashboard
│   └── styrby-shared/   # Shared types and constants
├── supabase/
│   └── migrations/      # Database schema
└── .env.example         # Environment variable template
```

## Documentation

Full docs at [styrbyapp.com/docs](https://styrbyapp.com/docs)

- [Getting started / CLI setup](https://styrbyapp.com/docs/getting-started)
- [Supported agents](https://styrbyapp.com/docs/agents)
- [OpenTelemetry integration](https://styrbyapp.com/docs/opentelemetry)
- [Voice input](https://styrbyapp.com/docs/voice-input)

## License

Proprietary — All Rights Reserved. See [LICENSE](./LICENSE).

Built by [VetSecItPro](https://github.com/VetSecItPro).
