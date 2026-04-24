/**
 * /support/access/[grantId] — User-facing support access grant approval page.
 *
 * Phase 4.2 — Support Tooling T5
 *
 * This Server Component is the entry point for the magic-link flow: when a
 * support admin requests access to a session, the user receives a notification
 * linking to this page where they can Approve, Deny, or Revoke the grant.
 *
 * Rendering contract:
 *   - `pending`  → show full grant details + Approve / Deny buttons.
 *   - `approved` → show access info (count, expiry) + Revoke button.
 *   - `revoked`  → terminal message (revoked_at timestamp).
 *   - `consumed` → terminal message (cap reached, last_accessed_at).
 *   - `expired`  → terminal message (expires_at).
 *   - not found (0 rows from RLS) → Next.js `notFound()`.
 *
 * Security:
 *   - Middleware gates /support/access/* — unauthenticated users are redirected
 *     to /login?redirect=/support/access/[grantId].
 *   - Supabase RLS policy `support_access_grants_select_self` restricts SELECT
 *     to grants where user_id = auth.uid(). A user visiting another user's grant
 *     URL gets 0 rows → notFound() — indistinguishable from "not found".
 *   - The raw access token is NEVER selected, displayed, or logged here.
 *     We SELECT only the non-sensitive metadata columns (no token_hash, no raw).
 *   - Actions are bound server-side via `.bind(null, grantId)` so the grantId
 *     cannot be tampered through client-side FormData.
 *
 * GDPR Art. 7 (Freely given consent):
 *   No query-param auto-approve (e.g. `?action=approve`). The user must
 *   explicitly click "Approve access" which triggers a server action POST.
 *   GET requests cannot trigger server actions.
 *
 * SOC 2 CC6.1: access requires authenticated session + RLS ownership check.
 * SOC 2 CC7.2: every grant mutation is audited by SECURITY DEFINER RPCs.
 *
 * @module app/support/access/[grantId]/page
 */

import { notFound } from 'next/navigation';
import { CheckCircle, Clock, ShieldOff, XCircle, AlertTriangle } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import { approveAction, revokeAction } from './actions';
import { GrantApprovalCard } from '@/components/support/GrantApprovalCard';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A support_access_grant row fetched for the user-facing page.
 *
 * WHY these exact columns:
 *   - `token_hash` is excluded — never displayed to the user.
 *   - `granted_by` is excluded — user sees "A support staff member" per spec
 *     (admins should not be identifiable to end users through this UI).
 *   - We include `access_count` and `max_access_count` so `approved` state
 *     can show "N of M views used" without a second query.
 */
interface GrantRow {
  id: number;
  ticket_id: string;
  session_id: string;
  status: 'pending' | 'approved' | 'revoked' | 'expired' | 'consumed';
  scope: { fields: string[] };
  expires_at: string;
  requested_at: string;
  approved_at: string | null;
  revoked_at: string | null;
  last_accessed_at: string | null;
  access_count: number;
  max_access_count: number;
  reason: string;
  /** Joined from support_tickets */
  ticket_subject?: string | null;
}

// ─── Route params type ────────────────────────────────────────────────────────

interface PageProps {
  params: Promise<{ grantId: string }>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Formats a date string for user-facing display.
 *
 * @param iso - ISO 8601 date string.
 * @returns Human-readable date + time string in the user's local timezone.
 */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/**
 * Returns the last 8 characters of a UUID for compact session identification.
 *
 * WHY 8 chars: short enough to be scannable, long enough to disambiguate between
 * sessions (1 in 4 billion collision probability for 8 hex chars). The full UUID
 * is always available in the user's session list if needed.
 *
 * @param sessionId - Full UUID string.
 * @returns Last 8 characters with a leading ellipsis.
 */
function shortSessionId(sessionId: string): string {
  return `…${sessionId.slice(-8)}`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/**
 * Renders the grant detail header (ticket subject, session ID, reason, expiry).
 * Shown for all states — it is the full context the user needs to make a decision.
 *
 * WHY we show this even for terminal states: the user may revisit the page after
 * acting (e.g., via browser back). Seeing the context alongside the terminal
 * status message confirms they are on the correct grant.
 *
 * @param grant - The grant row from Supabase.
 */
function GrantDetails({ grant }: { grant: GrantRow }) {
  return (
    <div className="space-y-4">
      {/* ── Reason card ─────────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
        <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-zinc-500">
          Request details
        </h2>

        <dl className="space-y-3">
          {/* Ticket subject — gives context to which ticket triggered this */}
          {grant.ticket_subject && (
            <div>
              <dt className="text-xs text-zinc-500">Support ticket</dt>
              <dd className="mt-0.5 text-sm text-zinc-200">{grant.ticket_subject}</dd>
            </div>
          )}

          {/* Session — show only last 8 chars so user can map it to their sessions */}
          <div>
            <dt className="text-xs text-zinc-500">Session</dt>
            <dd className="mt-0.5 font-mono text-sm text-zinc-300">
              {shortSessionId(grant.session_id)}
            </dd>
          </div>

          {/* Reason — admin-provided justification (required, non-empty) */}
          <div>
            <dt className="text-xs text-zinc-500">Reason given</dt>
            <dd className="mt-0.5 text-sm leading-relaxed text-zinc-200">{grant.reason}</dd>
          </div>

          {/* Expiry — when the grant stops being usable even if approved */}
          <div>
            <dt className="text-xs text-zinc-500">Access expires</dt>
            <dd className="mt-0.5 text-sm text-zinc-300">{formatDate(grant.expires_at)}</dd>
          </div>

          {/* Scope — what metadata fields the admin can see */}
          <div>
            <dt className="text-xs text-zinc-500">Data visible to support</dt>
            <dd className="mt-0.5">
              <ul className="flex flex-wrap gap-1.5" aria-label="Accessible data fields">
                {grant.scope.fields.map((field) => (
                  <li
                    key={field}
                    className="rounded-full bg-zinc-800 px-2.5 py-0.5 font-mono text-xs text-zinc-400"
                  >
                    {field}
                  </li>
                ))}
              </ul>
            </dd>
          </div>

          {/* Requested at — when the admin made the request */}
          <div>
            <dt className="text-xs text-zinc-500">Requested</dt>
            <dd className="mt-0.5 text-sm text-zinc-300">{formatDate(grant.requested_at)}</dd>
          </div>
        </dl>
      </div>

      {/*
        Privacy notice — WHY this is here:
        GDPR Art. 13/14 requires data subjects to be informed of the purpose and
        scope of processing. This inline notice is lighter-weight than a modal
        and keeps the context visible during decision-making.
      */}
      <p className="text-xs leading-relaxed text-zinc-500">
        A Styrby support staff member is requesting read-only access to session
        metadata (action names, tool names, timestamps, and token counts).
        Message content is never shared — your session data remains end-to-end
        encrypted. You can revoke access at any time.
      </p>
    </div>
  );
}

// ─── State panels ─────────────────────────────────────────────────────────────

/** Status panel displayed when the grant is pending user action. */
function PendingPanel() {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
      <Clock className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" aria-hidden="true" />
      <div>
        <p className="text-sm font-medium text-amber-300">Awaiting your decision</p>
        <p className="mt-1 text-sm text-amber-300/70">
          A support staff member has requested access. Review the details below and
          approve or deny.
        </p>
      </div>
    </div>
  );
}

/**
 * Status panel for an active (approved) grant.
 *
 * @param grant - The grant row (used for access count + expiry).
 */
function ApprovedPanel({ grant }: { grant: GrantRow }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-green-500/20 bg-green-500/5 p-4">
      <CheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-green-400" aria-hidden="true" />
      <div>
        <p className="text-sm font-medium text-green-300">Access active</p>
        <p className="mt-1 text-sm text-green-300/70">
          Support has viewed this session{' '}
          <strong className="text-green-200">{grant.access_count}</strong> of{' '}
          <strong className="text-green-200">{grant.max_access_count}</strong> allowed times.
          Access expires {formatDate(grant.expires_at)}.
        </p>
      </div>
    </div>
  );
}

/**
 * Status panel when the user has revoked the grant.
 *
 * @param revokedAt - ISO 8601 timestamp of revocation.
 */
function RevokedPanel({ revokedAt }: { revokedAt: string }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-zinc-700 bg-zinc-800/50 p-4">
      <ShieldOff className="mt-0.5 h-5 w-5 shrink-0 text-zinc-400" aria-hidden="true" />
      <div>
        <p className="text-sm font-medium text-zinc-300">Access revoked</p>
        <p className="mt-1 text-sm text-zinc-500">
          You revoked this access on {formatDate(revokedAt)}.
          Support can no longer view the session.
        </p>
      </div>
    </div>
  );
}

/**
 * Status panel when the access cap has been reached (consumed state).
 *
 * @param lastAccessedAt - ISO 8601 timestamp of the last access.
 */
function ConsumedPanel({ lastAccessedAt }: { lastAccessedAt: string | null }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-zinc-700 bg-zinc-800/50 p-4">
      <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-zinc-400" aria-hidden="true" />
      <div>
        <p className="text-sm font-medium text-zinc-300">Access cap reached</p>
        <p className="mt-1 text-sm text-zinc-500">
          The maximum number of views was used
          {lastAccessedAt ? ` at ${formatDate(lastAccessedAt)}` : ''}.
          No further access is possible.
        </p>
      </div>
    </div>
  );
}

/**
 * Status panel when the grant has naturally expired.
 *
 * @param expiresAt - ISO 8601 timestamp of expiry.
 */
function ExpiredPanel({ expiresAt }: { expiresAt: string }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-zinc-700 bg-zinc-800/50 p-4">
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-zinc-400" aria-hidden="true" />
      <div>
        <p className="text-sm font-medium text-zinc-300">Access expired</p>
        <p className="mt-1 text-sm text-zinc-500">
          This access grant expired on {formatDate(expiresAt)} without being used.
        </p>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

/**
 * Server Component: renders the support access grant detail + action UI.
 *
 * Data fetch:
 *   Uses the user-scoped Supabase client (createClient) so RLS enforces that
 *   only the grant owner (user_id = auth.uid()) can SELECT this row. A user
 *   who navigates to a grant they don't own gets 0 rows → notFound().
 *
 * WHY we join support_tickets:
 *   The ticket subject gives the user context to understand WHY this grant
 *   exists without exposing the full ticket conversation.
 *
 * WHY we do NOT select token_hash or granted_by:
 *   token_hash is a security credential — never displayed. granted_by is an
 *   admin UUID which would allow users to identify which admin raised the
 *   request, creating unnecessary privacy exposure. We show "A support staff
 *   member" per spec §4.3.
 *
 * @param params - Next.js dynamic route params (awaited for Next.js 15 async params).
 */
export default async function GrantApprovalPage({ params }: PageProps) {
  // ── Await async params (Next.js 15 pattern) ────────────────────────────────
  const { grantId: grantIdParam } = await params;
  const grantId = parseInt(grantIdParam, 10);

  // WHY validate here: a non-numeric grantId (e.g. from a crafted URL) would
  // produce NaN which Supabase would reject with a runtime error. We short-
  // circuit to notFound() for a cleaner response.
  if (!Number.isInteger(grantId) || grantId <= 0) {
    notFound();
  }

  // ── Fetch grant via user-scoped client (RLS enforced) ────────────────────
  // WHY createClient() (user-scoped): RLS policy `support_access_grants_select_self`
  // enforces user_id = auth.uid(). A wrong user gets 0 rows → notFound().
  // The service-role client would bypass RLS and could expose any user's grant.
  const supabase = await createClient();

  // WHY maybeSingle(): .single() throws if no rows; .maybeSingle() returns null.
  // Both throw if multiple rows match, but the grantId PK guarantees at most 1.
  const { data: grant, error } = await supabase
    .from('support_access_grants')
    .select(
      `
      id,
      ticket_id,
      session_id,
      status,
      scope,
      expires_at,
      requested_at,
      approved_at,
      revoked_at,
      last_accessed_at,
      access_count,
      max_access_count,
      reason,
      support_tickets ( subject )
      `
    )
    .eq('id', grantId)
    .maybeSingle<GrantRow & { support_tickets: { subject: string } | null }>();

  // WHY treat any error as notFound: a PGRST116 (no rows) is the expected 0-row
  // result for non-owned grants. Other errors (e.g., RLS policy error) should
  // not surface internal details to the user — notFound() is the safe response.
  if (error || !grant) {
    notFound();
  }

  // Flatten the ticket join for ergonomic use below.
  const ticketSubject = grant.support_tickets?.subject ?? null;

  // ── Bind actions server-side ───────────────────────────────────────────────
  // WHY .bind(null, grantId): the grantId flows from the URL, not from client
  // FormData. Binding server-side makes it unforgeable — the client component
  // receives a callable that already has the correct grantId embedded.
  const boundApprove = approveAction.bind(null, grantId);
  const boundRevoke = revokeAction.bind(null, grantId);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-lg px-4 py-10 sm:px-6">
      {/* Page header */}
      <div className="mb-6">
        <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-500">
          Styrby
        </p>
        <h1 className="text-xl font-bold text-zinc-100">Support Access Request</h1>
        <p className="mt-1 text-sm text-zinc-400">
          A support staff member has requested read-only access to a session to help
          resolve your support ticket.
        </p>
      </div>

      {/* Status panel — varies by grant.status */}
      <div className="mb-6">
        {grant.status === 'pending' && <PendingPanel />}
        {grant.status === 'approved' && (
          <ApprovedPanel grant={{ ...grant, ticket_subject: ticketSubject }} />
        )}
        {grant.status === 'revoked' && grant.revoked_at && (
          <RevokedPanel revokedAt={grant.revoked_at} />
        )}
        {grant.status === 'consumed' && (
          <ConsumedPanel lastAccessedAt={grant.last_accessed_at} />
        )}
        {grant.status === 'expired' && <ExpiredPanel expiresAt={grant.expires_at} />}
      </div>

      {/* Grant detail — shown for all states for full context */}
      <GrantDetails grant={{ ...grant, ticket_subject: ticketSubject }} />

      {/* Action buttons — only for pending/approved states */}
      {(grant.status === 'pending' || grant.status === 'approved') && (
        <GrantApprovalCard
          status={grant.status}
          approveAction={boundApprove}
          revokeAction={boundRevoke}
        />
      )}

      {/* Footer */}
      <p className="mt-8 text-center text-xs text-zinc-600">
        Grant ID {grantId} &middot; Questions?{' '}
        <a
          href="/dashboard/support"
          className="text-zinc-500 underline-offset-2 hover:text-zinc-400 hover:underline"
        >
          Open a support ticket
        </a>
      </p>
    </div>
  );
}
