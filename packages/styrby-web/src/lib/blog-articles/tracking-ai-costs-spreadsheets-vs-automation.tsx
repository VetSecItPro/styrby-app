/**
 * Article: Managing AI Agent Costs: Spreadsheets vs. Budget Alerts
 * Category: comparison
 */
export default function TrackingAiCostsSpreadsheetsVsAutomation() {
  return (
    <>
      <p>
        Most developers track AI agent costs one of two ways: they either check
        billing dashboards manually and log expenses in a spreadsheet, or they
        set up automated tracking with threshold alerts. Both approaches work.
        This article compares the effort, accuracy, and failure modes of each.
      </p>

      <h2>The Manual Approach</h2>
      <p>
        The spreadsheet method is straightforward. At the end of each week or
        month, you log into each provider&apos;s billing dashboard, note the
        charges, and enter them into a spreadsheet. If you use multiple agents,
        you repeat this for each provider.
      </p>
      <p>A typical tracking spreadsheet looks like this:</p>
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Provider</th>
            <th>Model</th>
            <th>Cost</th>
            <th>Project</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>2026-03-01</td>
            <td>Anthropic</td>
            <td>Sonnet 4</td>
            <td>$4.20</td>
            <td>api-refactor</td>
          </tr>
          <tr>
            <td>2026-03-01</td>
            <td>OpenAI</td>
            <td>GPT-4o</td>
            <td>$2.80</td>
            <td>api-refactor</td>
          </tr>
          <tr>
            <td>2026-03-02</td>
            <td>Anthropic</td>
            <td>Opus 4</td>
            <td>$18.50</td>
            <td>db-migration</td>
          </tr>
        </tbody>
      </table>

      <h3>What Works</h3>
      <ul>
        <li>
          <strong>Free.</strong> Spreadsheets cost nothing.
        </li>
        <li>
          <strong>Flexible.</strong> You can add columns, formulas, and charts
          however you want.
        </li>
        <li>
          <strong>Full control.</strong> No dependency on third-party tools.
        </li>
      </ul>

      <h3>What Breaks</h3>
      <ul>
        <li>
          <strong>Delayed visibility.</strong> You find out you overspent after
          the fact. A runaway session on Friday night shows up in the
          spreadsheet on Monday.
        </li>
        <li>
          <strong>Manual effort scales poorly.</strong> One developer using one
          agent: fine. Five developers using three agents each means fifteen
          billing dashboards to check.
        </li>
        <li>
          <strong>No per-session granularity.</strong> Billing dashboards show
          daily or monthly totals. You cannot see that one 4-hour Opus session
          cost $45 while ten short Sonnet sessions cost $3 total.
        </li>
        <li>
          <strong>No alerts.</strong> There is no mechanism to tell you when
          spending exceeds a threshold.
        </li>
      </ul>

      <h2>The Automated Approach</h2>
      <p>
        Automated tracking captures token usage as sessions run. Each message
        exchange records the input tokens, output tokens, cache tokens, and
        calculated cost. Budget alerts fire when spending crosses defined
        thresholds.
      </p>
      <p>
        Styrby implements this with three alert levels:
      </p>
      <ul>
        <li>
          <strong>Notify.</strong> Push notification when you hit 80% of your
          daily budget. No session interruption.
        </li>
        <li>
          <strong>Slow down.</strong> At 90%, the system adds a delay between
          agent responses, giving you time to decide whether the session is
          productive.
        </li>
        <li>
          <strong>Hard stop.</strong> At 100% of budget, the session pauses
          until you explicitly approve continued spending.
        </li>
      </ul>

      <h3>What Works</h3>
      <ul>
        <li>
          <strong>Visibility as costs accumulate.</strong> You see spending
          grow across the day, not days later.
        </li>
        <li>
          <strong>Automatic alerts.</strong> No need to remember to check
          dashboards.
        </li>
        <li>
          <strong>Per-session detail.</strong> Know exactly which session and
          which agent is driving costs. Tags let you filter by client or
          project.
        </li>
        <li>
          <strong>Scales with team size.</strong> Adding developers does not
          add manual work.
        </li>
      </ul>

      <h3>What Costs You</h3>
      <ul>
        <li>
          <strong>Subscription fee.</strong> Styrby Pro is $24/month. That is
          the cost of the tool that helps you control costs on the tools you
          are tracking. The math only works if your AI spend is high enough to
          justify it.
        </li>
        <li>
          <strong>Setup time.</strong> Installing the CLI, connecting agents,
          and configuring budget thresholds takes 15-30 minutes initially.
        </li>
        <li>
          <strong>Another dependency.</strong> One more tool in your stack. If
          Styrby is down, you lose automated tracking until it recovers.
        </li>
      </ul>

      <h2>The Breakeven Point</h2>
      <p>
        If your total AI agent spend is under $50/month, manual tracking is
        fine. The amounts are small enough that even a runaway session cannot
        cause serious financial damage. A quick check of billing dashboards
        once a week takes five minutes.
      </p>
      <p>
        Above $100/month, automated tracking starts paying for itself. A
        single Opus session that runs for six hours unattended can easily cost
        $50-100. One prevented runaway pays for months of Styrby Pro.
      </p>
      <p>
        For teams, the math is clearer. Five developers at $200/month each is
        $1,000/month in AI costs. Spending $24/month for visibility into that
        $1,000 is a straightforward decision.
      </p>

      <h2>A Practical Middle Ground</h2>
      <p>
        You do not need to choose one approach exclusively. Some developers use
        automated tracking for real-time alerts and still maintain a monthly
        spreadsheet for their own records. The spreadsheet serves as a personal
        archive; the automated system serves as the real-time safety net.
      </p>
    </>
  );
}
