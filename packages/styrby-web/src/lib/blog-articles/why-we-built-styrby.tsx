/**
 * Article: Why We Built Styrby
 * Category: company
 */
export default function WhyWeBuiltStyrby() {
  return (
    <>
      <p>
        Styrby exists because we needed it and nobody was building it. The
        problem was specific: developers using multiple AI coding agents had
        no unified way to track costs, approve permissions, or review sessions
        across agents. This article explains the gap we found and the tool we
        built to fill it.
      </p>

      <h2>The Problem</h2>
      <p>
        By early 2026, most professional developers were using at least one AI
        coding agent. Many were using two or three. Claude Code for deep
        reasoning work. Codex for fast boilerplate. Gemini CLI for research.
        Aider for legacy codebases. Each agent runs in its own terminal with
        its own interface.
      </p>
      <p>
        Three specific problems emerged from this multi-agent workflow.
      </p>

      <h3>No Unified Cost Visibility</h3>
      <p>
        Each agent bills through its own provider. To know your total AI
        spend, you check the Anthropic billing page, the OpenAI billing page,
        and the Google Cloud billing page. Then you add them up. If you want
        per-client cost attribution, you track sessions manually.
      </p>
      <p>
        This is workable for a solo developer spending $50/month. It breaks
        down for teams spending $1,000/month across multiple agents and
        projects.
      </p>

      <h3>No Remote Permission Control</h3>
      <p>
        AI agents ask permission before running commands. If you step away from
        your terminal, the agent blocks on a pending approval. Walk to the
        kitchen, come back ten minutes later, and the agent has been idle the
        entire time.
      </p>
      <p>
        Worse: if you run an agent overnight, there is no way to approve
        permissions without being at your terminal. The session either runs
        with all permissions auto-approved (risky) or blocks on the first
        permission request (wasteful).
      </p>

      <h3>No Session Management Across Agents</h3>
      <p>
        Each agent maintains its own session history. Reviewing what happened
        across a day of mixed agent usage means checking each agent separately.
        There is no unified timeline, no cross-agent search, and no way to
        compare costs between agents for similar tasks.
      </p>

      <h2>The Market Gap</h2>
      <p>
        We looked at existing solutions. The agent providers focus on their own
        agent experience. Anthropic built Claude Code Channels for remote
        Claude access. OpenAI has its own monitoring. Google has Cloud
        monitoring. None of them address the multi-agent case because none of
        them have incentive to. Each vendor wants you using their agent
        exclusively.
      </p>
      <p>
        Developer tool companies were building AI features into existing
        products (VS Code extensions, IDE plugins), not standalone management
        tools for multi-agent workflows.
      </p>
      <p>
        The gap was clear: a cross-agent management layer providing cost
        tracking, remote permissions, and session management regardless of
        which agents you use.
      </p>

      <h2>What We Built</h2>
      <p>
        Styrby has three components:
      </p>
      <ol>
        <li>
          <strong>CLI.</strong> Runs alongside your AI agents on your
          workstation. Captures session data, intercepts permission requests,
          tracks token costs. Encrypts everything with TweetNaCl before
          sending to the server.
        </li>
        <li>
          <strong>Mobile app.</strong> iOS app (built with Expo) for remote
          monitoring, permission approval, and session review. Push
          notifications for important events.
        </li>
        <li>
          <strong>Web dashboard.</strong> Full session management, cost
          analytics, and budget configuration.
        </li>
      </ol>
      <p>
        The architecture is zero-knowledge: the server stores encrypted session
        data and cost metadata. It never sees your source code or agent
        conversations.
      </p>

      <h2>What We Deliberately Did Not Build</h2>
      <ul>
        <li>
          <strong>Another AI agent.</strong> The world has enough AI coding
          agents. We build the management layer, not the agents themselves.
        </li>
        <li>
          <strong>An IDE integration.</strong> IDE plugins compete with
          existing tools. Styrby operates at the terminal/system level, which
          is where agents run.
        </li>
        <li>
          <strong>A replacement for provider dashboards.</strong> If you want
          detailed Anthropic usage analytics, use Anthropic&apos;s dashboard.
          Styrby provides cross-agent aggregation, not deep single-provider
          analytics.
        </li>
      </ul>

      <h2>Where We Are Now</h2>
      <p>
        Styrby supports eleven agents: Claude Code, Codex, Gemini CLI, OpenCode,
        Aider, Goose, Amp, Crush, Kilo, Kiro, and Droid. The CLI is in public beta. The iOS app is in development.
        The web dashboard is live. We are a small team, building carefully, and
        shipping features when they are ready.
      </p>
      <p>
        If you use multiple AI coding agents and want better visibility into
        costs and permissions, Styrby is what we built for you.
      </p>
    </>
  );
}
