/**
 * Article: AI Agent Permissions: Built-in Controls vs. Remote Approval
 * Category: comparison
 */
export default function ClaudeCodePermissionsBuiltInVsRemote() {
  return (
    <>
      <p>
        Every AI coding agent has some form of permission control. Claude Code
        has the most granular built-in system. The others range from sandboxed
        execution to simple yes/no prompts. This article compares how these
        agents handle permissions, then covers how remote approval works as an
        alternative layer.
      </p>

      <h2>Permission Models Across AI Coding Agents</h2>
      <table>
        <thead>
          <tr>
            <th>Agent</th>
            <th>Permission Model</th>
            <th>Configuration</th>
            <th>Audit Trail</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Claude Code</td>
            <td>Granular allowlists with deny rules</td>
            <td><code>.claude/settings.json</code></td>
            <td>Session log only</td>
          </tr>
          <tr>
            <td>Codex</td>
            <td>Sandboxed cloud execution, approve network/file access</td>
            <td>Per-session in the Codex UI</td>
            <td>OpenAI dashboard</td>
          </tr>
          <tr>
            <td>Gemini CLI</td>
            <td>Terminal prompt for each action</td>
            <td>Limited config options</td>
            <td>Terminal history only</td>
          </tr>
          <tr>
            <td>OpenCode</td>
            <td>Settings file with allowed operations</td>
            <td>Project-level config</td>
            <td>None built-in</td>
          </tr>
          <tr>
            <td>Aider</td>
            <td>Git-based safety (auto-commits before changes)</td>
            <td>CLI flags and config file</td>
            <td>Git history</td>
          </tr>
        </tbody>
      </table>
      <p>
        Claude Code has the most configurable system. Codex takes a different
        approach by sandboxing execution entirely. Aider relies on git as its
        safety mechanism. The others fall somewhere in between.
      </p>

      <h2>Claude Code&apos;s Built-in Permission Model</h2>
      <p>
        By default, Claude Code asks for confirmation before running commands,
        editing files outside the project directory, or making network requests.
        You approve or deny each action in your terminal.
      </p>
      <p>
        For automation, Claude Code supports allowlists in{" "}
        <code>.claude/settings.json</code>:
      </p>
      <pre>
        <code>{`{
  "permissions": {
    "allow": [
      "Read",
      "Write",
      "Bash(npm run test)",
      "Bash(npm run build)"
    ],
    "deny": [
      "Bash(rm -rf *)",
      "Bash(curl *)"
    ]
  }
}`}</code>
      </pre>
      <p>
        The <code>--dangerously-skip-permissions</code> flag disables all
        permission checks. It is designed for CI/CD pipelines and headless
        environments where interactive approval is impossible.
      </p>

      <h3>Strengths of the Built-in Approach</h3>
      <ul>
        <li>Zero latency. Approvals happen locally, no network round trip.</li>
        <li>No dependency on external services. Works offline.</li>
        <li>
          Granular allowlists. You can approve specific commands by exact
          pattern.
        </li>
        <li>
          No additional cost. Included with Claude Code.
        </li>
      </ul>

      <h3>Limitations</h3>
      <ul>
        <li>
          Requires terminal access. If you walk away from your machine, the
          agent blocks on pending approvals.
        </li>
        <li>
          Allowlists are static. You define them before the session starts and
          cannot adjust them mid-session without editing the config file.
        </li>
        <li>
          No audit trail beyond the session log. Permission decisions are not
          separately tracked.
        </li>
      </ul>

      <h2>Styrby&apos;s Remote Approval Model</h2>
      <p>
        Styrby intercepts permission requests and routes them to your mobile
        device as push notifications. Each request shows what the agent wants
        to do, classified by risk level:
      </p>
      <ul>
        <li>
          <strong>Green (low risk).</strong> Read operations, running tests,
          builds. Things that do not modify state.
        </li>
        <li>
          <strong>Yellow (medium risk).</strong> File writes within the project
          directory, installing dependencies.
        </li>
        <li>
          <strong>Red (high risk).</strong> Deleting files, running arbitrary
          shell commands, network requests, anything touching credentials.
        </li>
      </ul>
      <p>
        You tap approve or deny on your phone. The decision is logged in
        Styrby&apos;s audit trail with timestamp, device, and the exact command
        that was requested.
      </p>

      <h3>Strengths of Remote Approval</h3>
      <ul>
        <li>
          Approve from anywhere. You do not need to be at your terminal.
        </li>
        <li>
          Risk classification. Visual risk badges help you make faster
          decisions about unfamiliar commands.
        </li>
        <li>
          Audit trail. Every approval and denial is logged for later review.
        </li>
        <li>
          Works across agents. The same approval flow for Claude, Codex,
          Gemini, and others.
        </li>
      </ul>

      <h3>Limitations</h3>
      <ul>
        <li>
          Network latency. Approval requires a round trip to Styrby servers
          and your phone. This adds 2-5 seconds per approval.
        </li>
        <li>
          Requires connectivity. If your phone is offline, approvals queue
          and the agent blocks until you reconnect.
        </li>
        <li>
          Additional cost. Requires a Styrby subscription for full features.
        </li>
        <li>
          Parser dependency. Styrby parses agent output to detect permission
          requests. If an agent changes its output format, there may be a delay
          before Styrby updates its parser.
        </li>
      </ul>

      <h2>When to Use Each Approach</h2>
      <h3>Use Built-in Permissions When:</h3>
      <ul>
        <li>You are sitting at your terminal and actively supervising</li>
        <li>You have a well-defined allowlist for your project</li>
        <li>Latency matters (real-time pair programming with the agent)</li>
        <li>You only use Claude Code</li>
      </ul>

      <h3>Use Remote Approval When:</h3>
      <ul>
        <li>You run agents overnight or while away from your desk</li>
        <li>You want an audit trail of all permission decisions</li>
        <li>You use multiple agents and want consistent approval flow</li>
        <li>You want risk classification to speed up approval decisions</li>
      </ul>

      <h2>Using Both Together</h2>
      <p>
        The two approaches are not mutually exclusive. A practical setup: use
        Claude Code&apos;s allowlist for common operations (read, test, build)
        and route everything else through Styrby&apos;s remote approval. This
        reduces notification noise while keeping high-risk actions gated behind
        explicit approval.
      </p>
      <pre>
        <code>{`# .claude/settings.json - approve safe operations locally
{
  "permissions": {
    "allow": ["Read", "Bash(npm run test)", "Bash(npm run build)"]
  }
}

# Styrby CLI - route remaining permissions to mobile
styrby connect --agent claude --remote-approval`}</code>
      </pre>
      <p>
        This hybrid approach gives you the speed of local allowlists for
        routine operations and the security of remote approval for everything
        else.
      </p>
    </>
  );
}
