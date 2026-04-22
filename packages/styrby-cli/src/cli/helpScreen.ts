/**
 * Help-screen rendering for the Styrby CLI.
 *
 * WHY extracted: `printHelp()` is ~160 lines of static formatting that
 * bloated `index.ts`. Isolating it here lets us unit-test the formatter
 * (e.g. "contains `styrby onboard`", "contains the current VERSION")
 * without spinning up the whole CLI dispatcher.
 *
 * @module cli/helpScreen
 */

import { VERSION } from '@/cli/version';

/**
 * Build the `styrby help` / `styrby --help` text as a single string.
 *
 * WHY a builder (not direct `console.log`): pure string output is trivial
 * to test and stays byte-for-byte identical to the pre-refactor output
 * that was in `index.ts`.
 *
 * @returns Formatted multi-line help text (including leading + trailing newlines).
 */
export function buildHelpText(): string {
  return `
styrby v${VERSION}

Usage: styrby [command] [options]

Mobile relay for AI coding agents. Control Claude Code, Codex, Gemini CLI,
OpenCode, and Aider from your phone. Code stays local — only I/O is relayed.

  styrby                    Start a coding session (auto-setup on first run)

Commands:

  Setup
    onboard                 Re-run setup wizard (auth + machine registration + pairing)
    auth                    Re-authenticate only
    pair                    Generate QR code for mobile app pairing
    install <agent>         Install an AI agent (claude, codex, gemini, opencode, aider)

  Session
    start                   Start a coding session (same as bare styrby)
    resume [sessionId]      Re-attach relay to an existing session (no new agent)
    stop                    Stop running daemon
    status                  Show connection and session status
    logs                    View daemon logs (--follow, --lines N)
    costs                   Display token usage and cost breakdown

  Templates
    template list           List all your context templates
    template create <name>  Create a new template interactively
    template show <name>    Display template details and content
    template use <name>     Render template with variable substitution
    template delete <name>  Delete a template (with confirmation)

  Session Export / Import
    export <sessionId>      Export a session as JSON (stdout or --output file)
    export --all            Export all sessions (use --output <dir> for files)
    import <file>           Import a session from a JSON export file

  Privacy / GDPR
    privacy export          Export ALL your data (GDPR Art. 15/20 SAR)
    privacy delete          Delete your account (GDPR Art. 17, 2-step confirm)
    export-data             Alias for "privacy export"
    delete-account          Alias for "privacy delete"

  Checkpoints
    checkpoint save <name>  Save current session position as a named checkpoint
    checkpoint list         List all checkpoints for the current session
    checkpoint restore <n>  Show restore info for a checkpoint
    checkpoint delete <n>   Delete a checkpoint (--force to skip confirmation)

  Daemon
    daemon install          Install daemon to start automatically on boot
    daemon uninstall        Remove daemon from auto-start
    daemon status           Check if daemon auto-start is configured

  Maintenance
    upgrade                 Check for and install updates
    doctor                  Run system health checks
    help                    Show this help message
    version                 Show version number

Options:

  -a, --agent <name>        Agent to use: claude (default), codex, gemini, opencode, aider
  -p, --project <path>      Project directory (default: cwd)
  -f, --force               Force re-authentication
  --skip-pairing            Skip QR code step during onboard
  --skip-doctor             Skip health checks during onboard
  -t, --today               Filter costs to today
  -m, --month               Filter costs to current month
  --follow, -f              Follow daemon logs in real-time
  --lines N, -n N           Show last N lines of logs (default: 50)
  --check, -c               Check for updates without installing
  -h, --help                Show help
  -v, --version             Show version

Environment Variables:

  STYRBY_LOG_LEVEL          Set to "debug" for verbose output
  ANTHROPIC_API_KEY         Required for Claude Code
  OPENAI_API_KEY            Required for Codex, optional for OpenCode
  GEMINI_API_KEY            Required for Gemini CLI
  GOOGLE_API_KEY            Alternative for Gemini CLI

Configuration:

  ~/.styrby/config.json     User configuration
  ~/.styrby/credentials     Authentication tokens (chmod 600)
  ~/.styrby/daemon.pid      Daemon process ID
  ~/.styrby/daemon.log      Daemon output log
  ~/.claude/projects/       Claude Code session data (used by 'costs' command)

Exit Codes:

  0    Success
  1    General error / command failed
  2    Invalid arguments or usage
  126  Permission denied
  127  Command not found (agent not installed)
  130  Interrupted (Ctrl+C)

Examples:

  Getting Started
    styrby onboard                      Complete setup (~60 seconds)
    styrby install claude               Install Claude Code agent
    styrby install opencode             Install OpenCode agent
    styrby doctor                       Verify everything is configured

  Starting Sessions
    styrby start                        Start with Claude (default agent)
    styrby start -a codex               Start with Codex
    styrby start -a gemini              Start with Gemini CLI
    styrby start -a opencode            Start with OpenCode
    styrby start -a aider               Start with Aider
    styrby start -p ~/work/myproject    Start in specific directory
    styrby start -a codex -p ./backend  Combine agent + project path

  Session Management
    styrby stop                         Stop running daemon
    styrby status                       Check connection and session state
    styrby resume                       Re-attach relay to the most recent live session
    styrby resume <sessionId>           Re-attach relay to a specific session
    styrby logs                         View daemon logs (last 50 lines)
    styrby logs -f                      Follow logs in real-time
    styrby logs -n 100                  View last 100 lines

  Daemon Auto-Start
    styrby daemon install               Set up daemon to start on login
    styrby daemon uninstall             Remove daemon from auto-start
    styrby daemon status                Check if auto-start is configured

  Maintenance
    styrby upgrade                      Update to latest version
    styrby upgrade --check              Check for updates without installing

  Cost Tracking
    styrby costs                        Show all-time usage and costs
    styrby costs --today                Show today's costs only
    styrby costs --month                Show current month's costs

  Diagnostics
    styrby doctor                       Run full health check
    STYRBY_LOG_LEVEL=debug styrby start Debug mode with verbose output

  Re-pairing & Re-auth
    styrby pair                         Generate new QR code (e.g., new phone)
    styrby auth --force                 Force re-authentication
    styrby onboard --force              Full re-setup

Troubleshooting:

  Error                           Fix
  ─────────────────────────────────────────────────────────────────────
  "Not authenticated"             styrby onboard (or styrby auth --force)
  "No daemon running"             styrby start --daemon
  "Agent not found"               styrby install <agent> && exec $SHELL
  "Claude: ANTHROPIC_API_KEY"     export ANTHROPIC_API_KEY=sk-ant-...
  "Codex: OPENAI_API_KEY"         export OPENAI_API_KEY=sk-...
  "Gemini: API key"               export GEMINI_API_KEY=... (or GOOGLE_API_KEY)
  "QR code expired"               styrby pair
  "Mobile not connecting"         Check same account on CLI and mobile app
  "Connection timeout"            Whitelist *.supabase.co in firewall/proxy
  "WebSocket blocked"             Some corporate networks block WSS; try hotspot
  "EACCES / permission denied"    mkdir -p ~/.styrby && chmod 700 ~/.styrby
  "Node.js version"               Requires Node.js 20+; check with: node -v
  "Agent crashes on start"        Check agent works standalone: claude --help

  For verbose output, prefix any command with: STYRBY_LOG_LEVEL=debug

Homepage:  https://styrbyapp.com
Source:    https://github.com/VetSecItPro/styrby-app
Issues:    https://github.com/VetSecItPro/styrby-app/issues
`;
}

/**
 * Print the help text to stdout.
 *
 * WHY separate from `buildHelpText`: tests exercise the pure builder,
 * while production code calls this side-effectful wrapper.
 */
export function printHelp(): void {
  console.log(buildHelpText());
}
