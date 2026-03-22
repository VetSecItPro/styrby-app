/**
 * Article: Five Agents, One Dashboard: Why Context Switching Kills Productivity
 * Category: deep-dive
 */
export default function MultiAgentDashboardOneView() {
  return (
    <>
      <p>
        If you use multiple AI coding agents, you know the workflow: tab to
        the Claude terminal, check status, tab to the Codex terminal, check
        status, open the Anthropic billing page, open the OpenAI billing page.
        Each context switch takes 10-15 seconds and interrupts whatever you
        were actually thinking about. Over a day, these micro-interruptions
        add up to something measurable.
      </p>

      <h2>The Five-Terminal Problem</h2>
      <p>
        A developer using Claude Code for architecture work, Codex for
        boilerplate generation, and Gemini CLI for research has at minimum
        three terminal windows dedicated to agent sessions. Add Aider for
        legacy codebase work and OpenCode for specific tasks, and you have
        five terminals that each need periodic attention.
      </p>
      <p>
        Each agent has its own interface patterns:
      </p>
      <ul>
        <li>Claude Code shows a conversation thread with inline diffs</li>
        <li>Codex uses a split-pane interface with file previews</li>
        <li>Gemini CLI presents a different conversation format</li>
        <li>Aider has its own command set and status indicators</li>
        <li>OpenCode uses yet another interface pattern</li>
      </ul>
      <p>
        There is no unified status indicator. To know if all your agents are
        idle, running, or waiting for input, you check each one individually.
      </p>

      <h2>Unified Status View</h2>
      <p>
        Styrby&apos;s dashboard shows all connected agents in a single view:
      </p>
      <table>
        <thead>
          <tr>
            <th>Agent</th>
            <th>Status</th>
            <th>Project</th>
            <th>Session Cost</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Claude (Sonnet 4)</td>
            <td>Running</td>
            <td>api-service</td>
            <td>$2.40</td>
            <td>45m</td>
          </tr>
          <tr>
            <td>Codex</td>
            <td>Waiting for approval</td>
            <td>frontend</td>
            <td>$0.80</td>
            <td>12m</td>
          </tr>
          <tr>
            <td>Gemini CLI</td>
            <td>Idle</td>
            <td>docs</td>
            <td>$0.30</td>
            <td>5m</td>
          </tr>
        </tbody>
      </table>
      <p>
        One glance tells you that Claude is working, Codex needs your
        attention, and Gemini is done. No terminal switching required.
      </p>

      <h2>Color-Coded Agent Identification</h2>
      <p>
        Each agent is assigned a consistent color across the dashboard,
        notifications, and cost charts:
      </p>
      <ul>
        <li><strong>Claude Code:</strong> Orange (Anthropic brand)</li>
        <li><strong>Codex:</strong> Green (OpenAI brand)</li>
        <li><strong>Gemini CLI:</strong> Blue (Google brand)</li>
        <li><strong>OpenCode:</strong> Purple</li>
        <li><strong>Aider:</strong> Teal</li>
      </ul>
      <p>
        When a push notification arrives, the color tells you which agent sent
        it before you read the text. When viewing cost charts, you immediately
        see which agents are driving spend.
      </p>

      <h2>Cost Aggregation</h2>
      <p>
        Individual agent billing dashboards show costs for that agent only.
        If you want total AI spend, you add them up yourself. Styrby
        aggregates automatically on each page load:
      </p>
      <ul>
        <li>
          <strong>Daily total:</strong> Sum across all agents, broken down by
          agent in a stacked bar chart
        </li>
        <li>
          <strong>Weekly and monthly totals:</strong> Trend lines showing how
          spend changes over time
        </li>
        <li>
          <strong>Cost by tag:</strong> How much each tagged project or client
          costs across all agents used on it
        </li>
        <li>
          <strong>Model comparison:</strong> Cost per agent and model
          combination, helping you identify where switching to a cheaper model
          would save the most
        </li>
      </ul>

      <h2>Notification Consolidation</h2>
      <p>
        Without Styrby, each agent generates its own notifications in its
        terminal. You see them only when you switch to that terminal. With
        Styrby, notifications from all agents route to your phone through a
        single channel.
      </p>
      <p>
        Notification types across all agents:
      </p>
      <ul>
        <li>Permission requests (with risk badges)</li>
        <li>Session completion</li>
        <li>Errors (with color-coded attribution)</li>
        <li>Budget alerts</li>
        <li>Retry loop detection</li>
      </ul>
      <p>
        Each notification is tagged with the agent color and name. You can
        filter notification preferences per agent: maybe you want all
        notifications from Claude but only errors from Gemini.
      </p>

      <h2>The Productivity Argument</h2>
      <p>
        Research on context switching consistently shows that each switch costs
        15-25 seconds of recovery time, not just the seconds spent switching
        tabs. When you check five agent terminals every 15 minutes, that is
        five switches times 20 seconds average, times four rounds per hour:
        about 7 minutes per hour spent on agent status checking.
      </p>
      <p>
        A unified dashboard reduces this to one glance. The agents that need
        attention surface through notifications. The ones running smoothly stay
        out of your way. That recovered time goes back to actual engineering
        work.
      </p>

      <h2>When You Still Need the Terminal</h2>
      <p>
        The Styrby dashboard is a monitoring and control layer, not a
        replacement for the agent interfaces. When you need to have a detailed
        conversation with an agent, provide complex context, or review inline
        diffs, you still use the agent&apos;s native terminal. Styrby handles
        the overhead tasks: status monitoring, cost tracking, permission
        approval, and session management. The agents still do the coding work
        in their own interfaces.
      </p>
    </>
  );
}
