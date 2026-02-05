# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

**Please do NOT report security vulnerabilities through public GitHub issues.**

Instead, please report them via email to:

**security@steelmotionllc.com**

Please include:

1. **Description** of the vulnerability
2. **Steps to reproduce** (if applicable)
3. **Impact assessment** - what could an attacker do?
4. **Suggested fix** (if you have one)

### What to Expect

- **Acknowledgment** within 48 hours
- **Status update** within 7 days
- **Fix timeline** depends on severity:
  - Critical: 24-48 hours
  - High: 7 days
  - Medium: 30 days
  - Low: Next release

### Scope

This security policy applies to:

- The `styrby` npm package
- The Styrby CLI application
- Related backend services at styrbyapp.com

### Out of Scope

- Third-party AI agents (Claude Code, Codex, Gemini, etc.)
- Third-party dependencies (report to their maintainers)
- Social engineering attacks
- Physical attacks

## Security Practices

### What We Do

- **No secrets in code** - All credentials via environment variables
- **Input validation** - Using Zod for runtime type checking
- **Dependency auditing** - `npm audit` on every release
- **Minimal permissions** - CLI requests only what's needed
- **Secure storage** - Tokens stored in user's config directory with appropriate permissions
- **HTTPS only** - All network communication over TLS

### What We Don't Do

- Store your AI provider API keys (agents handle their own auth)
- Send your code to our servers (relay only, no storage)
- Run arbitrary code from the network
- Use `eval()` or dynamic code execution

## Acknowledgments

We appreciate security researchers who help keep Styrby safe.
Responsible disclosures may be acknowledged (with permission) in our release notes.

---

© 2024 Steel Motion LLC
