/**
 * Article: Styrby vs. Dispatch: Remote Agent Control Compared
 * Category: comparison
 */
export default function StyrbyVsDispatch() {
  return (
    <>
      <p>
        Dispatch is Anthropic&apos;s approach to remote agent control, designed
        to let developers manage Claude Code sessions from anywhere. Styrby
        solves a similar problem but for a broader set of agents. This article
        breaks down the architectural differences, security models, and
        practical tradeoffs so you can decide which fits your workflow.
      </p>

      <h2>Architecture: Platform Feature vs. Independent Layer</h2>
      <p>
        Dispatch is built into the Claude ecosystem. It uses Anthropic&apos;s
        infrastructure for session routing, authentication, and state
        management. This gives it tight integration with Claude Code&apos;s
        internals, including native access to the permission system, session
        context, and tool execution pipeline.
      </p>
      <p>
        Styrby operates as an independent layer. The CLI connects to agents via
        their public interfaces and relays session data through Styrby&apos;s
        infrastructure. This means Styrby cannot reach as deep into any single
        agent as Dispatch can with Claude, but it can connect to agents that
        Dispatch does not support.
      </p>

      <h2>Agent Coverage</h2>
      <p>
        Dispatch works with Claude Code. That is its scope, and it does that
        well.
      </p>
      <p>
        Styrby connects to eleven agents: Claude Code, Codex, Gemini CLI,
        OpenCode, Aider, Goose, Amp, Crush, Kilo, Kiro, and Droid. If you
        standardize on Claude Code exclusively, this difference does not matter.
        If your team uses multiple agents, or if you switch agents based on the
        task, Styrby&apos;s multi-agent support becomes meaningful.
      </p>

      <h2>Encryption Models</h2>
      <p>
        Dispatch relies on Anthropic&apos;s security infrastructure. Your
        session data is encrypted in transit (TLS) and at rest on
        Anthropic&apos;s servers. Anthropic can access the data if needed for
        support or compliance.
      </p>
      <p>
        Styrby uses client-side TweetNaCl box encryption. Session messages are
        encrypted on your machine before they leave. The Styrby server stores
        only ciphertext. Even Styrby cannot read your session data.
      </p>
      <p>
        The tradeoff is real. Anthropic&apos;s model enables features like
        server-side search across sessions and easier account recovery.
        Styrby&apos;s model provides stronger privacy guarantees but means that
        if you lose your device keys, your encrypted session history is
        unrecoverable.
      </p>

      <h2>Permission Handling</h2>
      <p>
        Dispatch inherits Claude Code&apos;s permission system natively. It has
        full visibility into what tools Claude is requesting and can enforce
        permissions with the same granularity as the local CLI. This is a
        genuine advantage of being a first-party tool.
      </p>
      <p>
        Styrby intercepts permission requests at the CLI output level. It
        parses agent output to detect permission prompts and routes them to
        your mobile device. This works across all eleven agents but depends on
        parsing each agent&apos;s output format. When an agent changes its
        output format, Styrby&apos;s parsers need updating.
      </p>

      <h2>Cost Tracking</h2>
      <p>
        Dispatch does not include cost tracking or budget alerts. You track
        Claude costs through Anthropic&apos;s billing dashboard.
      </p>
      <p>
        Styrby tracks token costs across all connected agents, updated on each
        page load. You can set budget alerts with graduated actions: notification
        at 80% of budget, slowdown at 90%, hard stop at 100%. For teams, costs
        are attributed per developer. Session tags let you label work by client
        or project for filtering.
      </p>

      <h2>Where Dispatch Wins</h2>
      <ul>
        <li>
          <strong>Deeper integration.</strong> Native access to Claude
          Code&apos;s internals means Dispatch can do things Styrby cannot,
          like manipulating the tool execution pipeline directly.
        </li>
        <li>
          <strong>No additional cost.</strong> Dispatch is included with Claude
          Code.
        </li>
        <li>
          <strong>Simpler setup.</strong> No separate CLI install, no account
          creation, no key management.
        </li>
      </ul>

      <h2>Where Styrby Wins</h2>
      <ul>
        <li>
          <strong>Multi-agent support.</strong> Eleven agents in one dashboard vs.
          Claude only.
        </li>
        <li>
          <strong>Cost management.</strong> Per-agent and per-session tracking,
          budget alerts, session tags for client attribution.
        </li>
        <li>
          <strong>Stronger encryption.</strong> Zero-knowledge E2E encryption
          vs. provider-managed encryption.
        </li>
        <li>
          <strong>Vendor independence.</strong> Not locked into one AI
          provider&apos;s ecosystem.
        </li>
      </ul>

      <h2>The Broader Remote Control Landscape</h2>
      <p>
        Dispatch and Styrby are not the only approaches to remote agent control.
        The space is evolving quickly.
      </p>
      <ul>
        <li>
          <strong>Codex.</strong> OpenAI runs Codex in a cloud sandbox, so
          remote access goes through the OpenAI dashboard. No mobile-native
          interface.
        </li>
        <li>
          <strong>Gemini CLI and OpenCode.</strong> Neither offers built-in
          remote access. If you step away from the terminal, the agent waits.
        </li>
        <li>
          <strong>Aider.</strong> Terminal-only. No remote monitoring. The git
          commit trail serves as an after-the-fact audit, but you cannot approve
          or deny actions remotely.
        </li>
        <li>
          <strong>SSH/tmux workarounds.</strong> Some developers SSH into their
          workstation or use tmux to attach to agent sessions from a phone.
          This works but provides no cost tracking, no push notifications, and
          no permission classification.
        </li>
      </ul>
      <p>
        The pattern is clear: each vendor is building remote access for its own
        agent. Nobody except Styrby is building cross-agent remote access.
        Whether that matters depends entirely on how many agents you use.
      </p>

      <h2>Making the Choice</h2>
      <p>
        If you use Claude Code exclusively and trust Anthropic with your
        session data, Dispatch is the simpler, cheaper option. If you use
        multiple agents, need cost controls, or require zero-knowledge
        encryption, Styrby addresses those requirements. The two are not
        mutually exclusive: you can use Dispatch for Claude-specific features
        and Styrby for cross-agent management.
      </p>
    </>
  );
}
