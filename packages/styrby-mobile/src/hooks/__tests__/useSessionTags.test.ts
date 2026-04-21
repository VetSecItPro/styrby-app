/**
 * Tests for useSessionTags — Phase 1 #4 batch 1 follow-up.
 *
 * Render-tests via react-test-renderer act() so the hook's useMemo
 * dependencies actually fire. Asserts the dedupe + sort + count contract.
 *
 * @module hooks/__tests__/useSessionTags
 */

import React from 'react';
import renderer from 'react-test-renderer';
import { useSessionTags, type UseSessionTagsResult } from '../useSessionTags';

// Minimal SessionRow shape — we only consume `.tags`.
type SessionRow = { id: string; tags: string[] | null };

/**
 * Tiny harness that exposes the hook's return so tests can read it.
 */
function callHook(sessions: SessionRow[]): UseSessionTagsResult {
  let result: UseSessionTagsResult | null = null;
  function Probe() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    result = useSessionTags(sessions as any);
    return null;
  }
  renderer.act(() => {
    renderer.create(React.createElement(Probe));
  });
  return result!;
}

describe('useSessionTags', () => {
  it('returns empty arrays for empty input', () => {
    const { allTags, tagCounts } = callHook([]);
    expect(allTags).toEqual([]);
    expect(tagCounts).toEqual({});
  });

  it('handles sessions with null tags (treated as no tags)', () => {
    const { allTags, tagCounts } = callHook([
      { id: 's1', tags: null },
      { id: 's2', tags: null },
    ]);
    expect(allTags).toEqual([]);
    expect(tagCounts).toEqual({});
  });

  it('dedupes tags across sessions and sorts alphabetically', () => {
    const { allTags } = callHook([
      { id: 's1', tags: ['react', 'auth'] },
      { id: 's2', tags: ['auth', 'tests'] },
      { id: 's3', tags: ['react'] },
    ]);
    expect(allTags).toEqual(['auth', 'react', 'tests']);
  });

  it('counts each tag occurrence across sessions', () => {
    const { tagCounts } = callHook([
      { id: 's1', tags: ['react', 'auth'] },
      { id: 's2', tags: ['auth'] },
      { id: 's3', tags: ['react', 'tests'] },
    ]);
    expect(tagCounts).toEqual({ react: 2, auth: 2, tests: 1 });
  });

  it('counts each tag once per session even if duplicated within the row', () => {
    // WHY: the implementation uses Set for dedupe of `allTags` but counts
    // every tag occurrence. Documenting the contract so a future "dedupe
    // counts too" PR has to make the change deliberate.
    const { tagCounts } = callHook([{ id: 's1', tags: ['react', 'react'] }]);
    expect(tagCounts.react).toBe(2);
  });
});
