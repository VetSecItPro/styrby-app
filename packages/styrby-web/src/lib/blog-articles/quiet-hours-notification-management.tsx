/**
 * Article: Setting Up Quiet Hours for AI Agent Notifications
 * Category: use-case
 */
export default function QuietHoursNotificationManagement() {
  return (
    <>
      <p>
        A developer running three agent sessions per day might receive 15-20
        notifications: session starts, permission requests, budget warnings,
        completions, and errors. During work hours, these are useful signals.
        At 11 PM, they are interruptions. The solution is not to disable
        notifications entirely. It is to suppress routine ones during defined
        hours while keeping critical alerts active.
      </p>

      <h2>Configuring Quiet Hours</h2>
      <pre>
        <code>{`# Set quiet hours from 10 PM to 7 AM
styrby config quiet-hours set --start 22:00 --end 07:00

# Set timezone (important for consistency)
styrby config quiet-hours timezone America/New_York

# View current settings
styrby config quiet-hours show
# Quiet hours: 22:00 - 07:00 (America/New_York)
# Critical bypass: enabled
# Suppressed: session-start, session-complete, low-risk approvals
# Active during quiet: budget-stop, high-risk permissions, errors`}</code>
      </pre>

      <h2>What Gets Suppressed</h2>
      <p>
        During quiet hours, these notifications are silently logged but not
        pushed to your device:
      </p>
      <ul>
        <li>Session start and completion</li>
        <li>Low-risk auto-approved permissions</li>
        <li>Budget notify alerts (informational only)</li>
        <li>Session bookmark confirmations</li>
      </ul>
      <p>
        These notifications still appear in the app when you open it. They
        just do not wake your phone.
      </p>

      <h2>Critical Alert Bypass</h2>
      <p>
        Some notifications should always get through, regardless of quiet hours:
      </p>
      <ul>
        <li>
          <strong>Budget hard stops.</strong> When a session hits its spending
          limit and pauses, you need to know. The session is blocked until you
          respond.
        </li>
        <li>
          <strong>High-risk permission requests.</strong> Red-classified
          permissions (file deletion, network requests, system changes) bypass
          quiet hours because the agent is waiting for a response.
        </li>
        <li>
          <strong>Repeated errors.</strong> Three or more errors in a row
          triggers a critical notification. This usually means the agent is
          stuck and spending tokens unproductively.
        </li>
      </ul>
      <p>
        You can customize which alerts bypass quiet hours:
      </p>
      <pre>
        <code>{`# Add budget-slowdown to critical bypass
styrby config quiet-hours bypass add budget-slowdown

# Remove session errors from bypass (you'll review in the morning)
styrby config quiet-hours bypass remove session-error

# View bypass list
styrby config quiet-hours bypass list`}</code>
      </pre>

      <h2>Per-Agent Notification Settings</h2>
      <p>
        Not all agents need the same notification level. You might want full
        notifications for a Claude Opus session doing critical architecture
        work, but only errors from a Gemini CLI research session.
      </p>
      <pre>
        <code>{`# Claude: all notifications
styrby config notifications --agent claude --level all

# Codex: only errors and permission requests
styrby config notifications --agent codex --level important

# Gemini: errors only
styrby config notifications --agent gemini --level errors-only

# Aider: silent (check manually)
styrby config notifications --agent aider --level silent`}</code>
      </pre>

      <h2>Weekend Configuration</h2>
      <p>
        Some developers run agents on weekends for personal projects but do not
        want the same notification intensity as weekdays. Styrby supports
        separate quiet hours for weekdays and weekends:
      </p>
      <pre>
        <code>{`# Weekday quiet hours: 10 PM to 7 AM
styrby config quiet-hours set --days weekday --start 22:00 --end 07:00

# Weekend quiet hours: all day except noon to 2 PM
styrby config quiet-hours set --days weekend --start 00:00 --end 12:00
styrby config quiet-hours set --days weekend --start 14:00 --end 23:59`}</code>
      </pre>

      <h2>Reviewing Suppressed Notifications</h2>
      <p>
        When you open the app after quiet hours end, suppressed notifications
        appear in a summary view:
      </p>
      <ul>
        <li>Number of notifications suppressed</li>
        <li>Breakdown by type (permission, budget, session, error)</li>
        <li>Any sessions that completed overnight</li>
        <li>Total cost accrued during quiet hours</li>
      </ul>
      <p>
        This morning summary gives you a quick overview without scrolling
        through individual notifications. Tap any category to see the full list.
      </p>

      <h2>Finding the Right Balance</h2>
      <p>
        Start with the defaults: suppress routine notifications during sleep
        hours, let critical alerts through. After a week, review what woke you
        up and what you wish had. Adjust the bypass list accordingly.
      </p>
      <p>
        The goal is not zero notifications. The goal is that every notification
        during quiet hours requires your attention, and none of them could have
        waited until morning.
      </p>
    </>
  );
}
