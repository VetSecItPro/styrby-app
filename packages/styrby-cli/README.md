# Styrby

**Mobile remote control for AI coding agents.**

Control Claude Code, Codex, Gemini CLI, OpenCode, and Aider from your phone.

## Install

```bash
npm install -g styrby
```

## Quick Start

```bash
# First-time setup (auth + mobile pairing)
styrby onboard

# Start a coding session
styrby start --agent claude
```

## Supported Agents

| Agent | Provider | Install |
|-------|----------|---------|
| Claude Code | Anthropic | `styrby install claude` |
| Codex | OpenAI | `styrby install codex` |
| Gemini CLI | Google | `styrby install gemini` |
| OpenCode | Open Source | `styrby install opencode` |
| Aider | Open Source | `styrby install aider` |

## Commands

```
styrby                  Interactive mode
styrby onboard          Setup wizard (~60 seconds)
styrby start            Start an agent session
styrby install <agent>  Install an AI agent
styrby pair             Pair with mobile app
styrby costs            Show token usage & costs
styrby doctor           Health checks
styrby help             Show help
```

## How It Works

Styrby is a **relay layer** - it doesn't do AI coding itself. Instead:

1. You spawn an agent (Claude Code, Codex, etc.)
2. Styrby captures stdin/stdout
3. Your phone connects via Supabase Realtime
4. You type on your phone → agent runs on your machine

```
Phone (Styrby App)
      │
      │ Supabase Realtime
      ▼
Styrby CLI (this package)
      │
      │ stdin/stdout
      ▼
AI Coding Agent (Claude/Codex/Gemini/OpenCode/Aider)
```

## Requirements

- Node.js 20+
- One of the supported AI agents
- Styrby mobile app (iOS/Android)

## Links

- **Website:** https://styrbyapp.com
- **Docs:** https://styrbyapp.com/docs
- **Issues:** https://github.com/VetSecItPro/styrby-app/issues

## License

Proprietary - All Rights Reserved. See [LICENSE](./LICENSE) for details.

© 2024 Steel Motion LLC
