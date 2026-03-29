import type { Metadata } from "next";
import { PrevNext } from "../prev-next";
import { getPrevNext } from "../nav";

export const metadata: Metadata = {
  title: "Agent Setup",
  description:
    "Install and connect all 11 supported AI coding agents to Styrby. Includes install commands, verification steps, and how auto-detection works.",
};

/**
 * Agent Setup documentation page.
 *
 * Covers all 11 supported CLI coding agents grouped by tier availability.
 * Each agent section includes install command, verify command, and detection notes.
 */
export default function AgentSetupPage() {
  const { prev, next } = getPrevNext("/docs/agents");

  return (
    <article>
      <h1 className="text-3xl font-bold tracking-tight text-zinc-50">
        Agent Setup
      </h1>
      <p className="mt-3 text-zinc-400">
        Styrby supports 11 CLI coding agents. Install any agent on your machine
        and Styrby auto-detects it the next time the CLI starts. No extra
        configuration is needed for detection to work. The agent just needs to
        be on your PATH.
      </p>
      <p className="mt-3 text-zinc-400">
        Free tier includes 3 agents (Claude Code, Codex, Gemini CLI). Pro tier
        adds 6 more (OpenCode, Aider, Goose, Amp, Crush, Kilo) for 9 total.
        Power tier adds the remaining 2 (Kiro, Droid) for all 11. Agents you
        do not have installed are simply skipped during detection.
      </p>

      {/* Free agents */}
      <h2 className="mt-10 text-xl font-semibold text-zinc-100">
        Free Tier Agents
      </h2>
      <p className="mt-3 text-zinc-400">
        These three agents are available on all tiers, including Free.
      </p>

      {/* Claude Code */}
      <h3 className="mt-8 text-lg font-medium text-zinc-200">Claude Code</h3>
      <p className="mt-2 text-sm text-zinc-400">
        Anthropic&apos;s official CLI coding agent with deep code understanding
        and agentic tool-use via the Model Context Protocol. Detected via the{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
          claude
        </code>{" "}
        binary.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-300 border border-zinc-800">
{`# Install
npm install -g @anthropic-ai/claude-code

# Verify
claude --version`}
      </pre>
      <p className="mt-2 text-sm text-zinc-500">
        Styrby detects Claude Code by checking for{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
          claude
        </code>{" "}
        in your PATH. Configure auto-approve rules under{" "}
        <strong className="text-zinc-400">Agents &gt; Claude Code &gt; Permissions</strong>{" "}
        in the dashboard.
      </p>

      {/* Codex */}
      <h3 className="mt-8 text-lg font-medium text-zinc-200">Codex</h3>
      <p className="mt-2 text-sm text-zinc-400">
        OpenAI&apos;s CLI coding agent for code generation and understanding,
        using GPT-4o and reasoning models. Detected via the{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
          codex
        </code>{" "}
        binary.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-300 border border-zinc-800">
{`# Install
npm install -g @openai/codex

# Verify
codex --version`}
      </pre>
      <p className="mt-2 text-sm text-zinc-500">
        Styrby tracks token usage by intercepting Codex session output. Set your{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
          OPENAI_API_KEY
        </code>{" "}
        environment variable before starting a session.
      </p>

      {/* Gemini CLI */}
      <h3 className="mt-8 text-lg font-medium text-zinc-200">Gemini CLI</h3>
      <p className="mt-2 text-sm text-zinc-400">
        Google&apos;s CLI for multimodal AI coding assistance using Gemini 2.0
        and 2.5 models. Detected via the{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
          gemini
        </code>{" "}
        binary.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-300 border border-zinc-800">
{`# Install
npm install -g @google/gemini-cli

# Verify
gemini --version`}
      </pre>
      <p className="mt-2 text-sm text-zinc-500">
        Requires a Google account and Gemini API key. Authenticate by running{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
          gemini auth
        </code>{" "}
        before your first session.
      </p>

      {/* Pro tier agents */}
      <h2 className="mt-12 text-xl font-semibold text-zinc-100">
        Pro Tier Agents
      </h2>
      <p className="mt-3 text-zinc-400">
        These six agents are available on the Pro tier and above. Pro and Power
        plans support all their included agents simultaneously with no session
        limits.
      </p>

      {/* OpenCode */}
      <h3 className="mt-8 text-lg font-medium text-zinc-200">OpenCode</h3>
      <p className="mt-2 text-sm text-zinc-400">
        A terminal-based AI coding assistant with multi-provider support, JSON
        output, and session persistence. Detected via the{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
          opencode
        </code>{" "}
        binary.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-300 border border-zinc-800">
{`# Install
npm install -g opencode-ai

# Verify
opencode --version`}
      </pre>
      <p className="mt-2 text-sm text-zinc-500">
        OpenCode supports multiple model providers. Styrby tracks whichever
        model is active in the running session. Check{" "}
        <strong className="text-zinc-400">opencode.ai</strong> for the latest
        install instructions.
      </p>

      {/* Aider */}
      <h3 className="mt-8 text-lg font-medium text-zinc-200">Aider</h3>
      <p className="mt-2 text-sm text-zinc-400">
        AI pair programming in your terminal that works with many LLM providers
        and integrates directly with Git. Detected via the{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
          aider
        </code>{" "}
        binary.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-300 border border-zinc-800">
{`# Install via pip (recommended)
pip install aider-chat

# Or via pipx (isolated environment)
pipx install aider-chat

# Verify
aider --version`}
      </pre>
      <p className="mt-2 text-sm text-zinc-500">
        Aider requires Python 3.9 or later. It supports Claude, GPT-4o, Gemini,
        and many other LLM backends. Set the appropriate API key environment
        variable for your chosen model provider.
      </p>

      {/* Goose */}
      <h3 className="mt-8 text-lg font-medium text-zinc-200">Goose</h3>
      <p className="mt-2 text-sm text-zinc-400">
        An open-source AI coding agent by Block (formerly Square) that uses the
        Model Context Protocol for extensible tool integrations. Detected via
        the{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
          goose
        </code>{" "}
        binary.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-300 border border-zinc-800">
{`# Install via Homebrew (macOS)
brew install block/tap/goose

# Or via pip
pip install goose-ai

# Verify
goose --version`}
      </pre>
      <p className="mt-2 text-sm text-zinc-500">
        Goose is Apache 2.0 licensed. Config lives at{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
          ~/.config/goose/config.yaml
        </code>
        . Check{" "}
        <strong className="text-zinc-400">github.com/block/goose</strong> for
        the latest install instructions.
      </p>

      {/* Amp */}
      <h3 className="mt-8 text-lg font-medium text-zinc-200">Amp</h3>
      <p className="mt-2 text-sm text-zinc-400">
        Sourcegraph&apos;s AI coding agent with a &quot;deep mode&quot; that
        parallelizes code analysis across multiple sub-agents for accurate edits
        on large codebases. Detected via the{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
          amp
        </code>{" "}
        binary.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-300 border border-zinc-800">
{`# Install via npm
npm install -g @sourcegraph/amp

# Verify
amp --version`}
      </pre>
      <p className="mt-2 text-sm text-zinc-500">
        Config lives at{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
          ~/.config/amp/config.json
        </code>
        . Check{" "}
        <strong className="text-zinc-400">ampcode.com</strong> for the latest
        install instructions and account setup.
      </p>

      {/* Crush */}
      <h3 className="mt-8 text-lg font-medium text-zinc-200">Crush</h3>
      <p className="mt-2 text-sm text-zinc-400">
        Charmbracelet&apos;s terminal-native AI coding agent with ACP-compatible
        communication and rich ANSI terminal output. Detected via the{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
          crush
        </code>{" "}
        binary.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-300 border border-zinc-800">
{`# Install via Homebrew (macOS/Linux)
brew install charmbracelet/tap/crush

# Verify
crush --version`}
      </pre>
      <p className="mt-2 text-sm text-zinc-500">
        Config lives at{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
          ~/.config/crush/config.yaml
        </code>
        . Check{" "}
        <strong className="text-zinc-400">github.com/charmbracelet/crush</strong>{" "}
        for the latest install instructions.
      </p>

      {/* Kilo */}
      <h3 className="mt-8 text-lg font-medium text-zinc-200">Kilo</h3>
      <p className="mt-2 text-sm text-zinc-400">
        A community-driven AI coding agent with support for 500+ models and a
        Memory Bank feature that persists structured project knowledge across
        sessions. Detected via the{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
          kilo
        </code>{" "}
        binary.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-300 border border-zinc-800">
{`# Install via npm
npm install -g kilo-code

# Verify
kilo --version`}
      </pre>
      <p className="mt-2 text-sm text-zinc-500">
        Config lives at{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
          ~/.config/kilo/config.json
        </code>
        . Kilo supports any OpenAI-compatible API endpoint as a backend. Check
        the agent&apos;s official site for the latest install instructions.
      </p>

      {/* Power-only agents */}
      <h2 className="mt-12 text-xl font-semibold text-zinc-100">
        Power Tier Agents
      </h2>
      <p className="mt-3 text-zinc-400">
        These two agents are exclusive to the Power tier. Power includes all 11
        agents.
      </p>

      {/* Kiro */}
      <h3 className="mt-8 text-lg font-medium text-zinc-200">Kiro</h3>
      <p className="mt-2 text-sm text-zinc-400">
        AWS&apos;s AI coding agent with per-prompt credit billing and deep
        integration with IAM, CodeWhisperer, and Amazon Q Developer. Detected
        via the{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
          kiro
        </code>{" "}
        binary.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-300 border border-zinc-800">
{`# Install via npm
npm install -g @aws/kiro

# Or download directly from kiro.dev
# Check the official site for platform-specific installers

# Verify
kiro --version`}
      </pre>
      <p className="mt-2 text-sm text-zinc-500">
        Kiro uses a credit-based billing model. Styrby converts credits to a USD
        equivalent (1 credit = $0.01) for unified cost tracking. Check{" "}
        <strong className="text-zinc-400">kiro.dev</strong> for the latest
        install instructions.
      </p>

      {/* Droid */}
      <h3 className="mt-8 text-lg font-medium text-zinc-200">Droid</h3>
      <p className="mt-2 text-sm text-zinc-400">
        A Bring Your Own Key (BYOK) AI coding agent that routes to multiple LLM
        backends through LiteLLM, so you can use Anthropic, OpenAI, Google,
        Mistral, or on-prem models with your own API keys. Detected via the{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
          droid
        </code>{" "}
        binary.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-300 border border-zinc-800">
{`# Install via npm
npm install -g @droid-ai/cli

# Verify
droid --version`}
      </pre>
      <p className="mt-2 text-sm text-zinc-500">
        Config lives at{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
          ~/.config/droid/config.yaml
        </code>
        . Styrby uses LiteLLM pricing tables to estimate costs when the backend
        does not report token usage directly. Check{" "}
        <strong className="text-zinc-400">droid-ai.dev</strong> for the latest
        install instructions.
      </p>

      {/* How detection works */}
      <h2 className="mt-12 text-xl font-semibold text-zinc-100">
        How Detection Works
      </h2>
      <p className="mt-3 text-zinc-400">
        When the Styrby CLI starts, it checks your PATH for each of the 11 agent
        binaries in order:
      </p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm text-left text-zinc-400">
          <thead className="text-xs uppercase text-zinc-500 border-b border-zinc-800">
            <tr>
              <th className="py-2 pr-4">Agent</th>
              <th className="py-2 pr-4">Binary</th>
              <th className="py-2">Config File</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            <tr>
              <td className="py-2 pr-4 text-zinc-300">Claude Code</td>
              <td className="py-2 pr-4 font-mono text-xs text-zinc-300">claude</td>
              <td className="py-2 font-mono text-xs text-zinc-500">~/.claude/</td>
            </tr>
            <tr>
              <td className="py-2 pr-4 text-zinc-300">Codex</td>
              <td className="py-2 pr-4 font-mono text-xs text-zinc-300">codex</td>
              <td className="py-2 font-mono text-xs text-zinc-500">~/.openai/</td>
            </tr>
            <tr>
              <td className="py-2 pr-4 text-zinc-300">Gemini CLI</td>
              <td className="py-2 pr-4 font-mono text-xs text-zinc-300">gemini</td>
              <td className="py-2 font-mono text-xs text-zinc-500">~/.config/gemini/</td>
            </tr>
            <tr>
              <td className="py-2 pr-4 text-zinc-300">OpenCode</td>
              <td className="py-2 pr-4 font-mono text-xs text-zinc-300">opencode</td>
              <td className="py-2 font-mono text-xs text-zinc-500">~/.config/opencode/</td>
            </tr>
            <tr>
              <td className="py-2 pr-4 text-zinc-300">Aider</td>
              <td className="py-2 pr-4 font-mono text-xs text-zinc-300">aider</td>
              <td className="py-2 font-mono text-xs text-zinc-500">~/.aider/</td>
            </tr>
            <tr>
              <td className="py-2 pr-4 text-zinc-300">Goose</td>
              <td className="py-2 pr-4 font-mono text-xs text-zinc-300">goose</td>
              <td className="py-2 font-mono text-xs text-zinc-500">~/.config/goose/config.yaml</td>
            </tr>
            <tr>
              <td className="py-2 pr-4 text-zinc-300">Amp</td>
              <td className="py-2 pr-4 font-mono text-xs text-zinc-300">amp</td>
              <td className="py-2 font-mono text-xs text-zinc-500">~/.config/amp/config.json</td>
            </tr>
            <tr>
              <td className="py-2 pr-4 text-zinc-300">Crush</td>
              <td className="py-2 pr-4 font-mono text-xs text-zinc-300">crush</td>
              <td className="py-2 font-mono text-xs text-zinc-500">~/.config/crush/config.yaml</td>
            </tr>
            <tr>
              <td className="py-2 pr-4 text-zinc-300">Kilo</td>
              <td className="py-2 pr-4 font-mono text-xs text-zinc-300">kilo</td>
              <td className="py-2 font-mono text-xs text-zinc-500">~/.config/kilo/config.json</td>
            </tr>
            <tr>
              <td className="py-2 pr-4 text-zinc-300">Kiro</td>
              <td className="py-2 pr-4 font-mono text-xs text-zinc-300">kiro</td>
              <td className="py-2 font-mono text-xs text-zinc-500">~/.config/kiro/config.json</td>
            </tr>
            <tr>
              <td className="py-2 pr-4 text-zinc-300">Droid</td>
              <td className="py-2 pr-4 font-mono text-xs text-zinc-300">droid</td>
              <td className="py-2 font-mono text-xs text-zinc-500">~/.config/droid/config.yaml</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-4 text-zinc-400">
        Detected agents appear in the{" "}
        <strong className="text-zinc-300">Agents</strong> section of your
        dashboard. Agents not found in PATH are shown as{" "}
        <span className="text-zinc-300">Not Installed</span> with a link to
        these docs.
      </p>
      <p className="mt-3 text-zinc-400">
        If an agent is installed but not detected, confirm its binary is on your
        PATH:
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-300 border border-zinc-800">
{`# Check PATH for a binary (replace 'claude' with your agent)
which claude

# If not found, confirm the install location and add it to PATH
export PATH="$HOME/.local/bin:$PATH"   # Example for pip installs`}
      </pre>

      <PrevNext prev={prev} next={next} />
    </article>
  );
}
