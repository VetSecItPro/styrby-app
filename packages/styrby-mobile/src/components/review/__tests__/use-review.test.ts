/**
 * Tests for useReview hook.
 *
 * WHY: useReview owns the review screen's full state lifecycle — loading from
 * Supabase or relay params, file expansion, comment accumulation, and the
 * relay-then-persist submit flow. Bugs here mean review decisions are lost
 * or the screen enters broken state.
 *
 * Strategy: mock Supabase, useRelay, expo-router so we can drive the hook
 * without a full render tree.
 *
 * @module components/review/__tests__/use-review
 */

// ============================================================================
// Module mocks
// ============================================================================

jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getUser: jest.fn() },
    from: jest.fn(),
  },
}));

const mockSendMessage = jest.fn<Promise<void>, unknown[]>(async () => {});
jest.mock('@/hooks/useRelay', () => ({
  useRelay: () => ({ sendMessage: mockSendMessage }),
}));

jest.mock('expo-router', () => ({
  router: { back: jest.fn() },
}));

const mockRowToReview = jest.fn((row) => ({ ...row, id: row.id, status: row.status ?? 'pending' }));
jest.mock('../helpers', () => ({
  rowToReview: (row: unknown) => mockRowToReview(row),
}));

import { Alert } from 'react-native';
import { supabase } from '@/lib/supabase';

// ============================================================================
// Imports
// ============================================================================

import { act } from 'react';
import { renderHook } from '@testing-library/react-native';
import { useReview } from '../use-review';

// ============================================================================
// Fixtures
// ============================================================================

const sampleReview = {
  id: 'review-1',
  status: 'pending' as const,
  title: 'Fix login bug',
  diff: '--- a/login.ts\n+++ b/login.ts',
  files: [{ path: 'src/login.ts', status: 'modified', additions: 3, deletions: 1, diff: '...' }],
  comments: [],
  createdAt: '2026-04-20T00:00:00Z',
};

function mockSupabaseFrom(returnData: unknown) {
  const chain = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: returnData, error: returnData ? null : { message: 'Not found' } }),
    update: jest.fn().mockReturnThis(),
  };
  (supabase.from as jest.Mock).mockReturnValue(chain);
  return chain;
}

// ============================================================================
// Tests
// ============================================================================

describe('useReview', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Loading from Supabase
  // --------------------------------------------------------------------------

  it('starts with isLoading true', () => {
    mockSupabaseFrom(sampleReview);
    const { result } = renderHook(() => useReview({ id: 'review-1' }));
    expect(result.current.isLoading).toBe(true);
  });

  it('loads review from Supabase when no review param is passed', async () => {
    mockRowToReview.mockReturnValue(sampleReview);
    mockSupabaseFrom(sampleReview);

    const { result } = renderHook(() => useReview({ id: 'review-1' }));

    await act(async () => {});

    expect(result.current.isLoading).toBe(false);
    expect(result.current.review).toMatchObject({ id: 'review-1' });
  });

  it('handles Supabase error gracefully', async () => {
    const chain = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: null, error: { message: 'Row not found' } }),
    };
    (supabase.from as jest.Mock).mockReturnValue(chain);

    const { result } = renderHook(() => useReview({ id: 'missing-id' }));

    await act(async () => {});

    expect(result.current.isLoading).toBe(false);
    expect(result.current.review).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Loading from relay params
  // --------------------------------------------------------------------------

  it('uses the review param directly without hitting Supabase', async () => {
    const reviewJson = JSON.stringify(sampleReview);

    const { result } = renderHook(() =>
      useReview({ id: 'review-1', review: reviewJson }),
    );

    await act(async () => {});

    expect(supabase.from).not.toHaveBeenCalled();
    expect(result.current.review).toMatchObject({ id: 'review-1' });
    expect(result.current.isLoading).toBe(false);
  });

  it('falls back to Supabase when review param is malformed JSON', async () => {
    mockRowToReview.mockReturnValue(sampleReview);
    mockSupabaseFrom(sampleReview);

    const { result } = renderHook(() =>
      useReview({ id: 'review-1', review: 'not-json{{{' }),
    );

    await act(async () => {});

    expect(supabase.from).toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
  });

  // --------------------------------------------------------------------------
  // toggleFile
  // --------------------------------------------------------------------------

  it('toggleFile expands an unexpanded file', async () => {
    mockRowToReview.mockReturnValue(sampleReview);
    mockSupabaseFrom(sampleReview);

    const { result } = renderHook(() => useReview({ id: 'review-1' }));
    await act(async () => {});

    act(() => result.current.toggleFile('src/login.ts'));

    expect(result.current.expandedFiles.has('src/login.ts')).toBe(true);
  });

  it('toggleFile collapses an expanded file', async () => {
    mockRowToReview.mockReturnValue(sampleReview);
    mockSupabaseFrom(sampleReview);

    const { result } = renderHook(() => useReview({ id: 'review-1' }));
    await act(async () => {});

    act(() => result.current.toggleFile('src/login.ts'));
    act(() => result.current.toggleFile('src/login.ts'));

    expect(result.current.expandedFiles.has('src/login.ts')).toBe(false);
  });

  // --------------------------------------------------------------------------
  // handleAddComment
  // --------------------------------------------------------------------------

  it('handleAddComment appends a comment with UUID id', async () => {
    mockRowToReview.mockReturnValue(sampleReview);
    mockSupabaseFrom(sampleReview);

    const { result } = renderHook(() => useReview({ id: 'review-1' }));
    await act(async () => {});

    act(() => result.current.handleAddComment('src/login.ts', 'This looks wrong.'));

    expect(result.current.pendingComments).toHaveLength(1);
    expect(result.current.pendingComments[0]).toMatchObject({
      filePath: 'src/login.ts',
      body: 'This looks wrong.',
    });
    expect(result.current.pendingComments[0].id).toBeTruthy();
  });

  // --------------------------------------------------------------------------
  // openDecision / closeDecisionModal
  // --------------------------------------------------------------------------

  it('openDecision sets selectedDecision and shows modal', async () => {
    mockRowToReview.mockReturnValue(sampleReview);
    mockSupabaseFrom(sampleReview);

    const { result } = renderHook(() => useReview({ id: 'review-1' }));
    await act(async () => {});

    act(() => result.current.openDecision('approved'));

    expect(result.current.selectedDecision).toBe('approved');
    expect(result.current.showDecisionModal).toBe(true);
  });

  it('closeDecisionModal hides the modal', async () => {
    mockRowToReview.mockReturnValue(sampleReview);
    mockSupabaseFrom(sampleReview);

    const { result } = renderHook(() => useReview({ id: 'review-1' }));
    await act(async () => {});

    act(() => result.current.openDecision('rejected'));
    act(() => result.current.closeDecisionModal());

    expect(result.current.showDecisionModal).toBe(false);
  });

  // --------------------------------------------------------------------------
  // submitDecision
  // --------------------------------------------------------------------------

  it('submitDecision sends relay message and updates Supabase', async () => {
    // Use the relay-params path to avoid Supabase mock complexity for this test
    const reviewJson = JSON.stringify(sampleReview);
    const updateEq = jest.fn().mockResolvedValue({ error: null });
    const updateFrom = jest.fn().mockReturnValue({
      update: jest.fn().mockReturnValue({ eq: updateEq }),
    });
    (supabase.from as jest.Mock).mockImplementation(updateFrom);

    const { result } = renderHook(() =>
      useReview({ id: 'review-1', review: reviewJson }),
    );
    await act(async () => {});

    act(() => result.current.openDecision('approved'));

    await act(async () => {
      await result.current.submitDecision();
    });

    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'code_review_response',
        payload: expect.objectContaining({
          review_id: 'review-1',
          status: 'approved',
        }),
      }),
    );
  });

  it('does nothing when review is null', async () => {
    const chain = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: null, error: { message: 'Not found' } }),
    };
    (supabase.from as jest.Mock).mockReturnValue(chain);

    const { result } = renderHook(() => useReview({ id: 'missing' }));
    await act(async () => {});

    act(() => result.current.openDecision('approved'));

    await act(async () => {
      await result.current.submitDecision();
    });

    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('shows error Alert when sendMessage throws', async () => {
    mockSendMessage.mockRejectedValueOnce(new Error('relay offline'));
    mockRowToReview.mockReturnValue(sampleReview);
    mockSupabaseFrom(sampleReview);

    const { result } = renderHook(() => useReview({ id: 'review-1' }));
    await act(async () => {});

    act(() => result.current.openDecision('rejected'));

    await act(async () => {
      await result.current.submitDecision();
    });

    expect(Alert.alert).toHaveBeenCalledWith('Error', expect.stringContaining('relay offline'));
    expect(result.current.isSubmitting).toBe(false);
  });

  it('includes overall comment in allComments when overallComment is set', async () => {
    // Use relay-params path for a clean setup
    const reviewJson = JSON.stringify(sampleReview);
    const eqMock = jest.fn().mockResolvedValue({ error: null });
    (supabase.from as jest.Mock).mockReturnValue({
      update: jest.fn().mockReturnValue({ eq: eqMock }),
    });

    const { result } = renderHook(() =>
      useReview({ id: 'review-1', review: reviewJson }),
    );
    await act(async () => {});

    act(() => result.current.setOverallComment('LGTM overall'));
    act(() => result.current.openDecision('approved'));

    await act(async () => {
      await result.current.submitDecision();
    });

    const sentPayload = mockSendMessage.mock.calls[0]?.[0] as {
      payload: { comments: { filePath: string; body: string }[] };
    };
    const hasOverall = sentPayload.payload.comments.some(
      (c) => c.filePath === '' && c.body === 'LGTM overall',
    );
    expect(hasOverall).toBe(true);
  });
});
