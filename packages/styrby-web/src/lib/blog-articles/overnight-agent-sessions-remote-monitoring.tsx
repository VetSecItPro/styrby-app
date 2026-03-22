/**
 * Article: Running AI Agents Overnight: Remote Monitoring for Long Sessions
 * Category: use-case
 */
export default function OvernightAgentSessionsRemoteMonitoring() {
  return (
    <>
      <p>
        Some tasks are too large for a supervised session. Migrating a database
        schema, refactoring a legacy module, or generating a test suite for an
        untested codebase can take hours. Developers who run these tasks
        overnight need a way to monitor progress, approve permissions, and
        control costs without sitting at their terminal.
      </p>

      <h2>Setting Up an Overnight Session</h2>
      <p>
        The preparation matters more than the monitoring. Before stepping away
        from a long-running agent session:
      </p>
      <ol>
        <li>
          <strong>Set budget limits.</strong> A runaway session at 3 AM with no
          budget cap will keep spending until the API provider&apos;s own limits
          kick in. Set a hard stop at your maximum acceptable cost for the task.
        </li>
        <li>
          <strong>Configure auto-approvals carefully.</strong> Allow the
          operations the agent needs (read, write project files, run tests) and
          block everything else. This reduces the chance the agent blocks on a
          permission request at 4 AM.
        </li>
        <li>
          <strong>Enable push notifications.</strong> Errors, permission
          requests, and budget alerts should wake your phone if necessary.
        </li>
      </ol>
      <pre>
        <code>{`# Example overnight setup
styrby budget set --period session --limit 40 \\
  --notify-at 60 --slowdown-at 80 --stop-at 100

styrby config auto-approve "Read *"
styrby config auto-approve "Write src/*"
styrby config auto-approve "Bash(npm run test)"
styrby config auto-approve "Bash(npm run build)"
styrby config require-approval "Bash(npm install *)"
styrby config require-approval "Bash(rm *)"

styrby connect --agent claude --model sonnet-4 \\
  --project db-migration`}</code>
      </pre>

      <h2>Monitoring from Your Phone</h2>
      <p>
        Once the session is running, the Styrby mobile app shows:
      </p>
      <ul>
        <li>
          <strong>Live status.</strong> Is the agent running, waiting for
          approval, or idle?
        </li>
        <li>
          <strong>Current cost.</strong> Running total with trend projection.
        </li>
        <li>
          <strong>Recent activity.</strong> The last few exchanges, encrypted
          and decrypted on your phone.
        </li>
        <li>
          <strong>Error count.</strong> How many errors have occurred and their
          classifications.
        </li>
      </ul>
      <p>
        You do not need to watch the app continuously. Push notifications
        surface anything that needs your attention.
      </p>

      <h2>Handling Permission Requests Overnight</h2>
      <p>
        Even with careful auto-approval configuration, agents sometimes request
        unexpected permissions. When a permission request arrives as a push
        notification:
      </p>
      <ul>
        <li>
          Tap the notification to see the full request, including the exact
          command and risk classification.
        </li>
        <li>
          Approve if the operation is safe. Deny if it is not.
        </li>
        <li>
          If you are unsure, deny it. The agent will either find an alternative
          approach or report that it could not complete the task. Better to have
          the agent stuck than to approve a destructive command while half
          asleep.
        </li>
      </ul>

      <h2>Budget Alerts as Safety Nets</h2>
      <p>
        Budget alerts are most valuable during unattended sessions. The
        graduated alert system works as follows:
      </p>
      <ol>
        <li>
          At 60% of the session budget, you get a notification. No action
          needed. The session is progressing within expectations.
        </li>
        <li>
          At 80%, the agent slows down. This gives you time to check whether
          the session is making progress or stuck in a loop.
        </li>
        <li>
          At 100%, the session pauses. You must explicitly approve additional
          spending. If you are asleep, the session simply waits until morning.
        </li>
      </ol>
      <p>
        The cost of a paused session is zero. An agent that stops at $40 and
        waits for your approval in the morning is better than an agent that
        spends $120 on retries overnight.
      </p>

      <h2>Morning Review</h2>
      <p>
        When you return to your workstation, the Styrby dashboard gives you a
        session summary:
      </p>
      <ul>
        <li>Total cost and token breakdown</li>
        <li>Number of turns and average cost per turn</li>
        <li>Errors encountered and their classifications</li>
        <li>Permission requests and your responses</li>
        <li>Whether the agent completed the task or stopped early</li>
      </ul>
      <p>
        Session replay lets you review the full conversation. For a long
        session, you do not need to read every exchange. Focus on the errors
        and the final output. If the agent completed the migration successfully
        and all tests pass, the intermediate steps are less important.
      </p>

      <h2>Practical Tips for Overnight Sessions</h2>
      <ul>
        <li>
          Use Sonnet-class models for overnight work. They are cheaper, and
          overnight sessions tend to be repetitive tasks where the cheaper
          model performs comparably.
        </li>
        <li>
          Set the budget at 2x your estimate, not 10x. If you think the task
          should cost $15, set the limit at $30. This gives the agent room for
          retries without allowing unlimited spend.
        </li>
        <li>
          Keep the blocked tools list strict. Overnight is not the time to
          discover that the agent wants to run <code>rm -rf</code>.
        </li>
        <li>
          Test the task during the day first. Run 10 minutes of the task
          supervised, verify the agent is on the right track, then let it
          continue overnight.
        </li>
      </ul>
    </>
  );
}
