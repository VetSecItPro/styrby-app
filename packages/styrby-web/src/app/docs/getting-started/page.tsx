import type { Metadata } from "next";
import { PrevNext } from "../prev-next";
import { getPrevNext } from "../nav";

export const metadata: Metadata = {
  title: "Getting Started",
  description: "Install the Styrby CLI, pair your machine, and monitor your first AI agent session.",
};

/**
 * Getting Started guide. Walks through install, pairing, and first session.
 */
export default function GettingStartedPage() {
  const { prev, next } = getPrevNext("/docs/getting-started");

  return (
    <article>
      <h1 className="text-3xl font-bold tracking-tight text-zinc-50">
        Getting Started
      </h1>
      <p className="mt-3 text-zinc-400">
        From zero to monitoring your first AI agent session in under five minutes.
      </p>

      {/* Step 1 */}
      <h2 className="mt-10 text-xl font-semibold text-zinc-100">
        1. Install the CLI
      </h2>
      <p className="mt-2 text-sm text-zinc-400">
        Requires Node.js 20 or later.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm font-mono text-zinc-300 ring-1 ring-zinc-800">
        <code>npm install -g styrby-cli</code>
      </pre>
      <p className="mt-2 text-sm text-zinc-500">
        Verify the install:
      </p>
      <pre className="mt-2 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm font-mono text-zinc-300 ring-1 ring-zinc-800">
        <code>styrby --version</code>
      </pre>

      {/* Step 2 */}
      <h2 className="mt-10 text-xl font-semibold text-zinc-100">
        2. Create an account
      </h2>
      <p className="mt-2 text-sm text-zinc-400">
        Sign up at{" "}
        <a
          href="https://styrbyapp.com/signup"
          className="text-amber-500 underline underline-offset-2 hover:text-amber-400"
        >
          styrbyapp.com
        </a>
        . Free tier includes one machine and full session monitoring.
      </p>

      {/* Step 3 */}
      <h2 className="mt-10 text-xl font-semibold text-zinc-100">
        3. Run the setup wizard
      </h2>
      <p className="mt-2 text-sm text-zinc-400">
        Run the onboard command. It handles GitHub authentication, machine
        registration, and mobile pairing in one flow.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm font-mono text-zinc-300 ring-1 ring-zinc-800">
        <code>styrby onboard</code>
      </pre>
      <p className="mt-2 text-sm text-zinc-400">
        The wizard opens your browser for GitHub OAuth, registers your machine,
        then displays a QR code. Open Styrby on your phone and tap{" "}
        <strong className="text-zinc-300">Add Machine</strong> to scan it.
      </p>
      <p className="mt-3 text-sm text-zinc-500">
        Pairing generates a TweetNaCl keypair on your machine. The public key is
        sent to Styrby; the private key never leaves your device. All session
        data is end-to-end encrypted from this point.
      </p>
      <p className="mt-2 text-sm text-zinc-500">
        To re-pair later (new phone, lost device), run{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs">styrby pair</code>.
      </p>

      {/* Step 4 */}
      <h2 className="mt-10 text-xl font-semibold text-zinc-100">
        4. Start an AI agent
      </h2>
      <p className="mt-2 text-sm text-zinc-400">
        Launch any supported agent. The CLI auto-detects the agent process and
        begins streaming session data.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm font-mono text-zinc-300 ring-1 ring-zinc-800">
        <code>{`# Use agent shorthand to start a session:
styrby claude     # or: styrby codex, styrby gemini, styrby opencode, styrby aider

# Or let Styrby use your default agent:
styrby`}</code>
      </pre>
      <p className="mt-2 text-sm text-zinc-400">
        Within seconds, the session appears in your dashboard and mobile app.
        You can see token usage, approve permission requests, and review the
        conversation in real time.
      </p>

      {/* Step 5 */}
      <h2 className="mt-10 text-xl font-semibold text-zinc-100">
        5. Verify everything works
      </h2>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm font-mono text-zinc-300 ring-1 ring-zinc-800">
        <code>{`styrby status
# Output:
# Machine: paired (abc123)
# Agents:  1 active (claude)
# Session: ses_8f3k2... (running, 142 tokens)`}</code>
      </pre>

      <PrevNext prev={prev} next={next} />
    </article>
  );
}
