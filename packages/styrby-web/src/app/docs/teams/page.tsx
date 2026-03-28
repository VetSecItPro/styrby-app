import type { Metadata } from "next";
import { PrevNext } from "../prev-next";
import { getPrevNext } from "../nav";

export const metadata: Metadata = {
  title: "Team Management",
  description: "Create teams, invite members, manage roles, and control data visibility in Styrby.",
};

/**
 * Team Management documentation page.
 */
export default function TeamsPage() {
  const { prev, next } = getPrevNext("/docs/teams");

  return (
    <article>
      <h1 className="text-3xl font-bold tracking-tight text-zinc-50">
        Team Management
      </h1>
      <p className="mt-3 text-zinc-400">
        Share cost visibility and agent management across your team. Available
        on the Power tier. Power includes up to 3 team members.
      </p>

      {/* Creating a Team */}
      <h2 className="mt-10 text-xl font-semibold text-zinc-100">
        Creating a Team
      </h2>
      <p className="mt-2 text-sm text-zinc-400">
        Go to Dashboard &gt; Team and click &quot;Create Team&quot;. You
        become the Owner. One team per account; the Owner&apos;s Power
        subscription covers the team.
      </p>

      {/* Inviting Members */}
      <h2 className="mt-10 text-xl font-semibold text-zinc-100">
        Inviting Members
      </h2>
      <p className="mt-2 text-sm text-zinc-400">
        Invite by email from the Team page. The invitee receives an email with
        an invite link. They must create a Styrby account (any tier) to accept.
        Invite links expire after 7 days.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm font-mono text-zinc-300 ring-1 ring-zinc-800">
        <code>{`# Invite link format:
https://styrbyapp.com/invite/<token>

# Token expires after 7 days
# Resend from Dashboard > Team > Pending Invites`}</code>
      </pre>
      <p className="mt-2 text-sm text-zinc-500">
        Invites are tied to the recipient&apos;s email address. An invitation
        addressed to one email cannot be accepted by a different account.
      </p>

      {/* Roles */}
      <h2 className="mt-10 text-xl font-semibold text-zinc-100">Roles</h2>
      <p className="mt-2 text-sm text-zinc-400">
        Three roles are available: owner, admin, and member. Roles are assigned
        per team and enforced by row-level security in the database.
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-left">
              <th className="pb-2 pr-4 font-medium text-zinc-300">Permission</th>
              <th className="pb-2 pr-4 font-medium text-zinc-300 text-center">Owner</th>
              <th className="pb-2 pr-4 font-medium text-zinc-300 text-center">Admin</th>
              <th className="pb-2 font-medium text-zinc-300 text-center">Member</th>
            </tr>
          </thead>
          <tbody className="text-zinc-400">
            <tr className="border-b border-zinc-800/50">
              <td className="py-2 pr-4 text-xs">View own sessions and costs</td>
              <td className="py-2 pr-4 text-xs text-center">Yes</td>
              <td className="py-2 pr-4 text-xs text-center">Yes</td>
              <td className="py-2 text-xs text-center">Yes</td>
            </tr>
            <tr className="border-b border-zinc-800/50">
              <td className="py-2 pr-4 text-xs">View team aggregate costs</td>
              <td className="py-2 pr-4 text-xs text-center">Yes</td>
              <td className="py-2 pr-4 text-xs text-center">Yes</td>
              <td className="py-2 text-xs text-center">Yes</td>
            </tr>
            <tr className="border-b border-zinc-800/50">
              <td className="py-2 pr-4 text-xs">View other members&apos; sessions</td>
              <td className="py-2 pr-4 text-xs text-center">Yes</td>
              <td className="py-2 pr-4 text-xs text-center">Yes</td>
              <td className="py-2 text-xs text-center">No</td>
            </tr>
            <tr className="border-b border-zinc-800/50">
              <td className="py-2 pr-4 text-xs">Invite members</td>
              <td className="py-2 pr-4 text-xs text-center">Yes</td>
              <td className="py-2 pr-4 text-xs text-center">Yes</td>
              <td className="py-2 text-xs text-center">No</td>
            </tr>
            <tr className="border-b border-zinc-800/50">
              <td className="py-2 pr-4 text-xs">Remove regular members</td>
              <td className="py-2 pr-4 text-xs text-center">Yes</td>
              <td className="py-2 pr-4 text-xs text-center">Yes</td>
              <td className="py-2 text-xs text-center">No</td>
            </tr>
            <tr className="border-b border-zinc-800/50">
              <td className="py-2 pr-4 text-xs">Manage team budget alerts</td>
              <td className="py-2 pr-4 text-xs text-center">Yes</td>
              <td className="py-2 pr-4 text-xs text-center">Yes</td>
              <td className="py-2 text-xs text-center">No</td>
            </tr>
            <tr className="border-b border-zinc-800/50">
              <td className="py-2 pr-4 text-xs">Manage API keys and webhooks</td>
              <td className="py-2 pr-4 text-xs text-center">Yes</td>
              <td className="py-2 pr-4 text-xs text-center">Yes</td>
              <td className="py-2 text-xs text-center">No</td>
            </tr>
            <tr className="border-b border-zinc-800/50">
              <td className="py-2 pr-4 text-xs">Change member roles</td>
              <td className="py-2 pr-4 text-xs text-center">Yes</td>
              <td className="py-2 pr-4 text-xs text-center">No</td>
              <td className="py-2 text-xs text-center">No</td>
            </tr>
            <tr>
              <td className="py-2 pr-4 text-xs">Delete team</td>
              <td className="py-2 pr-4 text-xs text-center">Yes</td>
              <td className="py-2 pr-4 text-xs text-center">No</td>
              <td className="py-2 text-xs text-center">No</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-sm text-zinc-500">
        Admins can remove regular members but cannot remove other admins or the
        owner. Admins cannot promote themselves to owner. Any member can remove
        themselves (leave the team).
      </p>

      {/* Data Visibility */}
      <h2 className="mt-10 text-xl font-semibold text-zinc-100">
        Data Visibility
      </h2>
      <p className="mt-2 text-sm text-zinc-400">
        Session message content is always encrypted per-user. Even Owners and
        Admins cannot read other members&apos; session messages. What is shared:
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-6 text-sm text-zinc-400">
        <li>Session metadata: agent, model, duration, token counts, cost</li>
        <li>Aggregate cost data: team total, per-member breakdown</li>
        <li>Agent status: which agents are active on which machines</li>
      </ul>
      <p className="mt-2 text-sm text-zinc-500">
        This design ensures cost accountability across the team while
        preserving individual code privacy.
      </p>

      {/* Removing Members */}
      <h2 className="mt-10 text-xl font-semibold text-zinc-100">
        Removing Members
      </h2>
      <p className="mt-2 text-sm text-zinc-400">
        Owners can remove any member. Admins can remove regular members only,
        not other admins or the owner. Removal takes effect immediately. The
        removed member keeps their individual Styrby account and data, but
        loses access to team views.
      </p>

      <PrevNext prev={prev} next={next} />
    </article>
  );
}
