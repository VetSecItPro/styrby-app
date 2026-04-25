/**
 * Support Access Grant Success Page (Server Component)
 * `/dashboard/admin/support/[id]/request-access/success?grant=<id>`
 *
 * Phase 4.2 — Support Tooling T4
 * Updated 2026-04-25 — SEC-ADV-001 remediation (server-side token pickup).
 *
 * Purpose:
 *   Renders the raw support-grant token exactly once, on the server, by
 *   pulling it from the `support_grant_token_pickup` table via the
 *   `admin_pickup_grant_token` SECURITY DEFINER RPC. The RPC returns the raw
 *   token AND deletes the holding row in a single atomic transaction, so a
 *   subsequent request (page reload, second tab) sees nothing.
 *
 * Why this is a server component (was a client component before):
 *   The previous implementation was `"use client"` and read the token from a
 *   non-HttpOnly cookie via `document.cookie`, then cleared it. That meant the
 *   cookie had to be readable by client JS, which is also reachable by any
 *   same-origin XSS payload during the 60-second window. SEC-ADV-001.
 *
 *   By moving the read to a server component:
 *     - The token never crosses to client-readable cookies / storage.
 *     - The RPC validates is_site_admin(auth.uid()) AND that auth.uid() ==
 *       grant.granted_by — only the admin who issued the grant can render it.
 *     - After first render the holding row is gone; reload yields the fallback.
 *     - The token enters the browser only via the rendered HTML body (visible
 *       to the legitimate admin's eyes) — never via a JS-readable surface.
 *
 *   See migration 057 + actions.ts header for the full architectural rationale.
 *
 * Interactive UI:
 *   The reveal-toggle and copy-to-clipboard controls live in
 *   `TokenDisplay.tsx` (client component) which receives the rawToken as a
 *   prop. That subtree is the only place the token lives in client memory,
 *   and only for the lifetime of the page render. No localStorage,
 *   sessionStorage, cookies, or window globals are used.
 *
 * @param params       Next.js 15 async route params (id = ticket UUID).
 * @param searchParams grant=<grantId> from the redirect URL.
 */

import Link from 'next/link';
import { ArrowLeft, CheckCircle } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import { TokenDisplay } from './TokenDisplay';

// WHY force-dynamic: the page calls a SECURITY DEFINER RPC that mutates state
// (DELETE on the pickup row). Static rendering or any caching would either
// cause the RPC to never fire or to fire at build time — wrong both ways.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ grant?: string }>;
}

/**
 * Server component: pickup the raw token once, render it once, never cache.
 *
 * Failure modes:
 *   - No grantId in URL → fallback "no grant id" message.
 *   - RPC raises 22023  → expired / already consumed (most common case on
 *                         page reload; the row is gone after first render).
 *   - RPC raises 42501  → caller is not the granting admin (or not a site
 *                         admin). Should be unreachable in normal flow because
 *                         middleware gates the route to site admins, but kept
 *                         as a safety branch.
 *   - Any other error   → generic fallback. Specific SQLSTATEs are mapped to
 *                         user-facing strings without leaking RPC internals.
 */
export default async function RequestAccessSuccessPage({
  params,
  searchParams,
}: PageProps) {
  const { id: ticketId } = await params;
  const { grant: grantIdStr } = await searchParams;

  // ── Fetch raw token from the pickup table (one-time, atomic) ───────────────
  let rawToken: string | null = null;
  let pickupError: 'no-grant' | 'expired' | 'unauthorized' | 'unknown' | null = null;

  // Parse the grant id. The query string is admin-supplied (from the action
  // redirect) but we still validate to fail fast on a malformed or absent value.
  // WHY bigint conversion: support_access_grants.id is bigserial. The RPC
  // expects a bigint; we pass a string, and Postgres coerces. We just check
  // it parses as a positive integer to avoid sending '12abc' to the DB.
  const grantIdParsed = grantIdStr ? Number(grantIdStr) : NaN;
  if (!grantIdStr || !Number.isFinite(grantIdParsed) || grantIdParsed <= 0) {
    pickupError = 'no-grant';
  } else {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc('admin_pickup_grant_token', {
      p_grant_id: grantIdParsed,
    });

    if (error) {
      // WHY map by SQLSTATE: admin_pickup_grant_token raises 22023 for "expired
      // or already consumed" (fold-collapsed in the RPC body to prevent oracle
      // attacks) and 42501 for "not the granting admin or not a site admin".
      // We surface these as separate user-facing branches so the admin gets a
      // meaningful "you've already viewed this" vs "you can't view this" hint
      // without leaking grant existence (the RPC already collapsed the
      // non-existent / wrong-owner cases inside 42501).
      if (error.code === '22023') pickupError = 'expired';
      else if (error.code === '42501') pickupError = 'unauthorized';
      else pickupError = 'unknown';
    } else if (typeof data === 'string' && data.length > 0) {
      rawToken = data;
    } else {
      // RPC returned without an error but produced no string — should not
      // happen given the function signature (RETURNS text, raises on miss).
      // Treat as expired to be safe.
      pickupError = 'expired';
    }
  }

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

      {/* Header */}
      <div className="mb-6 flex items-start gap-3">
        <CheckCircle className="mt-0.5 h-6 w-6 shrink-0 text-green-400" />
        <div>
          <h1 className="text-xl font-bold text-zinc-100">Access grant created</h1>
          <p className="mt-1 text-sm text-zinc-400">
            The user will be notified and must approve before you can view session metadata.
          </p>
          {grantIdStr && (
            <p className="mt-1 font-mono text-xs text-zinc-500">
              Grant ID: {grantIdStr}
            </p>
          )}
        </div>
      </div>

      {/* Token display (one-time) */}
      <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-5">
        <p className="mb-1 text-xs font-medium uppercase tracking-wide text-amber-400">
          One-time token — copy it now
        </p>
        <p className="mb-4 text-xs text-zinc-400">
          This token is displayed once and cannot be recovered. Store it securely or
          share it with the user approval link. Reloading this page will not show it again.
        </p>

        {rawToken ? (
          // Client component receives the token as a prop only for this render.
          // No persistence, no global state — props die with the React tree.
          <TokenDisplay rawToken={rawToken} ticketId={ticketId} grantId={grantIdStr ?? null} />
        ) : (
          <div
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm text-zinc-400"
            data-testid="token-gone-message"
          >
            {pickupError === 'no-grant' && (
              <>Missing grant id in URL. Return to the ticket page and create a new grant.</>
            )}
            {pickupError === 'expired' && (
              <>Token is no longer available. It is displayed once when the grant is created and is consumed on first view. If you need to regenerate access, create a new grant from the ticket page.</>
            )}
            {pickupError === 'unauthorized' && (
              <>You do not have permission to view this token. Only the admin who created the grant can retrieve it, and only once.</>
            )}
            {pickupError === 'unknown' && (
              <>Token could not be retrieved. Try creating a new grant from the ticket page.</>
            )}
          </div>
        )}
      </div>

      {/* Next steps */}
      <div className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="mb-2 text-sm font-semibold text-zinc-300">Next steps</h2>
        <ol className="list-inside list-decimal space-y-1.5 text-sm text-zinc-400">
          <li>Copy the token above and store it securely.</li>
          <li>
            Send the approval link to the user via the ticket reply form{' '}
            <Link
              href={`/dashboard/admin/support/${ticketId}`}
              className="text-amber-400 underline-offset-2 hover:underline"
            >
              back on the ticket
            </Link>
            .
          </li>
          <li>Once the user approves, the grant status changes to &quot;approved&quot;.</li>
          <li>
            Use the token at{' '}
            <span className="font-mono text-zinc-300">
              /dashboard/admin/support/session/[sessionId]?grant=...
            </span>{' '}
            to view session metadata (no message content).
          </li>
        </ol>
      </div>
    </div>
  );
}
