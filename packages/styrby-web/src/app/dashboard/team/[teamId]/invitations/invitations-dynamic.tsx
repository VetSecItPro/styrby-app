'use client';

/**
 * Lazy-loaded wrapper for InvitationsList and InviteMemberButton.
 *
 * WHY dynamic import:
 *   InvitationsList imports `date-fns` (formatDistanceToNow, isPast) and
 *   lucide-react icons. InviteMemberButton/Modal together add another ~287
 *   lines of client JS. The invitations admin surface is visited by at most a
 *   handful of team owners/admins — deferring it prevents all dashboard users
 *   from paying the download cost. Follows the pattern established in
 *   cost-charts-dynamic.tsx (Phase 1.6.13) and members-dynamic.tsx (Phase 2.3).
 *
 * WHY ssr: false not used:
 *   Neither InvitationsList nor InviteMemberButton rely on browser-only APIs
 *   (no ResizeObserver, no canvas). SSR is safe and provides an initial HTML
 *   render for SEO and fast paint.
 *
 * WHY fixed-dimension skeleton:
 *   The skeleton matches the approximate rendered height of the component
 *   (3-row table + header = ~280 px) to prevent cumulative layout shift (CLS).
 *
 * @module dashboard/team/[teamId]/invitations/invitations-dynamic
 */

import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import type { InvitationRow } from '@/components/team/invitations';

// ============================================================================
// Types
// ============================================================================

interface InvitationsDynamicProps {
  /** All invitations (pending + history) fetched on the server. */
  invitations: InvitationRow[];
  /** Team UUID used by Re-send / Revoke API calls. */
  teamId: string;
}

// ============================================================================
// Skeleton
// ============================================================================

/**
 * Fixed-dimension skeleton for the InvitationsList table.
 * Height approximates a 3-row invitation table to prevent layout shift.
 */
function InvitationsListSkeleton() {
  return (
    <div
      className="rounded-xl border border-border/40 bg-card/60 p-4 space-y-3"
      aria-busy="true"
      aria-label="Loading invitations"
      style={{ minHeight: 280 }}
    >
      {/* Table header skeleton */}
      <div className="flex items-center gap-4 pb-2 border-b border-border/40">
        <div className="h-3 bg-zinc-800 rounded w-32 animate-pulse" />
        <div className="h-3 bg-zinc-800 rounded w-16 animate-pulse" />
        <div className="h-3 bg-zinc-800 rounded w-16 animate-pulse ml-auto" />
      </div>
      {/* Row skeletons */}
      {[1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-4 animate-pulse py-2">
          <div className="h-4 bg-zinc-800 rounded w-48" />
          <div className="h-5 bg-zinc-800 rounded-full w-14" />
          <div className="h-5 bg-zinc-800 rounded-full w-16" />
          <div className="h-3 bg-zinc-800 rounded w-20 ml-auto" />
          <div className="h-8 bg-zinc-800 rounded w-20" />
        </div>
      ))}
    </div>
  );
}

/**
 * Skeleton for the Invite Member button area.
 * Fixed height matches the rendered button to prevent layout shift.
 */
function InviteButtonSkeleton() {
  return (
    <div
      className="h-9 w-36 bg-zinc-800 rounded-lg animate-pulse"
      aria-busy="true"
      aria-label="Loading invite button"
    />
  );
}

// ============================================================================
// Dynamic imports
// ============================================================================

/**
 * Dynamically imported InvitationsList.
 * Defers date-fns + lucide-react until the admin visits the invitations page.
 */
const InvitationsListLazy = dynamic(
  () =>
    import('@/components/team/invitations').then((mod) => ({
      default: mod.InvitationsList,
    })),
  { loading: () => <InvitationsListSkeleton /> },
);

/**
 * Dynamically imported InviteMemberButton.
 * Defers the invite modal JS until the user lands on this admin surface.
 */
const InviteMemberButtonLazy = dynamic(
  () =>
    import('@/components/team/invitations').then((mod) => ({
      default: mod.InviteMemberButton,
    })),
  { loading: () => <InviteButtonSkeleton /> },
);

// ============================================================================
// Components
// ============================================================================

/**
 * Lazy-loaded InvitationsList with skeleton fallback.
 *
 * @param props - Invitations array and team ID from the server component
 */
export function InvitationsListDynamic({ invitations, teamId }: InvitationsDynamicProps) {
  return <InvitationsListLazy invitations={invitations} teamId={teamId} />;
}

/**
 * Lazy-loaded InviteMemberButton with router refresh wired up.
 *
 * WHY useRouter().refresh():
 *   After a successful invite the server-side invitation list is stale.
 *   Next.js App Router's router.refresh() re-fetches Server Component data
 *   without a full page reload.
 *
 * @param props - Team ID for constructing the invite API URL
 */
export function InviteButtonDynamic({ teamId }: { teamId: string }) {
  const router = useRouter();

  /** Called after a successful invite to refresh the server-side list. */
  function handleSuccess() {
    router.refresh();
  }

  return <InviteMemberButtonLazy teamId={teamId} onSuccess={handleSuccess} />;
}
