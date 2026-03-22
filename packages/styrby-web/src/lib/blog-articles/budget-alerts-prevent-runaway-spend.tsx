/**
 * Article: How Budget Alerts Prevent Runaway AI Spend
 * Category: deep-dive
 */
export default function BudgetAlertsPreventRunawaySpend() {
  return (
    <>
      <p>
        A four-hour Claude Opus session with repeated context and multiple
        retries can easily exceed $50. If you stepped away from your terminal
        and the agent entered a retry loop, you might not know until you check
        the billing page the next morning. Budget alerts are the mechanism
        Styrby uses to keep spending visible and controllable before that
        happens.
      </p>

      <h2>How Costs Accumulate</h2>
      <p>
        Token costs are linear, but usage patterns are not. A typical session
        starts cheap: the first prompt sends a small context window and
        receives a focused response. As the session continues, context grows.
        By the twentieth turn, the agent is processing hundreds of thousands
        of tokens per exchange.
      </p>
      <p>
        The most expensive pattern is the retry loop. The agent generates code,
        runs tests, tests fail, and the agent tries again. Each retry sends the
        full context plus the failed attempt plus the error output. Three
        retries can cost more than the original implementation.
      </p>

      <h2>Setting Up Budget Alerts</h2>
      <p>
        Styrby supports three budget periods: daily, weekly, and monthly. Each
        period can have independent thresholds and actions.
      </p>
      <pre>
        <code>{`# Set a daily budget of $25 with all three alert levels
styrby budget set --period daily --limit 25 \\
  --notify-at 80 \\
  --slowdown-at 90 \\
  --stop-at 100`}</code>
      </pre>
      <p>Or configure via the dashboard with per-agent granularity:</p>
      <table>
        <thead>
          <tr>
            <th>Setting</th>
            <th>Global</th>
            <th>Claude Only</th>
            <th>Codex Only</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Daily limit</td>
            <td>$50</td>
            <td>$30</td>
            <td>$20</td>
          </tr>
          <tr>
            <td>Notify at</td>
            <td>80%</td>
            <td>80%</td>
            <td>80%</td>
          </tr>
          <tr>
            <td>Slow down at</td>
            <td>90%</td>
            <td>90%</td>
            <td>-</td>
          </tr>
          <tr>
            <td>Hard stop at</td>
            <td>100%</td>
            <td>100%</td>
            <td>100%</td>
          </tr>
        </tbody>
      </table>

      <h2>The Three Alert Actions</h2>

      <h3>1. Notify</h3>
      <p>
        A push notification to your phone. The session continues uninterrupted.
        This is informational: you are approaching your budget but may have
        good reason to continue.
      </p>
      <p>
        The notification includes: current spend, budget limit, which agent
        and project are driving costs, and the projected daily total based on
        current rate.
      </p>

      <h3>2. Slow Down</h3>
      <p>
        The CLI adds a 10-second delay between agent responses. This serves two
        purposes: it gives you time to check your phone and evaluate whether
        the session is productive, and it naturally reduces the token-per-minute
        rate.
      </p>
      <p>
        Slowdown is not a hard restriction. The agent still works. You just
        have a natural pause to decide whether to continue, adjust the model,
        or stop the session.
      </p>

      <h3>3. Hard Stop</h3>
      <p>
        The session pauses. The agent cannot send or receive messages until you
        explicitly approve continued spending from your phone. The approval
        dialog shows: total spent today, the budget limit, and options to
        resume with a temporary increase, resume until end of session, or stop.
      </p>
      <p>
        Hard stops are disruptive by design. They exist to prevent the scenario
        where a developer starts a session before lunch, the agent enters a
        retry loop, and by the time the developer returns, $80 has been spent
        on failed attempts.
      </p>

      <h2>Per-Agent vs. Global Budgets</h2>
      <p>
        Global budgets cap total spending across all agents. Per-agent budgets
        let you allocate differently based on cost profiles. A practical setup:
      </p>
      <ul>
        <li>
          Global daily limit: $50 (hard ceiling)
        </li>
        <li>
          Claude Opus 4: $30/day (expensive model, needs tighter control)
        </li>
        <li>
          Claude Sonnet 4: $15/day (cheaper model, more headroom)
        </li>
        <li>
          Codex: $10/day (used less frequently)
        </li>
      </ul>
      <p>
        Per-agent budgets are independent of the global budget. If your Claude
        Opus budget is $30 and your Codex budget is $10, but your global limit
        is $35, the global limit triggers first when total spend across all
        agents hits $35.
      </p>

      <h2>Choosing the Right Thresholds</h2>
      <p>
        Thresholds that are too low create alert fatigue. If your daily budget
        is $10 and you regularly spend $8-9 on productive work, the 80%
        notification fires every day and you start ignoring it.
      </p>
      <p>
        Thresholds that are too high defeat the purpose. A $200 daily budget
        with a hard stop at 100% means you can spend $200 before any
        intervention.
      </p>
      <p>
        A reasonable starting point: set your daily budget to 1.5x your typical
        daily spend. If you normally spend $15/day, set the budget to $22. The
        80% notification fires at $17.60, which is just above your normal range
        but well before dangerous territory. Review and adjust monthly.
      </p>

      <h2>Viewing Budget History</h2>
      <p>
        The Styrby dashboard shows a timeline of budget events: when alerts
        fired, which action was taken, and whether you overrode a hard stop.
        This history is useful for tuning thresholds and for understanding
        which projects or agents drive the most cost.
      </p>
    </>
  );
}
