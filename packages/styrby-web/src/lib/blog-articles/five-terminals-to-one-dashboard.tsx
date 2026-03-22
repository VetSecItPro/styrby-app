/**
 * Article: From Five Terminals to One Dashboard
 * Category: use-case
 */
export default function FiveTerminalsToOneDashboard() {
  return (
    <>
      <p>
        This article describes a concrete workflow change: what daily
        development looks like when you switch from checking individual agent
        terminals to using a unified dashboard. The difference is not dramatic,
        but the time saved compounds.
      </p>

      <h2>Before: The Multi-Terminal Workflow</h2>
      <p>
        A developer using Claude Code and Codex on the same project has at
        least four windows open: their editor, a regular terminal for git and
        builds, the Claude Code session, and the Codex session. Adding Gemini
        for research makes it five.
      </p>
      <p>
        The checking routine happens roughly every 15 minutes:
      </p>
      <ol>
        <li>Switch to Claude terminal. Is it running, waiting, or done?</li>
        <li>Switch to Codex terminal. Same check.</li>
        <li>If either is waiting for approval, approve it.</li>
        <li>Switch back to editor. Try to remember what you were doing.</li>
      </ol>
      <p>
        Cost tracking happens separately. Open the Anthropic dashboard in a
        browser tab. Open the OpenAI dashboard in another tab. Compare numbers.
        Close tabs. Resume work.
      </p>
      <p>
        Each cycle takes maybe 30 seconds. At four cycles per hour over an
        eight-hour day, that is 16 minutes spent on status checks. More
        importantly, each context switch interrupts focus.
      </p>

      <h2>After: The Dashboard Workflow</h2>
      <p>
        With Styrby connected to both agents, the workflow changes:
      </p>
      <ol>
        <li>
          Work in your editor. When an agent needs attention, your phone buzzes
          with a push notification.
        </li>
        <li>
          Glance at the notification. If it is a permission request, approve or
          deny from the phone. If it is a completion, note it and continue.
        </li>
        <li>
          When you want a status check, open the Styrby app. All agents are
          visible in one list: running, idle, or waiting.
        </li>
        <li>
          Cost tracking happens automatically. No browser tabs to open.
        </li>
      </ol>
      <p>
        The key change: you stop polling for status and start receiving it.
        Instead of checking five terminals every 15 minutes, relevant
        information comes to you when it matters.
      </p>

      <h2>What Actually Changes Day to Day</h2>

      <h3>Morning Start</h3>
      <p>
        Before: Open each agent terminal, recall where each session left off,
        restart any that need continuing.
      </p>
      <p>
        After: Open the Styrby app. See overnight session summaries if anything
        ran. Start new sessions from the terminal as usual, with Styrby
        connected for monitoring.
      </p>

      <h3>Mid-Day Multitasking</h3>
      <p>
        Before: Keep switching between terminals to check on parallel sessions.
        Miss permission requests if you do not check frequently enough.
      </p>
      <p>
        After: Work in your editor. Permission requests appear as phone
        notifications. Approve from your phone without leaving your editor.
        Status updates appear on the dashboard when you choose to look.
      </p>

      <h3>Meeting Interruptions</h3>
      <p>
        Before: Leave for a 30-minute meeting. Agent blocks on a permission
        request at minute 5. You return 25 minutes later to find the agent has
        been idle the entire time.
      </p>
      <p>
        After: Same meeting. Permission request arrives on your phone at minute
        5. You approve it discreetly. Agent continues working. By the time the
        meeting ends, the agent has completed the task.
      </p>

      <h3>End of Day Review</h3>
      <p>
        Before: Check each provider billing page. Add up costs. Hope you
        remember which project each session was for.
      </p>
      <p>
        After: Open the Styrby cost view. See total daily spend broken down by
        agent and project tag. Done in 10 seconds.
      </p>

      <h2>What Styrby Does Not Change</h2>
      <p>
        Styrby is a monitoring and control layer. It does not change how you
        interact with agents. You still:
      </p>
      <ul>
        <li>Write prompts in the agent&apos;s terminal</li>
        <li>Review diffs and code in the agent&apos;s native interface</li>
        <li>Configure agent settings through each agent&apos;s own config</li>
        <li>Manage your codebase with git and your editor as usual</li>
      </ul>
      <p>
        The terminal sessions still exist. You still use them for the actual
        coding work. Styrby handles the overhead tasks that do not require the
        full terminal interface: status checks, permission approvals, cost
        tracking, and session management.
      </p>

      <h2>Is It Worth It?</h2>
      <p>
        If you use one agent occasionally, probably not. The overhead of
        checking a single terminal is minimal. The value increases with the
        number of agents and the frequency of sessions. Two or more agents
        running daily is where most developers find the dashboard saves
        meaningful time.
      </p>
    </>
  );
}
