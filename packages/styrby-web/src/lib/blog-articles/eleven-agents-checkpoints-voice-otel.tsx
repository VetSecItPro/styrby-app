/**
 * Article: Styrby Now Supports 11 CLI Coding Agents with Session Checkpoints, Voice Commands, and Enterprise OTEL Export
 * Category: company
 */
export default function ElevenAgentsCheckpointsVoiceOtel() {
  return (
    <>
      <p>
        The CLI coding agent space has expanded faster than most developers can
        keep up with. In the last year, the number of serious contenders went
        from a handful to more than a dozen, each with a different backend,
        pricing model, and workflow. Developers running multiple projects now
        routinely juggle three, four, or five agents at the same time. The
        overhead of monitoring all of them from separate terminals, tracking
        costs across separate billing dashboards, and approving permissions
        mid-session has become its own kind of work.
      </p>
      <p>
        Styrby was built to remove that overhead. This post covers everything
        shipping in the current sprint: four new agent integrations bringing the
        total to 11, plus session checkpoints, session sharing, per-message cost
        tracking, voice commands, cloud task monitoring, mobile code review,
        activity graphs, OTEL metrics export, LiteLLM dynamic pricing, and a
        Rust-powered JSONL parser for large session files.
      </p>

      <h2>What Is New in This Sprint</h2>

      <h3>Four New Agents (11 Total)</h3>
      <p>
        Styrby now connects to Crush, Kilo, Kiro, and Droid in addition to the
        seven agents already supported: Claude Code, Codex, Gemini CLI, Aider,
        OpenCode, Goose, and Amp. Every agent appears in the same unified
        dashboard with real-time status, session cost, and permission requests
        routed to your phone.
      </p>

      <h3>Session Checkpoints</h3>
      <p>
        Long-running agent sessions can now be checkpointed at any point. A
        checkpoint captures the full session state so you can restore it later,
        branch from it to try a different approach, or hand it off to a
        colleague. Checkpoints are stored encrypted in the cloud and appear in
        your session history alongside normal session entries.
      </p>

      <h3>Session Sharing with E2E Encryption</h3>
      <p>
        Any session can now be shared via a link. The link includes a separate
        encryption key that is never stored on Styrby servers. The recipient
        decrypts the session locally in their browser. Revoke the link at any
        time from your dashboard and the session becomes unreadable to anyone
        who has not already loaded it.
      </p>

      <h3>Per-Message Cost Tracking</h3>
      <p>
        Every message in a session now shows the exact cost of that exchange:
        input tokens, output tokens, cache hits, and the dollar amount at the
        model&apos;s current rate. You can see at a glance which prompts are
        expensive and where context window bloat is driving up costs, without
        waiting for the end-of-session summary.
      </p>

      <h3>Voice-to-Agent Commands</h3>
      <p>
        You can now speak commands to any connected agent from the Styrby mobile
        app. The app transcribes your voice and sends the command to the agent
        via the CLI bridge. Useful for quick instructions when your hands are
        occupied or when you are away from your desk and want to redirect a
        running session without typing on a small screen.
      </p>

      <h3>Cloud Task Monitoring</h3>
      <p>
        Agents that support async task execution (long-running background jobs)
        now surface task status in Styrby. You receive a push notification when
        the task completes, when it needs input, or when it encounters an error.
        The task log is available in the mobile app without opening a terminal.
      </p>

      <h3>Code Review from Mobile</h3>
      <p>
        Agents that produce diffs can now submit them to the Styrby review queue.
        You see the changed files, the diff, and the agent&apos;s explanation on
        your phone. Approve or reject from the notification or from the review
        screen in the app. The decision is relayed back to the agent immediately.
      </p>

      <h3>Activity Graph</h3>
      <p>
        The dashboard now includes a GitHub-style contribution heatmap showing
        session activity by day over the past year. Each cell represents one day;
        intensity reflects session count and total cost. It is a fast way to
        spot usage patterns, identify periods of high spend, and see how your
        agent usage correlates with project milestones.
      </p>

      <h3>OTEL Metrics Export</h3>
      <p>
        Styrby can now push session metrics to any OpenTelemetry-compatible
        backend: Grafana, Datadog, Honeycomb, New Relic, and anything else that
        accepts OTLP. Export includes session duration, token counts, cost,
        agent type, model, and custom tags. Configure the endpoint and headers
        once in settings and every session ships to your observability stack
        automatically.
      </p>

      <h3>LiteLLM Dynamic Pricing</h3>
      <p>
        Cost calculations now pull from the LiteLLM pricing database, which
        covers more than 300 models and updates when providers change their
        rates. You no longer need to update Styrby or wait for a release to get
        accurate cost estimates for a new model. If your agent switches models
        mid-session, each message is costed at the correct rate for the model
        that generated it.
      </p>

      <h3>Rust-Powered JSONL Parser</h3>
      <p>
        Session files from agents like Aider and OpenCode can grow large over
        long sessions. Parsing them in JavaScript became a bottleneck for
        sessions with tens of thousands of messages. The parser is now a native
        Rust module compiled to WebAssembly. Large session files that previously
        took several seconds to load now parse in under 200 milliseconds.
      </p>

      <h2>Agent Spotlight</h2>

      <h3>Goose (Block / Square)</h3>
      <p>
        Goose is Block&apos;s open-source agent with enterprise Model Context
        Protocol support. MCP lets Goose connect to external data sources,
        internal APIs, and company-specific tools via a standardized protocol.
        Styrby monitors Goose sessions and surfaces MCP tool calls in the
        permission approval flow, so sensitive MCP actions still require
        explicit sign-off from your phone.
      </p>

      <h3>Amp (Sourcegraph)</h3>
      <p>
        Amp is Sourcegraph&apos;s agent built on their code intelligence
        platform. Its deep mode can spawn sub-agents to work on different parts
        of a codebase in parallel. Styrby tracks each sub-agent as a child
        session under the parent Amp session, so you see the full cost tree and
        can approve permissions for any branch of the parallel work without
        switching to the terminal.
      </p>

      <h3>Crush (Charmbracelet)</h3>
      <p>
        Crush is Charmbracelet&apos;s agent with their signature terminal UI
        polish. It runs in a Bubble Tea TUI that is genuinely pleasant to use.
        Styrby connects to Crush through the standard CLI bridge and mirrors
        session output to the mobile app, preserving the color-coded TUI output
        so the session is readable on a phone screen.
      </p>

      <h3>Kilo</h3>
      <p>
        Kilo routes to more than 500 models through a unified API layer and adds
        a Memory Bank feature that persists context across sessions. Styrby
        tracks Kilo&apos;s multi-model routing and correctly attributes each
        message to the model that handled it, so your cost breakdown reflects
        the actual model mix rather than a single blended rate.
      </p>

      <h3>Kiro (AWS)</h3>
      <p>
        Kiro is Amazon&apos;s IDE-integrated agent with a per-prompt credit
        system instead of token billing. Styrby maps Kiro&apos;s credit
        consumption to a dollar-equivalent estimate using the published credit
        rate, keeping the cost dashboard consistent across agents that use
        different billing models.
      </p>

      <h3>Droid</h3>
      <p>
        Droid is a bring-your-own-key agent that routes to multiple backend
        providers based on availability and cost. Styrby tracks which backend
        Droid selects for each request and breaks down costs by provider, giving
        you visibility into how the routing decisions affect your bill across
        different API keys.
      </p>

      <h2>Security</h2>
      <p>
        Session content is encrypted end-to-end using TweetNaCl box encryption.
        Keys are generated on your device and never sent to Styrby servers in
        plaintext. When you share a session, the share link includes a derived
        key that is separate from your primary session key. Revoking the share
        link does not compromise other sessions or your master key.
      </p>
      <p>
        The full codebase went through an OWASP-guided security audit in Q1
        2026. The audit covered authentication flows, RLS policy coverage on all
        16 Supabase tables, rate limiting, webhook signature verification, and
        the CLI bridge protocol. Findings were remediated before this sprint
        shipped.
      </p>
      <p>
        OTEL export credentials (endpoint URL and headers) are stored in Vercel
        environment variables and never appear in session data or logs. The
        export pipeline runs server-side; your observability credentials are not
        exposed to mobile clients.
      </p>

      <h2>Pricing</h2>
      <table>
        <thead>
          <tr>
            <th>Plan</th>
            <th>Agents</th>
            <th>Price</th>
            <th>Includes</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Free</td>
            <td>3 agents</td>
            <td>$0 / month</td>
            <td>
              Session monitoring, push notifications, cost tracking, mobile app
            </td>
          </tr>
          <tr>
            <td>Pro</td>
            <td>9 agents</td>
            <td>$24 / month</td>
            <td>
              Everything in Free plus session checkpoints, session sharing,
              voice commands, activity graph
            </td>
          </tr>
          <tr>
            <td>Power</td>
            <td>All 11 agents</td>
            <td>$59 / month</td>
            <td>
              Everything in Pro plus OTEL export, cloud task monitoring, mobile
              code review, team dashboard, per-developer cost attribution
            </td>
          </tr>
        </tbody>
      </table>
      <p>
        The Free plan lets you connect Claude Code, Codex, and one other agent.
        It covers the most common setup for solo developers and has no time
        limit. Upgrade to Pro when you need more agent coverage or the
        productivity features. Upgrade to Power when you need OTEL export or are
        managing AI costs across a team.
      </p>

      <h2>Getting Started</h2>
      <p>
        Create a free account at{" "}
        <a href="https://styrbyapp.com/signup">styrbyapp.com/signup</a>. Install
        the CLI bridge on any machine where your agents run, connect your first
        agent in under five minutes, and install the mobile app to start
        receiving push notifications. No credit card required for the Free plan.
      </p>
      <p>
        If you are already on the Free plan and want to unlock checkpoints,
        session sharing, or voice commands, upgrade to Pro from the billing
        settings in your dashboard. Power tier OTEL export requires a one-time
        endpoint configuration in settings; documentation is at{" "}
        <a href="https://styrbyapp.com/docs/dashboard">
          styrbyapp.com/docs/dashboard
        </a>
        .
      </p>
    </>
  );
}
