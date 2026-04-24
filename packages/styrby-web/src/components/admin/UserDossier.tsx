/**
 * UserDossier — Top-level layout component for the user dossier page.
 *
 * Purpose:
 *   Composes all 5 dossier sub-cards (ProfileCard, SubscriptionCard, TeamsCard,
 *   SessionsCard, RecentAuditCard) into a two-column dense grid layout with a
 *   header row of action buttons (T6 links). Each card is wrapped in its own
 *   React Suspense boundary so cards stream independently.
 *
 * Auth model:
 *   This component is a Server Component rendered inside
 *   `/dashboard/admin/users/[userId]/page.tsx`, which is itself nested under
 *   the admin layout gate. No additional auth check is needed here — the gate
 *   has already confirmed the viewer is a site admin.
 *
 * WHY Suspense per card (parallelism, not sharing):
 *   The spec requires each card to own its own data-fetch, not share a single
 *   prefetched payload. There are two reasons:
 *
 *   1. Independent streaming: React renders each Suspense boundary as soon as
 *      its async Server Component resolves. If ProfileCard resolves in 30ms but
 *      SessionsCard takes 300ms, the admin sees the profile immediately instead
 *      of waiting for the slowest card.
 *
 *   2. No "shared prefetch disguising N+1": A single orchestrator-level fetch
 *      that pre-fetches all data and passes it down avoids round-trips in theory,
 *      but in practice it (a) creates a tight coupling between the orchestrator
 *      and every card's schema, (b) blocks ALL cards on the slowest query, and
 *      (c) is semantically equivalent to N+1 if we later add more cards and
 *      forget to extend the prefetch. Each card owning its own parameterized
 *      query is cleaner, safer, and lets cards evolve independently.
 *
 *   The five card queries fire in parallel at the Node.js layer (Next.js Server
 *   Components run all top-level awaits as concurrent Promises under the hood
 *   when wrapped in Suspense). The apparent "serial card rendering" is only the
 *   fallback UI — actual DB queries happen in parallel.
 *
 * Action buttons:
 *   Override tier, Reset password, Toggle consent — these link to T6 form pages.
 *   They are rendered as links now; T6 implements the form pages themselves.
 *
 * @param userId - Validated UUID passed from the page Server Component.
 * @param userEmail - Email resolved at the page level (for header display).
 */

import Link from 'next/link';
import { Suspense } from 'react';
import { ArrowLeft, UserCog } from 'lucide-react';
import { ProfileCard } from '@/components/admin/dossier/ProfileCard';
import { SubscriptionCard } from '@/components/admin/dossier/SubscriptionCard';
import { TeamsCard } from '@/components/admin/dossier/TeamsCard';
import { SessionsCard } from '@/components/admin/dossier/SessionsCard';
import { RecentAuditCard } from '@/components/admin/dossier/RecentAuditCard';

// ─── Fallback skeleton ────────────────────────────────────────────────────────

/**
 * Pulse-skeleton used as the Suspense fallback for each card.
 *
 * WHY same height as a typical card: Using a fixed height approximates the
 * space the card will occupy, preventing layout shift when the card resolves.
 * A trivially small fallback would cause the grid to reflow on hydration.
 *
 * WHY role="status" + sr-only text: Without this, screen readers announce
 * nothing while the card loads — the user has no way to know content is
 * pending. role="status" is a live region that politely announces its content
 * when it appears. The sr-only span gives the announcement meaningful text.
 * The inner visual skeleton bars stay aria-hidden since they convey no
 * additional information beyond "loading". WCAG 2.1 SC 4.1.3.
 */
function CardSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading card content"
      className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 animate-pulse"
      data-testid="card-skeleton"
    >
      <span className="sr-only">Loading…</span>
      {/* visual skeleton bars — aria-hidden here is fine on the visual children */}
      <div aria-hidden="true" className="space-y-2">
        <div className="h-4 w-1/3 rounded bg-zinc-800" />
        <div className="h-3 w-2/3 rounded bg-zinc-800/60" />
        <div className="h-3 w-1/2 rounded bg-zinc-800/60" />
      </div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export interface UserDossierProps {
  /** Validated UUID of the user being viewed. */
  userId: string;
  /** Email of the user, resolved at the page level from profiles.email. */
  userEmail: string;
}

/**
 * Top-level dossier layout. Each card streams independently via Suspense.
 *
 * @param userId - Validated UUID of the user being viewed.
 * @param userEmail - Email for the page header (avoids re-fetching in the layout).
 */
export function UserDossier({ userId, userEmail }: UserDossierProps) {
  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <Link
          href="/dashboard/admin"
          className="mb-4 inline-flex items-center gap-2 text-sm text-zinc-400 transition-colors hover:text-zinc-100"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to user search
        </Link>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <UserCog className="h-6 w-6 text-zinc-400" aria-hidden="true" />
            <div>
              <h1 className="text-2xl font-bold text-foreground" data-testid="dossier-title">
                {/* WHY JSX text: email is user-supplied data from Supabase.
                    React escapes it — no XSS risk from dangerouslySetInnerHTML. */}
                {userEmail}
              </h1>
              <p className="mt-0.5 font-mono text-xs text-zinc-600">{userId}</p>
            </div>
          </div>

          {/* Action buttons — links to T6 form pages.
              WHY links not forms here: T5 spec says "create the links now,
              T6 implements the form pages." Keeping them as links avoids
              placeholder form markup with no server action attached. */}
          <div className="flex flex-wrap gap-2" data-testid="action-buttons">
            <Link
              href={`/dashboard/admin/users/${userId}/override-tier`}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100"
              data-testid="action-override-tier"
            >
              Override tier
            </Link>
            <Link
              href={`/dashboard/admin/users/${userId}/reset-password`}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100"
              data-testid="action-reset-password"
            >
              Reset password
            </Link>
            <Link
              href={`/dashboard/admin/users/${userId}/toggle-consent`}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100"
              data-testid="action-toggle-consent"
            >
              Toggle consent
            </Link>
          </div>
        </div>
      </div>

      {/* Main grid — two columns on desktop, one on mobile */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Left column */}
        <div className="flex flex-col gap-4">
          {/* ProfileCard — typically the fastest; user wants this first */}
          <Suspense fallback={<CardSkeleton />}>
            {/* WHY: Each card is a separate async Server Component. Wrapping
                each in its own <Suspense> boundary means it streams to the
                client as soon as the card's DB query resolves — independently
                of all other cards. This is the "parallel card streaming" pattern.
                A single Suspense around all cards would make EVERY card wait for
                the slowest one (RecentAuditCard, which does audit + actor lookup).
                SOC 2 CC6.1: data rendered only after admin gate passes. */}
            <ProfileCard userId={userId} />
          </Suspense>

          <Suspense fallback={<CardSkeleton />}>
            <TeamsCard userId={userId} />
          </Suspense>
        </div>

        {/* Right column */}
        <div className="flex flex-col gap-4">
          <Suspense fallback={<CardSkeleton />}>
            <SubscriptionCard userId={userId} />
          </Suspense>

          <Suspense fallback={<CardSkeleton />}>
            <SessionsCard userId={userId} />
          </Suspense>
        </div>
      </div>

      {/* Full-width bottom card — audit log is widest because of the reason column */}
      <div className="mt-4">
        <Suspense fallback={<CardSkeleton />}>
          <RecentAuditCard userId={userId} />
        </Suspense>
      </div>
    </div>
  );
}
