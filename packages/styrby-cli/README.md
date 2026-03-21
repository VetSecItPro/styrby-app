# Styrby

**One app to control all your AI coding agents from your phone.**

Control Claude Code, Codex, Gemini CLI, OpenCode, and Aider — all from a single mobile app. End-to-end encrypted. Your code never leaves your machine.

## Why Styrby?

- **Multi-agent** — 5 AI agents, one interface. No vendor lock-in.
- **E2E encrypted** — XSalsa20-Poly1305 encryption with per-session keys. We never see your code.
- **Offline resilient** — Commands queue when you're offline and sync automatically. Your laptop can sleep.
- **Cost tracking** — Real-time token usage, budget alerts, and cross-agent cost comparison.
- **Push notifications** — Know when sessions complete, permissions need approval, or budgets are hit.

## Install

```bash
npm install -g styrby
```

## Quick Start

```bash
# First-time setup (auth + mobile pairing, ~60 seconds)
styrby onboard

# Start a coding session with Claude Code
styrby start --agent claude

# Or use a different agent
styrby start --agent codex
styrby start --agent gemini
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
styrby pair             Pair with mobile app (QR code)
styrby costs            Show token usage & costs
styrby costs --today    Today's costs only
styrby costs --month    Current month's costs
styrby doctor           Run system health checks
styrby daemon install   Auto-start on boot
styrby template list    Manage prompt templates
styrby help             Show help
```

## How It Works

Styrby is a **relay layer** — it doesn't do AI coding itself. Instead:

1. You spawn an agent (Claude Code, Codex, etc.) on your machine
2. Styrby captures stdin/stdout and encrypts messages end-to-end
3. Your phone connects via Supabase Realtime
4. You type on your phone → agent executes on your machine
5. Results are encrypted before leaving your machine → decrypted only on your phone

```
Phone (Styrby App)
      │
      │ E2E Encrypted via Supabase Realtime
      ▼
Styrby CLI (this package)
      │
      │ stdin/stdout
      ▼
AI Coding Agent (Claude/Codex/Gemini/OpenCode/Aider)
```

## Security

- **End-to-end encryption** — TweetNaCl (XSalsa20-Poly1305) with HMAC-SHA512 key derivation
- **Per-session keys** — Each session generates unique keys bound to user + machine + session
- **Zero-knowledge relay** — Styrby servers forward ciphertext only, never plaintext
- **No third-party messaging** — Unlike solutions routing through Telegram or Discord, your data stays on your infrastructure

## Requirements

- Node.js 20+
- One of the supported AI agents installed
- Styrby mobile app (iOS/Android) or web dashboard

## Links

- **Website:** https://styrbyapp.com
- **Docs:** https://styrbyapp.com/docs
- **Security:** https://styrbyapp.com/security
- **Issues:** https://github.com/VetSecItPro/styrby-app/issues

## License

Proprietary - All Rights Reserved. See [LICENSE](./LICENSE) for details.

© 2026 Steel Motion LLC
