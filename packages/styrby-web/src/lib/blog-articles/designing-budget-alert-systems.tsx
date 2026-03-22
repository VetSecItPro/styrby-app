/**
 * Article: Designing Budget Alert Systems That Don't Cry Wolf
 * Category: technical
 */
export default function DesigningBudgetAlertSystems() {
  return (
    <>
      <p>
        A budget alert system that fires too often gets ignored. One that fires
        too late is useless. The hard part is not implementing alerts; it is
        tuning them so they fire at the right time with the right action. This
        article covers the design decisions behind Styrby&apos;s budget alert
        system and the tradeoffs between different approaches.
      </p>

      <h2>The Alert Fatigue Problem</h2>
      <p>
        Alert fatigue is well-documented in operations monitoring. PagerDuty
        reports that teams ignore 30% or more of alerts when volume is too
        high. The same dynamic applies to budget alerts: if your daily budget
        is $20 and you regularly spend $18, the 80% notification fires most
        days. After a week, you stop paying attention. The day you actually
        overspend, you miss the alert.
      </p>
      <p>
        The fix is not to remove alerts. It is to ensure every alert carries
        information that requires a decision.
      </p>

      <h2>Graduated Actions</h2>
      <p>
        Styrby uses three alert tiers, each with a different action:
      </p>
      <table>
        <thead>
          <tr>
            <th>Tier</th>
            <th>Default Threshold</th>
            <th>Action</th>
            <th>User Must Act?</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Notify</td>
            <td>80% of budget</td>
            <td>Push notification</td>
            <td>No</td>
          </tr>
          <tr>
            <td>Slow Down</td>
            <td>90% of budget</td>
            <td>10s delay between responses</td>
            <td>No (but creates natural pause)</td>
          </tr>
          <tr>
            <td>Hard Stop</td>
            <td>100% of budget</td>
            <td>Session pauses</td>
            <td>Yes (must approve to continue)</td>
          </tr>
        </tbody>
      </table>
      <p>
        The key insight: each tier escalates the disruption. Notify is
        informational. Slow Down is a gentle nudge. Hard Stop requires explicit
        action. A developer who ignores the notification will notice the
        slowdown. One who ignores the slowdown will be stopped.
      </p>

      <h2>Period-Based vs. Rolling Windows</h2>
      <p>
        Budget alerts can reset on a fixed period (daily at midnight, weekly
        on Monday) or use a rolling window (last 24 hours, last 7 days). Each
        has tradeoffs.
      </p>

      <h3>Period-Based (What Styrby Uses)</h3>
      <p>
        Budgets reset at a fixed time. A daily budget of $25 resets at midnight
        in the user&apos;s configured timezone.
      </p>
      <ul>
        <li>
          <strong>Pro:</strong> Easy to understand. &quot;I can spend $25
          today&quot; is clear.
        </li>
        <li>
          <strong>Pro:</strong> Aligns with billing cycles. Monthly budgets
          match monthly invoices.
        </li>
        <li>
          <strong>Con:</strong> Boundary exploitation. A user can spend $25 at
          11:59 PM and $25 at 12:01 AM, effectively spending $50 in 2 minutes.
        </li>
      </ul>

      <h3>Rolling Windows</h3>
      <p>
        A &quot;daily&quot; rolling budget looks at the last 24 hours from now,
        not from midnight to midnight.
      </p>
      <ul>
        <li>
          <strong>Pro:</strong> No boundary exploitation. $25 in 24 hours means
          $25 in any 24-hour window.
        </li>
        <li>
          <strong>Con:</strong> Harder to reason about. &quot;How much can I
          still spend today?&quot; depends on when you spent yesterday.
        </li>
        <li>
          <strong>Con:</strong> More expensive to compute. Checking a rolling
          window requires summing all cost records in the window for every
          check.
        </li>
      </ul>

      <h3>Why We Chose Period-Based</h3>
      <p>
        The boundary exploitation problem sounds bad in theory. In practice, it
        rarely matters. Developers do not intentionally game their own budget
        alerts. The mental simplicity of &quot;daily budget resets at
        midnight&quot; outweighs the theoretical precision of rolling windows.
      </p>
      <p>
        We also considered the implementation cost. Period-based budgets need
        one sum query per period: <code>SELECT SUM(cost) WHERE date =
        today</code>. Rolling windows need a range query for every check. With
        BRIN indexes on the timestamp column, both are fast, but period-based
        is simpler to cache and debug.
      </p>

      <h2>Threshold Tuning</h2>
      <p>
        How do you set the right budget? Too low and you hit alerts constantly.
        Too high and the alerts never fire when they should.
      </p>
      <p>Our recommendation for new users:</p>
      <ol>
        <li>
          Run for one week without budget limits. Just track costs.
        </li>
        <li>
          Calculate your average daily spend and the standard deviation.
        </li>
        <li>
          Set the daily budget at average + 2 standard deviations. This means
          the budget only triggers on genuinely unusual days.
        </li>
        <li>
          Review monthly and adjust as usage patterns change.
        </li>
      </ol>
      <p>
        Example: if your average daily spend is $12 with a standard deviation
        of $4, set the budget at $20. The notify alert at 80% ($16) fires on
        high-spend days. The hard stop at 100% ($20) fires only on unusually
        expensive days.
      </p>

      <h2>Multiple Budget Scopes</h2>
      <p>
        Styrby supports budgets at multiple levels:
      </p>
      <ul>
        <li>
          <strong>Global:</strong> Total spend across all agents and projects
        </li>
        <li>
          <strong>Per-agent:</strong> Separate limits for expensive vs. cheap
          models
        </li>
        <li>
          <strong>Per-session:</strong> Limit any single session&apos;s cost
        </li>
      </ul>
      <p>
        These scopes are evaluated independently. A per-session limit of $10
        can fire even if the daily budget is nowhere near its limit. This
        catches runaway individual sessions without affecting the overall budget.
      </p>

      <h2>Database Design for Budget Checking</h2>
      <p>
        Budget checks happen frequently (after every agent message), so they
        need to be fast. Styrby uses a materialized view for daily cost
        summaries:
      </p>
      <pre>
        <code>{`-- Materialized view refreshed every 5 minutes
CREATE MATERIALIZED VIEW mv_daily_cost_summary AS
SELECT
  user_id,
  agent_type,
  project,
  date_trunc('day', recorded_at) AS day,
  SUM(total_cost_usd) AS total_cost,
  COUNT(*) AS record_count
FROM cost_records
WHERE recorded_at >= now() - interval '90 days'
GROUP BY user_id, agent_type, project, date_trunc('day', recorded_at);

-- Budget check query (fast, uses materialized view)
SELECT SUM(total_cost) FROM mv_daily_cost_summary
WHERE user_id = $1 AND day = current_date;`}</code>
      </pre>
      <p>
        The tradeoff: materialized views are slightly stale (up to 5 minutes).
        For budget alerts, this delay is acceptable. A 5-minute lag on a daily
        budget means you might overshoot by 5 minutes of spending before the
        alert fires. At typical token costs, that is a few cents.
      </p>

      <h2>What We Would Do Differently</h2>
      <p>
        If starting over, we would add predictive alerts: &quot;at your current
        rate, you will hit your daily budget by 3 PM.&quot; This is more useful
        than threshold alerts for preventing overspend because it gives earlier
        warning. We plan to add this in a future release.
      </p>
    </>
  );
}
