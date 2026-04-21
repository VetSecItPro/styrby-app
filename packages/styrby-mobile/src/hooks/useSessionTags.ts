/**
 * useSessionTags — derive unique tags + per-tag counts from a session list.
 *
 * WHY: Tags are user-defined arrays stored on each session row. The
 * Sessions screen needs both the deduplicated alphabetical list (for
 * rendering tag chips) and the per-tag count (for chip labels). Extracting
 * this into a hook keeps the orchestrator focused on layout/state and lets
 * the derivation be unit-tested in isolation.
 */

import { useMemo } from 'react';
import type { SessionRow } from './useSessions';

/**
 * Return value of useSessionTags.
 */
export interface UseSessionTagsResult {
  /** Deduplicated, alphabetically sorted list of all tags across `sessions`. */
  allTags: string[];
  /** Map of tag → count of sessions containing that tag. */
  tagCounts: Record<string, number>;
}

/**
 * Memoised derivation of `allTags` + `tagCounts` from a session list.
 *
 * Recomputes only when the input array reference changes.
 *
 * @param sessions - Session rows to derive tags from
 * @returns The deduped tag list and counts map.
 */
export function useSessionTags(sessions: SessionRow[]): UseSessionTagsResult {
  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const session of sessions) {
      if (session.tags) {
        for (const tag of session.tags) {
          tagSet.add(tag);
        }
      }
    }
    return [...tagSet].sort();
  }, [sessions]);

  const tagCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const session of sessions) {
      if (session.tags) {
        for (const tag of session.tags) {
          counts[tag] = (counts[tag] || 0) + 1;
        }
      }
    }
    return counts;
  }, [sessions]);

  return { allTags, tagCounts };
}
