/**
 * Article: Remote Permission Approval: Why Your AI Agent Shouldn't Have Root Access
 * Category: deep-dive
 */
export default function RemotePermissionApproval() {
  return (
    <>
      <p>
        AI coding agents need permissions to be useful. They need to read
        files, run commands, and sometimes modify your codebase. The question
        is not whether to grant permissions, but how to control what gets
        approved and maintain visibility into what the agent is doing when
        you are not watching.
      </p>

      <h2>The Problem With Blanket Approval</h2>
      <p>
        Some developers run agents with all permissions enabled to avoid
        constant approval interruptions. This is understandable. Being asked
        to approve every <code>cat</code> and <code>ls</code> command is
        tedious and breaks flow. But blanket approval means the agent can do
        anything, and agents do request surprising things.
      </p>
      <p>
        Here are real examples from production sessions:
      </p>
      <ul>
        <li>
          <code>rm -rf node_modules && rm -rf .git</code> when asked to
          &quot;clean up the project&quot;
        </li>
        <li>
          <code>curl -X POST</code> to an external API with request body
          containing source code
        </li>
        <li>
          <code>chmod 777</code> on a directory containing credentials
        </li>
        <li>
          Writing to <code>~/.ssh/config</code> when asked to set up a deploy
          script
        </li>
        <li>
          Installing npm packages with known vulnerabilities as transitive
          dependencies
        </li>
      </ul>
      <p>
        None of these are the agent being malicious. They are the agent
        interpreting instructions literally without understanding security
        context. An agent told to &quot;clean up&quot; does not distinguish
        between removing build artifacts and deleting version control history.
      </p>

      <h2>How Remote Approval Works</h2>
      <p>
        Styrby&apos;s remote approval routes permission requests to your mobile
        device. The flow:
      </p>
      <ol>
        <li>
          The agent requests permission to run a command (e.g.,{" "}
          <code>rm -rf dist/</code>).
        </li>
        <li>
          Styrby&apos;s CLI intercepts the request before it executes.
        </li>
        <li>
          The request is classified by risk level and sent to your phone as a
          push notification.
        </li>
        <li>
          You see the exact command, the risk classification, and the project
          context.
        </li>
        <li>
          You approve or deny. The decision is logged in the audit trail.
        </li>
        <li>
          The CLI relays your decision to the agent.
        </li>
      </ol>

      <h2>Risk Classification</h2>
      <p>
        Not all permissions require the same level of scrutiny. Styrby
        classifies requests into three risk levels:
      </p>
      <table>
        <thead>
          <tr>
            <th>Risk Level</th>
            <th>Badge</th>
            <th>Examples</th>
            <th>Default</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Low</td>
            <td>Green</td>
            <td>Read files, list directories, run tests</td>
            <td>Auto-approve (configurable)</td>
          </tr>
          <tr>
            <td>Medium</td>
            <td>Yellow</td>
            <td>Write files in project, install dependencies, run builds</td>
            <td>Notify + approve</td>
          </tr>
          <tr>
            <td>High</td>
            <td>Red</td>
            <td>Delete files, network requests, system config changes</td>
            <td>Require explicit approval</td>
          </tr>
        </tbody>
      </table>
      <p>
        The classification is based on pattern matching against the command.
        Commands containing <code>rm</code>, <code>curl</code>,{" "}
        <code>wget</code>, <code>chmod</code>, or writes to paths outside the
        project directory are flagged as high risk. You can customize these
        rules.
      </p>

      <h2>Blocked Tool Lists</h2>
      <p>
        Beyond risk classification, you can maintain a blocked tool list.
        Commands on this list are automatically denied without sending a
        notification:
      </p>
      <pre>
        <code>{`# Block specific dangerous patterns
styrby config blocked-tools add "rm -rf /"
styrby config blocked-tools add "chmod 777"
styrby config blocked-tools add "curl * -d *"

# View current blocked list
styrby config blocked-tools list`}</code>
      </pre>
      <p>
        Blocked tools act as a hard safety net. Even if you accidentally
        approve something in a rush, the blocked list catches it.
      </p>

      <h2>The Audit Trail</h2>
      <p>
        Every permission request, approval, and denial is logged with:
      </p>
      <ul>
        <li>Timestamp</li>
        <li>Agent that made the request</li>
        <li>Exact command requested</li>
        <li>Risk classification</li>
        <li>Your decision (approved, denied, auto-approved)</li>
        <li>Which device you responded from</li>
        <li>Response latency</li>
      </ul>
      <p>
        This log serves two purposes. First, it helps you review what happened
        in a session after the fact. Second, it provides compliance
        documentation for teams that need to demonstrate access controls over
        AI-generated code changes.
      </p>

      <h2>Practical Configuration</h2>
      <p>
        The goal is to minimize interruptions while maintaining security. A
        reasonable starting configuration:
      </p>
      <pre>
        <code>{`# Auto-approve read operations and test runs
styrby config auto-approve "Read *"
styrby config auto-approve "Bash(npm run test)"
styrby config auto-approve "Bash(npm run build)"
styrby config auto-approve "Bash(npx tsc --noEmit)"

# Require approval for writes and network
styrby config require-approval "Write *"
styrby config require-approval "Bash(curl *)"
styrby config require-approval "Bash(npm install *)"

# Block dangerous patterns
styrby config blocked-tools add "Bash(rm -rf /)"
styrby config blocked-tools add "Bash(chmod 777 *)"
styrby config blocked-tools add "Bash(* > ~/.ssh/*)"
styrby config blocked-tools add "Bash(* > ~/.aws/*)"`}</code>
      </pre>
      <p>
        Start with more approvals required and loosen over time as you build
        confidence in which operations are safe for your specific workflow.
      </p>

      <h2>Latency Considerations</h2>
      <p>
        Remote approval adds 2-5 seconds of latency per permission request.
        For interactive sessions where you are actively working with the agent,
        this can feel slow. The solution: use auto-approve for low-risk
        operations during active sessions and switch to full remote approval
        when running agents unattended.
      </p>
    </>
  );
}
