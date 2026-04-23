'use client';

/**
 * MembersDynamic
 *
 * Client wrapper that owns optimistic member-list state and provides
 * onRoleChanged / onMemberRemoved callbacks to the dynamically imported
 * MembersTable component.
 *
 * WHY this wrapper exists (not inline in page.tsx):
 *   The parent page is a Server Component. Server Components cannot pass
 *   function props (callbacks) to Client Components because functions are
 *   not serialisable across the server/client boundary. This wrapper is the
 *   Client Component boundary — it receives the server-fetched initial members
 *   as a serialisable prop array and manages all interactive state from there.
 *
 * WHY dynamic import here (not in page.tsx):
 *   MembersTable imports lucide-react icons and uses useState for the
 *   confirm-remove dialog. The admin members page is a rare-visit surface.
 *   Dynamic import defers the component bundle until needed, keeping the
 *   shared dashboard chunk lean. Follows the same pattern as
 *   cost-charts-dynamic.tsx (Phase 1.6.13).
 *
 * WHY ssr: false not used here (unlike cost-charts):
 *   MembersTable has no browser-only APIs — it only uses fetch and React
 *   state. SSR is safe and gives an initial render with server-side HTML.
 *
 * @module dashboard/team/[teamId]/members/members-dynamic
 */

import { useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import type { TeamMemberAdminRow } from '@styrby/shared';

// ============================================================================
// Props
// ============================================================================

interface MembersDynamicProps {
  /** Initial member list fetched on the server. */
  initialMembers: TeamMemberAdminRow[];
  /** The authenticated user's ID (to disable self-mutation controls). */
  currentUserId: string;
  /** The authenticated user's role in this team. */
  currentUserRole: 'owner' | 'admin' | 'member';
  /** The team ID — used to construct API call URLs in MembersTable. */
  teamId: string;
}

// ============================================================================
// Skeleton
// ============================================================================

/** Skeleton shown while the MembersTable JS bundle is loading. */
function MembersTableSkeleton() {
  return (
    <div className="p-6 space-y-3" aria-busy="true" aria-label="Loading members">
      {[1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-4 animate-pulse">
          <div className="w-8 h-8 rounded-full bg-zinc-800" />
          <div className="flex-1 space-y-1">
            <div className="h-3 bg-zinc-800 rounded w-40" />
            <div className="h-2.5 bg-zinc-800 rounded w-28" />
          </div>
          <div className="h-5 bg-zinc-800 rounded-full w-16 hidden md:block" />
          <div className="h-3 bg-zinc-800 rounded w-20 hidden lg:block" />
          <div className="h-3 bg-zinc-800 rounded w-14 hidden lg:block" />
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// Dynamic import
// ============================================================================

const MembersTableLazy = dynamic(
  () => import('@/components/team/members').then((mod) => ({ default: mod.MembersTable })),
  { loading: () => <MembersTableSkeleton /> },
);

// ============================================================================
// Component
// ============================================================================

/**
 * Client boundary component that owns member list state.
 *
 * Provides optimistic update callbacks to MembersTable so role changes and
 * removals are reflected immediately without a full page reload.
 *
 * @param props - Initial server-fetched data + current user identity
 */
export function MembersDynamic({
  initialMembers,
  currentUserId,
  currentUserRole,
  teamId,
}: MembersDynamicProps) {
  // WHY useState with initialMembers: mutations (role change, remove) update
  // local state optimistically so the UI reflects changes immediately without
  // a full server-side re-render. The source of truth is always the API;
  // on error the component shows a toast and leaves state unchanged.
  const [members, setMembers] = useState<TeamMemberAdminRow[]>(initialMembers);

  /**
   * Updates a member's role in local state after a successful API call.
   *
   * @param userId - The member whose role changed
   * @param newRole - The new role value
   */
  const handleRoleChanged = useCallback((userId: string, newRole: 'admin' | 'member') => {
    setMembers((prev) =>
      prev.map((m) => (m.user_id === userId ? { ...m, role: newRole } : m)),
    );
  }, []);

  /**
   * Removes a member from local state after a successful API call.
   *
   * @param userId - The member to remove
   */
  const handleMemberRemoved = useCallback((userId: string) => {
    setMembers((prev) => prev.filter((m) => m.user_id !== userId));
  }, []);

  return (
    <MembersTableLazy
      members={members}
      currentUserId={currentUserId}
      currentUserRole={currentUserRole}
      teamId={teamId}
      onRoleChanged={handleRoleChanged}
      onMemberRemoved={handleMemberRemoved}
    />
  );
}
