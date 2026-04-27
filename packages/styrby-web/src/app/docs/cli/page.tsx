import type { Metadata } from "next";
import { PrevNext } from "../prev-next";
import { getPrevNext } from "../nav";

export const metadata: Metadata = {
  title: "CLI Reference",
  description: "Styrby CLI commands, configuration, environment variables, and system requirements.",
};

/**
 * CLI Reference page. Covers all commands, config, and requirements.
 */
export default function CLIReferencePage() {
  const { prev, next } = getPrevNext("/docs/cli");

  return (
    <article>
      <h1 className="text-3xl font-bold tracking-tight text-foreground">
        CLI Reference
      </h1>
      <p className="mt-3 text-muted-foreground">
        The Styrby CLI runs on your development machine, detects active AI
        agents, and streams session data to the dashboard.
      </p>

      {/* Requirements */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="system-requirements">
        System Requirements
      </h2>
      <ul className="mt-3 list-disc space-y-1 pl-6 text-sm text-muted-foreground">
        <li>Node.js 20 or later</li>
        <li>macOS, Linux, or WSL2 on Windows</li>
        <li>Outbound HTTPS (port 443) to styrbyapp.com and supabase.co</li>
      </ul>

      {/* Installation */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="installation">
        Installation
      </h2>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-card p-4 text-sm font-mono text-foreground/75 ring-1 ring-border">
        <code>{`npm install -g styrby-cli

# Or with your preferred package manager
pnpm add -g styrby-cli
yarn global add styrby-cli`}</code>
      </pre>

      {/* Commands */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="commands">Commands</h2>

      {/* onboard */}
      <h3 className="mt-6 text-lg font-medium text-foreground/90 scroll-mt-20" id="styrby-onboard">
        <code className="rounded bg-secondary px-2 py-0.5 text-amber-500">styrby onboard</code>
      </h3>
      <p className="mt-2 text-sm text-muted-foreground">
        Interactive setup wizard. Handles GitHub OAuth authentication, machine
        registration, and mobile QR code pairing. Run this once on a new machine.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-card p-4 text-sm font-mono text-foreground/75 ring-1 ring-border">
        <code>{`styrby onboard
# --skip-pairing    Skip the mobile QR code step
# --force           Re-authenticate even if already logged in`}</code>
      </pre>

      {/* pair */}
      <h3 className="mt-8 text-lg font-medium text-foreground/90 scroll-mt-20" id="styrby-pair">
        <code className="rounded bg-secondary px-2 py-0.5 text-amber-500">styrby pair</code>
      </h3>
      <p className="mt-2 text-sm text-muted-foreground">
        Generates a new QR code for pairing a mobile device. Use this when you
        get a new phone or want to add another device after initial setup.
        Requires prior authentication via{" "}
        <code className="rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground/75">styrby onboard</code>.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-card p-4 text-sm font-mono text-foreground/75 ring-1 ring-border">
        <code>{`styrby pair
# Scan the QR code with the Styrby mobile app
# Waiting for mobile app to connect...`}</code>
      </pre>

      {/* start */}
      <h3 className="mt-8 text-lg font-medium text-foreground/90 scroll-mt-20" id="styrby-start">
        <code className="rounded bg-secondary px-2 py-0.5 text-amber-500">styrby start</code>
      </h3>
      <p className="mt-2 text-sm text-muted-foreground">
        Starts a session with a specific agent. Agent shorthands are also
        supported as a faster alternative.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-card p-4 text-sm font-mono text-foreground/75 ring-1 ring-border">
        <code>{`styrby start --agent claude
styrby start --agent codex

# All 11 agents have a shorthand. Each is equivalent to "styrby start --agent <name>":
styrby claude     styrby goose      styrby kilo
styrby codex      styrby amp        styrby kiro
styrby gemini     styrby crush      styrby droid
styrby opencode   styrby aider

# Bare command uses your default agent (configurable via ~/.styrby/config.json)
styrby

# Common flags
#   -a, --agent <name>     Agent to use (overrides shorthand and config)
#   -p, --project <path>   Project directory (default: cwd)`}</code>
      </pre>

      {/* status */}
      <h3 className="mt-8 text-lg font-medium text-foreground/90 scroll-mt-20" id="styrby-status">
        <code className="rounded bg-secondary px-2 py-0.5 text-amber-500">styrby status</code>
      </h3>
      <p className="mt-2 text-sm text-muted-foreground">
        Shows the current state of the CLI: pairing status, detected agents,
        active sessions, and connection health.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-card p-4 text-sm font-mono text-foreground/75 ring-1 ring-border">
        <code>{`styrby status
# Machine: paired (abc123)
# Agents:  2 active (claude, codex)
# Session: ses_8f3k2... (running, 4,218 tokens)
# Session: ses_9g4m1... (idle, 890 tokens)`}</code>
      </pre>

      {/* stop */}
      <h3 className="mt-8 text-lg font-medium text-foreground/90 scroll-mt-20" id="styrby-stop">
        <code className="rounded bg-secondary px-2 py-0.5 text-amber-500">styrby stop</code>
      </h3>
      <p className="mt-2 text-sm text-muted-foreground">
        Stops the running Styrby daemon process.
      </p>

      {/* doctor */}
      <h3 className="mt-8 text-lg font-medium text-foreground/90 scroll-mt-20" id="styrby-doctor">
        <code className="rounded bg-secondary px-2 py-0.5 text-amber-500">styrby doctor</code>
      </h3>
      <p className="mt-2 text-sm text-muted-foreground">
        Runs health checks: Node.js version, configuration file, authentication
        status, and installed agent detection. Use this to diagnose problems.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-card p-4 text-sm font-mono text-foreground/75 ring-1 ring-border">
        <code>{`styrby doctor
#   ✓ [PASS] Node.js version: 20.x.x (>= 20 required)
#   ✓ [PASS] Configuration: Config file loaded successfully
#   ✓ [PASS] Authentication: Authenticated
#   ✓ [PASS] AI Agents: 2 agent(s) found: Claude Code, Codex`}</code>
      </pre>

      {/* install */}
      <h3 className="mt-8 text-lg font-medium text-foreground/90 scroll-mt-20" id="styrby-install">
        <code className="rounded bg-secondary px-2 py-0.5 text-amber-500">styrby install</code>
      </h3>
      <p className="mt-2 text-sm text-muted-foreground">
        Installs an AI coding agent via npm. Supported agents: claude, codex,
        gemini, opencode.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-card p-4 text-sm font-mono text-foreground/75 ring-1 ring-border">
        <code>{`styrby install claude
styrby install codex
styrby install gemini
styrby install opencode
styrby install --all    # Install all agents`}</code>
      </pre>

      {/* costs */}
      <h3 className="mt-8 text-lg font-medium text-foreground/90 scroll-mt-20" id="styrby-costs">
        <code className="rounded bg-secondary px-2 py-0.5 text-amber-500">styrby costs</code>
      </h3>
      <p className="mt-2 text-sm text-muted-foreground">
        Displays token usage and cost data for recent sessions.
      </p>

      {/* logs */}
      <h3 className="mt-8 text-lg font-medium text-foreground/90 scroll-mt-20" id="styrby-logs">
        <code className="rounded bg-secondary px-2 py-0.5 text-amber-500">styrby logs</code>
      </h3>
      <p className="mt-2 text-sm text-muted-foreground">
        View daemon logs.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-card p-4 text-sm font-mono text-foreground/75 ring-1 ring-border">
        <code>{`styrby logs
styrby logs --follow    # Stream logs in real time`}</code>
      </pre>

      {/* upgrade */}
      <h3 className="mt-8 text-lg font-medium text-foreground/90 scroll-mt-20" id="styrby-upgrade">
        <code className="rounded bg-secondary px-2 py-0.5 text-amber-500">styrby upgrade</code>
      </h3>
      <p className="mt-2 text-sm text-muted-foreground">
        Checks for and installs CLI updates from npm.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-card p-4 text-sm font-mono text-foreground/75 ring-1 ring-border">
        <code>{`styrby upgrade           # Check and install update
styrby upgrade --check   # Check only, do not install`}</code>
      </pre>

      {/* daemon */}
      <h3 className="mt-8 text-lg font-medium text-foreground/90 scroll-mt-20" id="styrby-daemon">
        <code className="rounded bg-secondary px-2 py-0.5 text-amber-500">styrby daemon</code>
      </h3>
      <p className="mt-2 text-sm text-muted-foreground">
        Manages CLI auto-start on boot. On macOS uses a LaunchAgent plist; on
        Linux uses a systemd user service.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-card p-4 text-sm font-mono text-foreground/75 ring-1 ring-border">
        <code>{`styrby daemon install    # Set up auto-start on login
styrby daemon uninstall  # Remove auto-start
styrby daemon status     # Check auto-start status`}</code>
      </pre>

      {/* template */}
      <h3 className="mt-8 text-lg font-medium text-foreground/90 scroll-mt-20" id="styrby-template">
        <code className="rounded bg-secondary px-2 py-0.5 text-amber-500">styrby template</code>
      </h3>
      <p className="mt-2 text-sm text-muted-foreground">
        Manage reusable prompt templates.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-card p-4 text-sm font-mono text-foreground/75 ring-1 ring-border">
        <code>{`styrby template list                   # List all your templates
styrby template create <name>          # Create interactively
styrby template show <name>            # Show template content
styrby template use <name>             # Render with variable substitution
styrby template delete <name>          # Delete (with confirmation)`}</code>
      </pre>

      {/* resume */}
      <h3 className="mt-8 text-lg font-medium text-foreground/90 scroll-mt-20" id="styrby-resume">
        <code className="rounded bg-secondary px-2 py-0.5 text-amber-500">styrby resume</code>
      </h3>
      <p className="mt-2 text-sm text-muted-foreground">
        Re-attach the relay to an existing session without spawning a new agent
        process. Useful after a network blip or daemon restart.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-card p-4 text-sm font-mono text-foreground/75 ring-1 ring-border">
        <code>{`styrby resume                          # Re-attach to most recent live session
styrby resume <sessionId>              # Re-attach to a specific session`}</code>
      </pre>

      {/* auth */}
      <h3 className="mt-8 text-lg font-medium text-foreground/90 scroll-mt-20" id="styrby-auth">
        <code className="rounded bg-secondary px-2 py-0.5 text-amber-500">styrby auth</code>
      </h3>
      <p className="mt-2 text-sm text-muted-foreground">
        Re-authenticate with GitHub without re-running the rest of the
        onboarding wizard. Use{" "}
        <code className="rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground/75">
          --force
        </code>{" "}
        to invalidate the existing token first.
      </p>

      {/* checkpoint */}
      <h3 className="mt-8 text-lg font-medium text-foreground/90 scroll-mt-20" id="styrby-checkpoint">
        <code className="rounded bg-secondary px-2 py-0.5 text-amber-500">styrby checkpoint</code>
      </h3>
      <p className="mt-2 text-sm text-muted-foreground">
        Save and restore named positions inside a session timeline. Aliased as{" "}
        <code className="rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground/75">
          styrby cp
        </code>.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-card p-4 text-sm font-mono text-foreground/75 ring-1 ring-border">
        <code>{`styrby checkpoint save <name>          # Save current position as named checkpoint
styrby checkpoint list                 # List checkpoints for current session
styrby checkpoint restore <name>       # Show restore info for a checkpoint
styrby checkpoint delete <name>        # Delete a checkpoint (--force to skip prompt)`}</code>
      </pre>

      {/* export / import */}
      <h3 className="mt-8 text-lg font-medium text-foreground/90 scroll-mt-20" id="styrby-export">
        <code className="rounded bg-secondary px-2 py-0.5 text-amber-500">styrby export</code> /{" "}
        <code className="rounded bg-secondary px-2 py-0.5 text-amber-500">styrby import</code>
      </h3>
      <p className="mt-2 text-sm text-muted-foreground">
        Move sessions between machines or archive them as JSON files.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-card p-4 text-sm font-mono text-foreground/75 ring-1 ring-border">
        <code>{`styrby export <sessionId>              # Print JSON to stdout
styrby export <sessionId> --output session.json
styrby export --all --output ./backup  # Export every session to a directory
styrby import session.json             # Import a single session JSON`}</code>
      </pre>

      {/* privacy */}
      <h3 className="mt-8 text-lg font-medium text-foreground/90 scroll-mt-20" id="styrby-privacy">
        <code className="rounded bg-secondary px-2 py-0.5 text-amber-500">styrby privacy</code>
      </h3>
      <p className="mt-2 text-sm text-muted-foreground">
        GDPR data subject rights from the terminal. Subject access (Art. 15 / 20)
        exports every row tied to your account. Erasure (Art. 17) hard-deletes
        the account behind a two-step confirmation.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-card p-4 text-sm font-mono text-foreground/75 ring-1 ring-border">
        <code>{`styrby privacy export                  # Subject access request (SAR)
styrby privacy delete                  # Erase account (irreversible)
styrby export-data                     # Alias for "privacy export"
styrby delete-account                  # Alias for "privacy delete"`}</code>
      </pre>

      {/* mcp */}
      <h3 className="mt-8 text-lg font-medium text-foreground/90 scroll-mt-20" id="styrby-mcp">
        <code className="rounded bg-secondary px-2 py-0.5 text-amber-500">styrby mcp</code>
      </h3>
      <p className="mt-2 text-sm text-muted-foreground">
        Run the Styrby Model Context Protocol server so any MCP-aware agent
        (Claude Code, Goose, custom clients) can call into your active sessions.
      </p>

      {/* context */}
      <h3 className="mt-8 text-lg font-medium text-foreground/90 scroll-mt-20" id="styrby-context">
        <code className="rounded bg-secondary px-2 py-0.5 text-amber-500">styrby context</code>
      </h3>
      <p className="mt-2 text-sm text-muted-foreground">
        Inspect, sync, and copy the cross-agent context memory shared inside a
        session group. Useful when handing off work from one agent to another.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-card p-4 text-sm font-mono text-foreground/75 ring-1 ring-border">
        <code>{`styrby context show   --group <groupId>
styrby context sync   --group <groupId>
styrby context export --session <sessionId>
styrby context import --session <target> --from <source>`}</code>
      </pre>

      {/* Environment Variables */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="environment-variables">
        Environment Variables
      </h2>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="pb-2 pr-4 font-medium text-foreground/75">Variable</th>
              <th className="pb-2 pr-4 font-medium text-foreground/75">Default</th>
              <th className="pb-2 font-medium text-foreground/75">Description</th>
            </tr>
          </thead>
          <tbody className="text-muted-foreground">
            <tr className="border-b border-border/50">
              <td className="py-2 pr-4 font-mono text-xs text-foreground/75">STYRBY_API_URL</td>
              <td className="py-2 pr-4 text-xs">https://api.styrbyapp.com</td>
              <td className="py-2 text-xs">API base URL. Override for staging.</td>
            </tr>
            <tr className="border-b border-border/50">
              <td className="py-2 pr-4 font-mono text-xs text-foreground/75">STYRBY_LOG_LEVEL</td>
              <td className="py-2 pr-4 text-xs">info</td>
              <td className="py-2 text-xs">Logging verbosity: debug, info, warn, error.</td>
            </tr>
            <tr className="border-b border-border/50">
              <td className="py-2 pr-4 font-mono text-xs text-foreground/75">STYRBY_ENV</td>
              <td className="py-2 pr-4 text-xs">production</td>
              <td className="py-2 text-xs">Set to development to use local Supabase.</td>
            </tr>
            <tr className="border-b border-border/50">
              <td className="py-2 pr-4 font-mono text-xs text-foreground/75">SUPABASE_URL</td>
              <td className="py-2 pr-4 text-xs">(built-in)</td>
              <td className="py-2 text-xs">Override Supabase project URL (dev/self-hosted).</td>
            </tr>
            <tr className="border-b border-border/50">
              <td className="py-2 pr-4 font-mono text-xs text-foreground/75">SUPABASE_ANON_KEY</td>
              <td className="py-2 pr-4 text-xs">(built-in)</td>
              <td className="py-2 text-xs">Override Supabase anon key (dev/self-hosted).</td>
            </tr>
            <tr className="border-b border-border/50">
              <td className="py-2 pr-4 font-mono text-xs text-foreground/75">ANTHROPIC_API_KEY</td>
              <td className="py-2 pr-4 text-xs">(none)</td>
              <td className="py-2 text-xs">Required by Claude Code.</td>
            </tr>
            <tr className="border-b border-border/50">
              <td className="py-2 pr-4 font-mono text-xs text-foreground/75">OPENAI_API_KEY</td>
              <td className="py-2 pr-4 text-xs">(none)</td>
              <td className="py-2 text-xs">Required by Codex; optional for OpenCode.</td>
            </tr>
            <tr>
              <td className="py-2 pr-4 font-mono text-xs text-foreground/75">GEMINI_API_KEY / GOOGLE_API_KEY</td>
              <td className="py-2 pr-4 text-xs">(none)</td>
              <td className="py-2 text-xs">Required by Gemini CLI. Either name is accepted.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-sm text-muted-foreground/70">
        Provider keys are read directly by each agent process at session start.
        Styrby never reads or transmits them. See the{" "}
        <a href="/docs/agents" className="text-amber-500 underline underline-offset-2 hover:text-amber-400">
          Agent Setup
        </a>{" "}
        page for per-agent authentication details.
      </p>
      <p className="mt-3 text-sm text-muted-foreground/70">
        Config is stored in{" "}
        <code className="rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground/75">
          ~/.styrby/config.json
        </code>
        . The Supabase URL and anon key are embedded in the CLI binary and
        require no setup for the default (hosted) Styrby service.
      </p>

      {/* Agent Detection */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="agent-detection">
        Agent Detection
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        The CLI monitors the local process list for known agent binaries. When
        it detects one, it hooks into the agent&apos;s stdio streams to capture
        session data. No agent modification required.
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        Eleven agent binaries are recognised:{" "}
        <code className="rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground/75">claude</code>,{" "}
        <code className="rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground/75">codex</code>,{" "}
        <code className="rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground/75">gemini</code>,{" "}
        <code className="rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground/75">opencode</code>,{" "}
        <code className="rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground/75">aider</code>,{" "}
        <code className="rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground/75">goose</code>,{" "}
        <code className="rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground/75">amp</code>,{" "}
        <code className="rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground/75">crush</code>,{" "}
        <code className="rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground/75">kilo</code>,{" "}
        <code className="rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground/75">kiro</code>,{" "}
        <code className="rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground/75">droid</code>.
        See the{" "}
        <a href="/docs/agents" className="text-amber-500 underline underline-offset-2 hover:text-amber-400">
          Agent Setup
        </a>{" "}
        page for install commands and per-agent config paths. Run{" "}
        <code className="rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground/75">
          styrby doctor
        </code>{" "}
        to see which are installed on this machine.
      </p>

      <PrevNext prev={prev} next={next} />
    </article>
  );
}
