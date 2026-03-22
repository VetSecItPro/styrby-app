/**
 * Article: Tracking AI Spend Per Project With Session Tags
 * Category: use-case
 */
export default function TrackingAiSpendPerProject() {
  return (
    <>
      <p>
        Freelancers and agencies using AI coding agents on client projects face
        a practical billing question: how much AI cost belongs to each client?
        Without a way to label sessions by project, AI expenses become overhead
        that erodes margins. With session tags, they become a pass-through cost
        or a line item in project estimates.
      </p>

      <h2>The Attribution Problem</h2>
      <p>
        AI provider billing dashboards show total usage, not per-project
        breakdowns. Your Anthropic bill says you spent $340 this month. It does
        not say you spent $180 on the e-commerce client, $120 on the fintech
        client, and $40 on internal tooling.
      </p>
      <p>
        Manual attribution means tracking every session start and end, noting
        the project, and cross-referencing with billing data. This is tedious
        and error-prone, especially when you switch between projects multiple
        times per day.
      </p>

      <h2>How Styrby Handles This: Tags and Project Paths</h2>
      <p>
        Styrby stores two pieces of context for every session: the working
        directory (project path, auto-detected from where you launched the
        agent) and tags (a flexible text array you control). Together, these
        let you attribute costs to clients or projects after the fact.
      </p>
      <pre>
        <code>{`# Working in /home/dev/clients/acme-ecommerce
styrby connect --agent claude
# → Project path auto-detected: /home/dev/clients/acme-ecommerce

# Add tags for client attribution
styrby connect --agent claude --tags "acme, ecommerce, client-work"`}</code>
      </pre>
      <p>
        Every token cost from that session carries those tags. When you switch
        to a different project directory and start a new session, the new path
        is recorded automatically.
      </p>

      <h2>Filtering Sessions by Tag</h2>
      <p>
        The session history page lets you filter by tags, agent type, date
        range, and cost. To see all work for a specific client:
      </p>
      <table>
        <thead>
          <tr>
            <th>Session</th>
            <th>Tags</th>
            <th>Agent</th>
            <th>Cost</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Refactor auth module</td>
            <td>acme, ecommerce</td>
            <td>Claude</td>
            <td>$4.30</td>
            <td>Mar 18</td>
          </tr>
          <tr>
            <td>Add payment webhooks</td>
            <td>acme, ecommerce</td>
            <td>Codex</td>
            <td>$2.15</td>
            <td>Mar 19</td>
          </tr>
          <tr>
            <td>Fix cart edge cases</td>
            <td>acme, ecommerce</td>
            <td>Claude</td>
            <td>$6.80</td>
            <td>Mar 20</td>
          </tr>
        </tbody>
      </table>
      <p>
        Filter by the &quot;acme&quot; tag and you can see every session, its
        cost, and its agent. Add up the costs for that client and you have your
        attribution number.
      </p>

      <h2>Export for Invoicing</h2>
      <p>
        Cost data exports to CSV or JSON for inclusion in invoices or expense
        reports:
      </p>
      <pre>
        <code>{`# Export monthly costs filtered by tag
styrby costs export --tag acme \\
  --period 2026-03 \\
  --format csv \\
  --output acme-march-2026.csv

# Export all sessions for the month
styrby costs export --period 2026-03 --format json`}</code>
      </pre>
      <p>
        The CSV export includes: date, tags, project path, agent, model, input
        tokens, output tokens, cache tokens, and total cost. This level of
        detail lets clients see exactly what they are paying for, which builds
        trust.
      </p>

      <h2>Setting Budget Alerts</h2>
      <p>
        When you know a client project has a fixed AI budget, set an alert so
        you get notified before you exceed it:
      </p>
      <pre>
        <code>{`# Set a monthly budget alert
styrby budget set \\
  --period monthly --limit 250 \\
  --notify-at 80 --stop-at 100`}</code>
      </pre>
      <p>
        Budget alerts apply globally or per agent. Combined with session tags,
        you can monitor your total spend and then use tag-based filtering to
        see how much of that spend belongs to each client.
      </p>

      <h2>Billing Strategies</h2>
      <p>
        How freelancers and agencies handle AI costs varies:
      </p>
      <ul>
        <li>
          <strong>Pass-through at cost.</strong> Bill the exact AI spend to the
          client. Transparent, but some clients push back on variable costs they
          do not fully understand.
        </li>
        <li>
          <strong>Pass-through with markup.</strong> Bill AI spend plus 15-25%.
          Covers your Styrby subscription and the overhead of managing the
          tools.
        </li>
        <li>
          <strong>Included in hourly rate.</strong> Increase your hourly rate
          by $5-10 to cover average AI costs. Simpler for clients, but you
          absorb the risk of expensive sessions.
        </li>
        <li>
          <strong>Fixed AI budget per project.</strong> Estimate AI costs during
          project scoping and include a line item. Use budget alerts to stay
          within the estimate.
        </li>
      </ul>
      <p>
        Regardless of strategy, tagging sessions by client gives you the data
        you need. You cannot make informed billing decisions without knowing
        what each engagement actually costs.
      </p>

      <h2>When This Matters Most</h2>
      <p>
        Cost attribution becomes critical when AI costs are a meaningful
        percentage of project revenue. If you charge $5,000 for a project and
        AI costs are $50, tracking is a nice-to-have. If AI costs are $500,
        that is 10% of revenue and you need to manage it actively.
      </p>
      <p>
        As AI agents get more capable and developers use them more heavily,
        per-engagement AI costs will continue to grow. The developers who tag
        and track this now will have the data and processes in place when it
        matters even more.
      </p>
    </>
  );
}
