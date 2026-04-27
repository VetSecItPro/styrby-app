import type { Metadata } from "next";
import { PrevNext } from "../prev-next";
import { getPrevNext } from "../nav";

export const metadata: Metadata = {
  title: "Dashboard Guide",
  description: "Navigate the Styrby dashboard: costs, sessions, agent status, and settings.",
};

/**
 * Dashboard Guide page. Overview of all dashboard sections.
 */
export default function DashboardGuidePage() {
  const { prev, next } = getPrevNext("/docs/dashboard");

  return (
    <article>
      <h1 className="text-3xl font-bold tracking-tight text-foreground">
        Dashboard Guide
      </h1>
      <p className="mt-3 text-muted-foreground">
        The web dashboard at{" "}
        <code className="rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground/75">
          styrbyapp.com/dashboard
        </code>{" "}
        is your control center for all connected agents and machines.
      </p>

      {/* Overview */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="overview">Overview</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        The main dashboard shows a live summary of your account:
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-6 text-sm text-muted-foreground">
        <li>Active agents across all paired machines</li>
        <li>Today&apos;s total cost and token usage</li>
        <li>Recent sessions with status indicators</li>
        <li>Budget alert status (if configured)</li>
      </ul>
      <p className="mt-2 text-sm text-muted-foreground">
        Agent status and session feeds update in real time via Supabase
        Realtime subscriptions. Cost charts and analytics refresh on each
        page load from materialized views.
      </p>

      {/* Cost Analytics */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="cost-analytics">
        Cost Analytics
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Navigate to <strong className="text-foreground/75">Costs</strong> in the sidebar.
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-6 text-sm text-muted-foreground">
        <li>
          <strong className="text-foreground/75">Daily cost chart:</strong> Bar chart of spending
          over the last 30 days. Powered by the{" "}
          <code className="rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground/75">
            mv_daily_cost_summary
          </code>{" "}
          materialized view for fast loads.
        </li>
        <li>
          <strong className="text-foreground/75">Cost by agent:</strong> Pie chart breaking down
          spend per agent type.
        </li>
        <li>
          <strong className="text-foreground/75">Cost table:</strong> Detailed per-session cost
          records with input, output, and cache token counts.
        </li>
      </ul>

      <h3 className="mt-6 text-base font-medium text-foreground/90 scroll-mt-20" id="cost-by-tag">Cost by Tag</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Sessions can carry freeform tags (e.g., a client name or project identifier).
        The <strong className="text-foreground/75">Cost by Tag</strong> section on the Cost Analytics
        page aggregates spending across all sessions that share a tag.
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-6 text-sm text-muted-foreground">
        <li>
          <strong className="text-foreground/75">Add tags:</strong> Open any session detail page and
          use the tag editor in the header. Type a tag name and press Enter.
        </li>
        <li>
          <strong className="text-foreground/75">Filter by tag:</strong> On the Sessions list, use the
          tag dropdown to narrow sessions to a specific client or project.
        </li>
        <li>
          <strong className="text-foreground/75">View cost breakdown:</strong> Navigate to Costs. The
          Cost by Tag section shows total spend and session count for each tag,
          sorted by highest cost first.
        </li>
      </ul>
      <p className="mt-2 text-sm text-muted-foreground">
        This is designed for freelancers and agencies who bill multiple clients.
        Tag sessions with client names, then reference the Cost by Tag breakdown
        when generating invoices.
      </p>

      <h3 className="mt-6 text-base font-medium text-foreground/90 scroll-mt-20" id="budget-alerts">Budget Alerts</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Set spending thresholds under Costs &gt; Budget Alerts. Three action
        types:
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="pb-2 pr-4 font-medium text-foreground/75">Action</th>
              <th className="pb-2 font-medium text-foreground/75">Behavior</th>
            </tr>
          </thead>
          <tbody className="text-muted-foreground">
            <tr className="border-b border-border/50">
              <td className="py-2 pr-4 text-xs font-mono text-foreground/75">notify</td>
              <td className="py-2 text-xs">Push notification and email when threshold hit.</td>
            </tr>
            <tr className="border-b border-border/50">
              <td className="py-2 pr-4 text-xs font-mono text-foreground/75">slowdown</td>
              <td className="py-2 text-xs">Rate-limits agent API calls to reduce burn rate.</td>
            </tr>
            <tr>
              <td className="py-2 pr-4 text-xs font-mono text-foreground/75">stop</td>
              <td className="py-2 text-xs">Halts all agent sessions until you manually resume.</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Sessions */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="sessions">Sessions</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        The Sessions page lists all agent sessions, sortable by date, agent,
        cost, or status.
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-6 text-sm text-muted-foreground">
        <li>
          <strong className="text-foreground/75">Filter by agent:</strong> Click any agent badge to
          filter the list.
        </li>
        <li>
          <strong className="text-foreground/75">Filter by status:</strong> Active, completed, or
          errored sessions.
        </li>
        <li>
          <strong className="text-foreground/75">Session detail:</strong> Click a session to see
          the full encrypted chat thread, token timeline, and a summary tab
          with key metrics.
        </li>
        <li>
          <strong className="text-foreground/75">Bookmarks:</strong> Star important sessions for
          quick access later.
        </li>
      </ul>

      {/* Agent Status */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="agent-status-cards">
        Agent Status Cards
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        The Agents page shows a card for each detected agent across all your
        machines. Each card displays:
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-6 text-sm text-muted-foreground">
        <li>Current status (active, idle, error, disconnected)</li>
        <li>Machine name and last seen timestamp</li>
        <li>Current session ID and token count</li>
        <li>Auto-approve and blocked tool configuration</li>
      </ul>

      {/* Settings */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="settings">
        Settings
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Access from the sidebar under Settings. Sections include:
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-6 text-sm text-muted-foreground">
        <li>
          <strong className="text-foreground/75">Profile:</strong> Display name, email, referral
          code.
        </li>
        <li>
          <strong className="text-foreground/75">Notifications:</strong> Push and email preferences,
          quiet hours.
        </li>
        <li>
          <strong className="text-foreground/75">API Keys:</strong> Generate and manage API keys
          (Pro and Growth).
        </li>
        <li>
          <strong className="text-foreground/75">Webhooks:</strong> Configure webhook endpoints and
          event subscriptions.
        </li>
        <li>
          <strong className="text-foreground/75">Prompt Templates:</strong> Create and manage
          reusable prompt templates for your agents.
        </li>
      </ul>

      <PrevNext prev={prev} next={next} />
    </article>
  );
}
