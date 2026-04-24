/**
 * SessionPrivacyBanner — Yellow warning banner shown on a session detail page
 * when an active support_access_grant exists for that session.
 *
 * Phase 4.2 — Support Tooling T7
 *
 * WHY Server Component (no 'use client'):
 *   The banner only needs to show up on initial page load. There is no
 *   interactive state beyond the revoke form submission, which is handled by a
 *   server action (POST → revalidatePath → banner disappears). Keeping this as a
 *   Server Component means zero client-side JS is shipped for this feature —
 *   critical for session pages that are already JS-heavy from the chat thread.
 *
 * WHY defense-in-depth user_id filter even though RLS is active:
 *   Supabase RLS on support_access_grants already enforces
 *   `user_id = auth.uid()`. We still add `.eq('user_id', user.id)` explicitly
 *   so that: (a) the intent is self-documenting for code reviewers, (b) the
 *   query remains correct if the table is ever queried without RLS
 *   (e.g., in a service-role context by mistake), and (c) it satisfies
 *   SOC 2 CC6.1 defense-in-depth requirements.
 *
 * SOC 2 CC7.2 — Access control change events:
 *   Every revoke action is audited by the `user_revoke_support_access` SECURITY
 *   DEFINER RPC, which writes to audit_log. The banner surfaces the current
 *   access state to the user so they can make an informed revocation decision.
 *
 * @module components/support/SessionPrivacyBanner
 */

import { createClient } from '@/lib/supabase/server';
import { revokeAction } from '@/app/support/access/[grantId]/actions';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Props for the SessionPrivacyBanner component.
 */
export interface SessionPrivacyBannerProps {
  /**
   * The Supabase UUID of the session being viewed.
   * Used to query support_access_grants for this specific session.
   */
  sessionId: string;
}

/**
 * Shape of a support_access_grant row as returned by the query.
 * We only select the columns needed for the banner display.
 */
interface ActiveGrant {
  id: number;
  granted_by: string;
  access_count: number;
  max_access_count: number | null;
  expires_at: string;
  approved_at: string | null;
  status: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Fetches active support access grants for the given session and renders a
 * yellow warning banner if any are found. Returns null if no active grant exists.
 *
 * The banner shows:
 *   - A warning icon + "Support has active read access to this session"
 *   - "Viewed N times. Expires at T."
 *   - A revoke button that calls the user_revoke_support_access RPC.
 *
 * Multiple active grants: only the one with the latest `expires_at` is shown
 * (most relevant to the user — the longest-lived active access window).
 *
 * @param props - Component props containing the session ID.
 * @returns Yellow warning banner JSX or null if no active grant exists.
 *
 * @example
 * // In the session detail page (Server Component):
 * <SessionPrivacyBanner sessionId={params.id} />
 */
export async function SessionPrivacyBanner({ sessionId }: SessionPrivacyBannerProps) {
  // ── 1. Auth check ──────────────────────────────────────────────────────────
  // WHY: We need the user's ID for the defense-in-depth filter. If the user is
  // not authenticated, the session detail page would have already redirected —
  // but we guard here defensively to avoid a null-dereference.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    // Authenticated session is enforced by the parent page; this is a safety net.
    return null;
  }

  // ── 2. Query active grants ─────────────────────────────────────────────────
  // WHY .in('status', ['approved']): only show the banner for actively approved
  // grants. Pending grants have not been approved by the user yet — they are
  // surfaced via the /support/access/[grantId] page instead. Revoked/expired/
  // consumed grants no longer represent active access.
  //
  // WHY .gt('expires_at', now): prune server-side so expired grants that have not
  // yet been cleaned up by the background job do not show a stale banner.
  //
  // WHY .eq('user_id', user.id): defense-in-depth on top of RLS. See module JSDoc.
  const { data: grants, error } = await supabase
    .from('support_access_grants')
    .select('id, granted_by, access_count, max_access_count, expires_at, approved_at, status')
    .eq('session_id', sessionId)
    .eq('user_id', user.id)
    .in('status', ['approved'])
    .gt('expires_at', new Date().toISOString())
    .order('expires_at', { ascending: false });

  // WHY swallow query errors silently: a DB error querying grants should not
  // crash the session detail page. The session content is the primary value for
  // the user. We degrade gracefully (no banner) and rely on Sentry for alerting.
  if (error || !grants || grants.length === 0) {
    return null;
  }

  // ── 3. Pick the grant with the latest expiry ───────────────────────────────
  // The query is ordered DESC by expires_at so the first element is the longest-
  // lived grant. If a user has multiple overlapping grants (rare), we show the
  // most relevant one (latest expiry = still most actively in-use).
  const grant = grants[0] as ActiveGrant;

  // ── 4. Format display values ───────────────────────────────────────────────
  const expiresAt = new Date(grant.expires_at).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  const viewCount = grant.access_count ?? 0;
  const maxCount = grant.max_access_count;

  // Human-readable viewed count: "Viewed 3 times." or "Viewed 3 / 10 times."
  const viewedLabel =
    maxCount != null
      ? `Viewed ${viewCount} of ${maxCount} times allowed.`
      : `Viewed ${viewCount} time${viewCount !== 1 ? 's' : ''}.`;

  // ── 5. Bind revoke action with grant ID + session ID ──────────────────────
  // WHY .bind(null, grant.id, sessionId): binding both values server-side means
  // FormData cannot override either the grantId or the sessionId. The action
  // uses sessionId to revalidate and redirect back to this session detail page
  // (rather than away to /support/access/[grantId]). SOC 2 CC6.1 / GDPR Art. 7.
  //
  // WHY the void wrapper: Next.js form `action` prop requires `(formData: FormData)
  // => void | Promise<void>`. The revokeAction returns UserSupportAccessActionResult
  // (not void) so we wrap it to satisfy the type. The return value is intentionally
  // discarded — the action handles redirect/revalidatePath internally.
  const boundRevoke = revokeAction.bind(null, grant.id, sessionId);
  const formAction = async (): Promise<void> => {
    await boundRevoke();
  };

  // ── 6. Render ──────────────────────────────────────────────────────────────
  return (
    <div
      role="region"
      aria-label="Support access notice"
      data-testid="session-privacy-banner"
      className="mx-6 mt-4 rounded-xl border border-yellow-500/30 bg-yellow-500/10 px-5 py-4"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        {/* ── Left: icon + text ────────────────────────────────────────────── */}
        <div className="flex items-start gap-3">
          {/* Warning icon */}
          <span
            aria-hidden="true"
            className="mt-0.5 shrink-0 text-yellow-400 text-lg leading-none"
          >
            ⚠️
          </span>

          <div className="space-y-1">
            {/* Headline */}
            <p className="text-sm font-semibold text-yellow-300">
              Support has active read access to this session
            </p>

            {/* View count + expiry */}
            <p className="text-xs text-yellow-400/80">
              {viewedLabel} Expires {expiresAt}.
            </p>
          </div>
        </div>

        {/* ── Right: revoke button ──────────────────────────────────────────── */}
        {/* WHY inline form with server action:
            Using a <form> + action prop is the idiomatic Next.js 15 Server
            Component pattern for mutations. It requires zero client JS and
            triggers a POST (GDPR Art. 7 — no auto-revoke via GET). */}
        <form action={formAction} className="shrink-0">
          <button
            type="submit"
            aria-label="Revoke support access to this session"
            data-testid="revoke-support-access-button"
            className="rounded-lg border border-yellow-500/40 bg-yellow-500/15 px-4 py-2 text-xs font-semibold text-yellow-300 transition-colors hover:border-yellow-500/60 hover:bg-yellow-500/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-yellow-400"
          >
            Revoke support access
          </button>
        </form>
      </div>
    </div>
  );
}
