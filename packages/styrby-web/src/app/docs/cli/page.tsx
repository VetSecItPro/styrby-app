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

# Agent shorthand (equivalent)
styrby claude
styrby codex
styrby gemini
styrby opencode
styrby aider

# Bare command uses your default agent
styrby`}</code>
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
#   ✓ [PASS] Node.js version: 20.x.x (>= 18 required)
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
            <tr>
              <td className="py-2 pr-4 font-mono text-xs text-foreground/75">SUPABASE_ANON_KEY</td>
              <td className="py-2 pr-4 text-xs">(built-in)</td>
              <td className="py-2 text-xs">Override Supabase anon key (dev/self-hosted).</td>
            </tr>
          </tbody>
        </table>
      </div>
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
        Detected agents:
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-6 text-sm text-muted-foreground">
        <li><strong className="text-foreground/75">Claude Code</strong> (claude)</li>
        <li><strong className="text-foreground/75">Codex</strong> (codex)</li>
        <li><strong className="text-foreground/75">Gemini CLI</strong> (gemini)</li>
        <li><strong className="text-foreground/75">OpenCode</strong> (opencode)</li>
        <li><strong className="text-foreground/75">Aider</strong> (aider)</li>
        <li><strong className="text-foreground/75">Goose</strong> (goose)</li>
        <li><strong className="text-foreground/75">Amp</strong> (amp)</li>
        <li><strong className="text-foreground/75">Crush</strong> (crush)</li>
        <li><strong className="text-foreground/75">Kilo</strong> (kilo)</li>
        <li><strong className="text-foreground/75">Kiro</strong> (kiro)</li>
        <li><strong className="text-foreground/75">Droid</strong> (droid)</li>
      </ul>
      <p className="mt-2 text-sm text-muted-foreground/70">
        Use{" "}
        <code className="rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground/75">
          styrby doctor
        </code>{" "}
        to check which agents are installed and configured on your machine.
      </p>

      <PrevNext prev={prev} next={next} />
    </article>
  );
}
