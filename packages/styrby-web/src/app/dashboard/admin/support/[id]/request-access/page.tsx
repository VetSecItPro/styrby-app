/**
 * Request Support Access Page
 * `/dashboard/admin/support/[id]/request-access`
 *
 * @route GET /dashboard/admin/support/[id]/request-access
 * @auth Required — site admin only, enforced by:
 *   1. `src/middleware.ts` — 404 for non-site-admins
 *   2. `src/app/dashboard/admin/layout.tsx` — redirects non-site-admins
 *   3. `admin_request_support_access` RPC — SECURITY DEFINER enforces is_site_admin()
 * SOC 2 CC6.1.
 *
 * Purpose:
 *   Server Component that:
 *   1. Resolves the ticket (to get user_id and verify it exists).
 *   2. Loads the last 30 days of sessions for the ticket's user (dropdown scope).
 *   3. Loads active/pending grants for this ticket (context display).
 *   4. Renders the RequestSupportAccessForm with the bound server action.
 *
 * WHY server component + dedicated page (not inline dialog):
 *   - Fetching ticket + user sessions server-side avoids a client-side loading
 *     state and race conditions.
 *   - A dedicated URL is bookmarkable and works with Next.js server actions
 *     redirect pattern cleanly.
 *   - Avoids the complexity of a dialog-within-client-component triggering a
 *     server action with server-side data dependencies.
 *
 * WHY session scope is enforced here (not just in the form):
 *   The session dropdown is built from a query filtered by ticket.user_id.
 *   An admin physically cannot select a session belonging to another user from
 *   this UI. The RPC provides defence-in-depth by raising 22023 if the
 *   session_id doesn't belong to the ticket's user.
 */

import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { createAdminClient } from '@/lib/supabase/server';
import { RequestSupportAccessForm, type SelectableSession } from '@/components/admin/RequestSupportAccessForm';
import { requestSupportAccessAction } from '@/app/dashboard/admin/support/[id]/actions';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestAccessPageProps {
  params: Promise<{ id: string }>;
}

/** Shape of a support_access_grants row for display. */
interface ExistingGrant {
  id: number;
  session_id: string;
  status: string;
  expires_at: string;
  requested_at: string;
  reason: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Formats a session row into a SelectableSession for the dropdown.
 *
 * @param session - Raw session row from Supabase.
 * @returns SelectableSession with a human-readable label.
 */
function formatSession(session: {
  id: string;
  agent_type: string;
  created_at: string;
  status: string;
}): SelectableSession {
  const date = new Date(session.created_at).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const agentLabel =
    session.agent_type.charAt(0).toUpperCase() + session.agent_type.slice(1).replace(/_/g, ' ');
  const statusTag = session.status !== 'active' ? ` (${session.status})` : '';
  return {
    id: session.id,
    label: `${agentLabel} — ${date}${statusTag}`,
  };
}

// ─── Page ─────────────────────────────────────────────────────────────────────

/**
 * Request support access form page.
 *
 * Resolves the ticket to get the user_id, fetches the user's recent sessions
 * for the dropdown, and renders the RequestSupportAccessForm.
 *
 * @param params - Next.js 15 async route params (id = ticket UUID).
 */
export default async function RequestAccessPage({ params }: RequestAccessPageProps) {
  const { id: ticketId } = await params;

  if (!UUID_REGEX.test(ticketId)) {
    notFound();
  }

  // WHY createAdminClient (service role): support_tickets may have RLS policies
  // that restrict reads to the ticket owner. The admin needs service-role to
  // look up the ticket's user_id. SOC 2 CC6.1.
  const adminDb = createAdminClient();

  // ── 1. Resolve the ticket ──────────────────────────────────────────────────
  const { data: ticket } = await adminDb
    .from('support_tickets')
    .select('id, user_id, subject, status')
    .eq('id', ticketId)
    .maybeSingle();

  if (!ticket) {
    notFound();
  }

  // ── 2. Fetch user's sessions (last 30 days) ────────────────────────────────
  // WHY 30 days: balances recency (support is usually about recent sessions)
  // with coverage (some issues need context from older sessions in the window).
  // WHY service role: sessions are RLS-scoped to auth.uid(). Admin reads require
  // service-role to bypass the user-owns-row check. SOC 2 CC6.1.
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: rawSessions } = await adminDb
    .from('sessions')
    .select('id, agent_type, created_at, status')
    .eq('user_id', ticket.user_id)
    .gte('created_at', thirtyDaysAgo)
    .order('created_at', { ascending: false })
    .limit(50);

  const sessions: SelectableSession[] = (rawSessions ?? []).map(formatSession);

  // ── 3. Load existing grants for this ticket ────────────────────────────────
  // WHY show existing grants: admin needs context to avoid duplicate requests
  // and to see if a pending grant is already awaiting user approval.
  const { data: rawGrants } = await adminDb
    .from('support_access_grants')
    .select('id, session_id, status, expires_at, requested_at, reason')
    .eq('ticket_id', ticketId)
    .order('requested_at', { ascending: false })
    .limit(10);

  const existingGrants: ExistingGrant[] = (rawGrants ?? []) as ExistingGrant[];

  // ── 4. Bind the server action to the trusted ticket ID ────────────────────
  // WHY bind (Fix B pattern from Phase 4.1 T6): the URL ticket ID is bound
  // server-side so the action can cross-check it as an unforgeable reference.
  const boundAction = requestSupportAccessAction.bind(null, ticketId);

  return (
    <div className="mx-auto max-w-2xl">
      {/* Back link */}
      <Link
        href={`/dashboard/admin/support/${ticketId}`}
        className="mb-6 inline-flex items-center gap-2 text-sm text-zinc-400 transition-colors hover:text-zinc-100"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to ticket
      </Link>

      <h1 className="mb-1 text-xl font-bold text-zinc-100">Request session access</h1>
      <p className="mb-1 text-sm text-zinc-400">
        Ticket: <span className="font-medium text-zinc-200">{ticket.subject}</span>
      </p>
      <p className="mb-6 text-sm text-zinc-400">
        The user will be notified and must approve before you can view session metadata.
        No message content is ever accessible — metadata only.
      </p>

      {/* Existing grants context */}
      {existingGrants.length > 0 && (
        <div className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <h2 className="mb-3 text-sm font-semibold text-zinc-300">
            Existing grants for this ticket
          </h2>
          <div className="space-y-2">
            {existingGrants.map((grant) => {
              const isActive = grant.status === 'approved' && new Date(grant.expires_at) > new Date();
              const isPending = grant.status === 'pending';
              const statusColor = isActive
                ? 'text-green-400'
                : isPending
                ? 'text-amber-400'
                : 'text-zinc-500';

              return (
                <div
                  key={grant.id}
                  className="flex items-start justify-between gap-4 rounded-lg border border-zinc-800 px-3 py-2"
                  data-testid={`existing-grant-${grant.id}`}
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs font-mono text-zinc-500">
                      Session: {grant.session_id.slice(0, 8)}...
                    </p>
                    <p className="mt-0.5 truncate text-xs text-zinc-400">
                      {grant.reason.slice(0, 60)}{grant.reason.length > 60 ? '…' : ''}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <span className={`text-xs font-medium ${statusColor}`}>
                      {grant.status}
                    </span>
                    <p className="text-xs text-zinc-500">
                      Expires {new Date(grant.expires_at).toLocaleDateString()}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Form */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
        <RequestSupportAccessForm
          sessions={sessions}
          action={boundAction}
          backHref={`/dashboard/admin/support/${ticketId}`}
        />
      </div>
    </div>
  );
}
