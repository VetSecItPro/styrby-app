/**
 * Tests for review/helpers — orchestrator refactor follow-up.
 *
 * Pure functions extracted from `app/review/[id].tsx`. No React, no Supabase.
 *
 * @module components/review/__tests__/helpers
 */

import { rowToReview, computeTotals } from '../helpers';
import type { CodeReviewRow, ReviewFile } from '@/types/review';

describe('rowToReview', () => {
  const baseRow: CodeReviewRow = {
    id: 'review-1',
    session_id: 'session-1',
    status: 'pending',
    summary: 'Initial summary',
    git_branch: 'feat/example',
    files: [],
    comments: [],
    created_at: '2026-04-20T00:00:00.000Z',
  };

  it('maps snake_case columns to camelCase fields', () => {
    expect(rowToReview(baseRow)).toEqual({
      id: 'review-1',
      sessionId: 'session-1',
      status: 'pending',
      summary: 'Initial summary',
      gitBranch: 'feat/example',
      files: [],
      comments: [],
      createdAt: '2026-04-20T00:00:00.000Z',
    });
  });

  it('coerces null summary and git_branch to undefined', () => {
    const row: CodeReviewRow = { ...baseRow, summary: null, git_branch: null };
    const result = rowToReview(row);
    expect(result.summary).toBeUndefined();
    expect(result.gitBranch).toBeUndefined();
  });

  it('defaults missing files / comments arrays to empty arrays', () => {
    // WHY: Supabase JSONB columns can occasionally be returned as null when the
    // row was inserted before the default `[]` migration. The mapper guards
    // against that so consumers always get an array.
    const row = { ...baseRow, files: undefined as unknown as ReviewFile[], comments: undefined as never };
    const result = rowToReview(row as CodeReviewRow);
    expect(result.files).toEqual([]);
    expect(result.comments).toEqual([]);
  });

  it('preserves files and comments arrays when populated', () => {
    const files: ReviewFile[] = [
      { path: 'a.ts', additions: 1, deletions: 0, diff: '', language: 'ts' } as ReviewFile,
    ];
    const result = rowToReview({ ...baseRow, files });
    expect(result.files).toBe(files);
  });
});

describe('computeTotals', () => {
  const file = (additions: number, deletions: number): ReviewFile =>
    ({ path: 'x', additions, deletions, diff: '', language: 'ts' }) as ReviewFile;

  it('returns zeros for empty files array', () => {
    expect(computeTotals([])).toEqual({ additions: 0, deletions: 0 });
  });

  it('sums additions and deletions across files', () => {
    expect(computeTotals([file(3, 1), file(0, 2), file(5, 0)])).toEqual({
      additions: 8,
      deletions: 3,
    });
  });

  it('handles single-file input', () => {
    expect(computeTotals([file(7, 4)])).toEqual({ additions: 7, deletions: 4 });
  });

  it('treats large counts without overflow', () => {
    expect(computeTotals([file(1_000_000, 999_999)])).toEqual({
      additions: 1_000_000,
      deletions: 999_999,
    });
  });
});
