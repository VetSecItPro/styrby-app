/**
 * Article: Managing AI Agent Costs Across a Dev Team
 * Category: use-case
 */
export default function ManagingAiCostsDevTeam() {
  return (
    <>
      <p>
        When one developer uses AI agents, cost tracking is simple: check your
        billing dashboard. When a team of three or more developers each uses
        different agents on different projects, cost visibility becomes a real
        management problem. This article walks through how Styrby&apos;s Power
        tier handles team cost management.
      </p>

      <h2>The Scenario</h2>
      <p>
        Consider a team of three developers working on a SaaS product:
      </p>
      <ul>
        <li>
          <strong>Developer A</strong> uses Claude Code (Opus 4) for backend
          architecture and database work. Heavy usage, averaging $30/day.
        </li>
        <li>
          <strong>Developer B</strong> uses Claude Code (Sonnet 4) and Codex
          for frontend work. Moderate usage, averaging $12/day.
        </li>
        <li>
          <strong>Developer C</strong> uses Gemini CLI for research and Aider
          for legacy code. Light usage, averaging $6/day.
        </li>
      </ul>
      <p>
        Total team spend: roughly $48/day, or about $1,000/month. At this
        scale, cost management matters, but without aggregated data it is not
        obvious where the money is going.
      </p>

      <h2>Shared Dashboards</h2>
      <p>
        The Power tier includes a team dashboard that aggregates costs across
        all team members. The team lead sees:
      </p>
      <ul>
        <li>Total team spend by day, week, and month</li>
        <li>Per-developer breakdown</li>
        <li>Per-agent breakdown (how much is going to Anthropic vs. OpenAI vs. Google)</li>
        <li>Per-project breakdown (which projects consume the most AI budget)</li>
      </ul>
      <p>
        Individual developers see their own costs and the team total. They do
        not see other developers&apos; individual costs unless the team lead
        enables full visibility. This is a deliberate choice: cost tracking
        should inform, not surveil.
      </p>

      <h2>Per-Developer Attribution</h2>
      <p>
        Every session in Styrby is tied to a user account. When Developer A
        starts a Claude Code session, the costs are attributed to their
        account. The team dashboard rolls these up into per-developer totals.
      </p>
      <p>
        This matters for two reasons:
      </p>
      <ol>
        <li>
          <strong>Budget allocation.</strong> A team lead can set different
          daily budgets for different developers based on their role and typical
          usage. Developer A doing architecture work with Opus needs a higher
          budget than Developer C doing research with Gemini.
        </li>
        <li>
          <strong>Cost optimization.</strong> If one developer consistently
          spends 3x more than peers on similar tasks, that is a signal to
          investigate. They may be using a more expensive model than necessary,
          or their prompts are triggering retry loops.
        </li>
      </ol>

      <h2>Team Budget Alerts</h2>
      <p>
        Budget alerts work at both the individual and team level:
      </p>
      <pre>
        <code>{`# Team-level budget (team lead sets this)
styrby team budget set --period daily --limit 75 \\
  --notify-at 80 --stop-at 100

# Individual budgets (per developer)
styrby team budget set --user dev-a@team.com \\
  --period daily --limit 40

styrby team budget set --user dev-b@team.com \\
  --period daily --limit 20

styrby team budget set --user dev-c@team.com \\
  --period daily --limit 15`}</code>
      </pre>
      <p>
        When Developer A hits their $40 daily limit, they get a notification
        and their sessions pause. The team budget continues to track against
        $75. If Developer B has an unusually expensive day and pushes the team
        total past $75, the team-level alert fires for the team lead.
      </p>

      <h2>Model Selection Guidance</h2>
      <p>
        The team dashboard highlights model usage patterns. A common finding:
        developers default to whatever model they set up initially and never
        change it. Developer A might use Opus 4 for everything, including tasks
        where Sonnet 4 would produce identical results at one-fifth the cost.
      </p>
      <p>
        The dashboard shows cost per model and per task type. If 60% of
        Developer A&apos;s Opus sessions are short tasks (under 20 turns),
        that is a signal that many of those sessions could use Sonnet instead.
        The team lead can share this data without mandating model choices.
      </p>

      <h2>Project Cost Attribution</h2>
      <p>
        When multiple developers work on the same project, their costs are
        aggregated under the project tag. This answers questions like &quot;how
        much AI budget did the checkout-redesign project consume?&quot; across
        all developers and agents.
      </p>
      <p>
        Project attribution requires that developers start sessions with a
        project tag, which happens automatically when the CLI detects a git
        repository:
      </p>
      <pre>
        <code>{`# Project is auto-detected from the git remote
styrby connect --agent claude
# → Project: checkout-redesign (from git remote)

# Or specify manually
styrby connect --agent claude --project checkout-redesign`}</code>
      </pre>

      <h2>Monthly Cost Reports</h2>
      <p>
        The Power tier generates monthly cost reports that can be exported as
        CSV or JSON. These reports include:
      </p>
      <ul>
        <li>Total team spend by agent and model</li>
        <li>Per-developer totals</li>
        <li>Per-project totals</li>
        <li>Budget alert history (how many alerts fired, how many were overridden)</li>
        <li>Model efficiency metrics (cost per session, cost per turn)</li>
      </ul>
      <p>
        For companies that need to justify AI tool spend to management, these
        reports provide the data. &quot;We spent $1,100 on AI agents this month
        across 3 developers and 4 projects&quot; is a more useful conversation
        starter than &quot;our Anthropic bill was $800.&quot;
      </p>

      <h2>What Power Tier Costs</h2>
      <p>
        The Power tier is $59/month for the account, supporting up to 3 team
        members. For a three-person team, that is $59/month for cost visibility
        into $1,000/month of AI spend. The math works if the visibility helps
        you save more than $59 through better model selection, retry loop
        detection, and budget enforcement. For most teams at this spend level,
        it does.
      </p>
    </>
  );
}
