/**
 * Tests for ApprovalRequestCard + useApprovalActions (Phase 2.4)
 *
 * Covers:
 *   - Card renders tool name, risk badge, requester, payload preview, cost, expiry
 *   - "Approve" and "Deny" buttons call onVote with correct arguments
 *   - Buttons are disabled while isVoting is true
 *   - Expired card shows "Expired" label and disabled buttons
 *   - Error banner renders when voteError is provided
 *   - useApprovalActions: approved/denied flows, 409 conflict handling, error states
 *
 * @module components/approvals/__tests__/ApprovalRequestCard
 */

import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react-native';
import { renderHook, act } from '@testing-library/react-hooks';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { ApprovalRequestCard } from '../ApprovalRequestCard';
import { useApprovalActions } from '../useApprovalActions';
import type { ApprovalRequest } from '../ApprovalRequestCard';

// ─── Fixtures ──────────────────────────────────────────────────────────────

const UUID = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

const baseApproval: ApprovalRequest = {
  id: UUID(1),
  teamId: UUID(2),
  toolName: 'Bash',
  estimatedCostUsd: 0.0032,
  requestPayload: { command: 'rm -rf /tmp/build' },
  status: 'pending',
  requesterUserId: UUID(3),
  requesterDisplayName: 'Alice Dev',
  riskLevel: 'high',
  expiresAt: new Date(Date.now() + 900_000).toISOString(),  // 15 min from now
  createdAt: new Date().toISOString(),
};

const expiredApproval: ApprovalRequest = {
  ...baseApproval,
  expiresAt: new Date(Date.now() - 1).toISOString(),  // already past
};

// ─── ApprovalRequestCard tests ─────────────────────────────────────────────

describe('ApprovalRequestCard', () => {
  const onVote = vi.fn();
  const onViewDetails = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the tool name', () => {
    render(
      <ApprovalRequestCard
        approval={baseApproval}
        onVote={onVote}
        onViewDetails={onViewDetails}
      />,
    );
    expect(screen.getByText('Bash')).toBeTruthy();
  });

  it('renders the risk level badge', () => {
    render(
      <ApprovalRequestCard
        approval={baseApproval}
        onVote={onVote}
        onViewDetails={onViewDetails}
      />,
    );
    expect(screen.getByText('High Risk')).toBeTruthy();
  });

  it('renders the requester display name', () => {
    render(
      <ApprovalRequestCard
        approval={baseApproval}
        onVote={onVote}
        onViewDetails={onViewDetails}
      />,
    );
    expect(screen.getByText(/Alice Dev/)).toBeTruthy();
  });

  it('renders the command payload preview', () => {
    render(
      <ApprovalRequestCard
        approval={baseApproval}
        onVote={onVote}
        onViewDetails={onViewDetails}
      />,
    );
    expect(screen.getByText('rm -rf /tmp/build')).toBeTruthy();
  });

  it('renders estimated cost', () => {
    render(
      <ApprovalRequestCard
        approval={baseApproval}
        onVote={onVote}
        onViewDetails={onViewDetails}
      />,
    );
    expect(screen.getByText(/\$0\.0032/)).toBeTruthy();
  });

  it('calls onVote with "approved" when Approve is pressed', () => {
    render(
      <ApprovalRequestCard
        approval={baseApproval}
        onVote={onVote}
        onViewDetails={onViewDetails}
      />,
    );
    fireEvent.press(screen.getByAccessibilityLabel('Approve this tool call approval request'));
    expect(onVote).toHaveBeenCalledOnce();
    expect(onVote).toHaveBeenCalledWith(UUID(1), 'approved');
  });

  it('calls onVote with "denied" when Deny is pressed', () => {
    render(
      <ApprovalRequestCard
        approval={baseApproval}
        onVote={onVote}
        onViewDetails={onViewDetails}
      />,
    );
    fireEvent.press(screen.getByAccessibilityLabel('Deny this tool call approval request'));
    expect(onVote).toHaveBeenCalledWith(UUID(1), 'denied');
  });

  it('disables both buttons while isVoting is true', () => {
    render(
      <ApprovalRequestCard
        approval={baseApproval}
        isVoting={true}
        onVote={onVote}
        onViewDetails={onViewDetails}
      />,
    );
    const approveBtn = screen.getByAccessibilityLabel('Approve this tool call approval request');
    const denyBtn = screen.getByAccessibilityLabel('Deny this tool call approval request');
    expect(approveBtn.props.accessibilityState?.disabled).toBe(true);
    expect(denyBtn.props.accessibilityState?.disabled).toBe(true);
  });

  it('shows "Expired" when expiresAt is in the past', () => {
    render(
      <ApprovalRequestCard
        approval={expiredApproval}
        onVote={onVote}
        onViewDetails={onViewDetails}
      />,
    );
    expect(screen.getByText('Expired')).toBeTruthy();
  });

  it('disables buttons for expired approval', () => {
    render(
      <ApprovalRequestCard
        approval={expiredApproval}
        onVote={onVote}
        onViewDetails={onViewDetails}
      />,
    );
    const approveBtn = screen.getByAccessibilityLabel('Approve this tool call approval request');
    expect(approveBtn.props.accessibilityState?.disabled).toBe(true);
  });

  it('renders voteError banner when voteError is provided', () => {
    render(
      <ApprovalRequestCard
        approval={baseApproval}
        voteError="Forbidden: only team admins may resolve approvals"
        onVote={onVote}
        onViewDetails={onViewDetails}
      />,
    );
    expect(screen.getByText('Forbidden: only team admins may resolve approvals')).toBeTruthy();
  });

  it('calls onViewDetails when the "View details" link is pressed', () => {
    render(
      <ApprovalRequestCard
        approval={baseApproval}
        onVote={onVote}
        onViewDetails={onViewDetails}
      />,
    );
    fireEvent.press(screen.getByAccessibilityLabel('View full approval request details'));
    expect(onViewDetails).toHaveBeenCalledWith(UUID(1));
  });
});

// ─── useApprovalActions tests ──────────────────────────────────────────────

describe('useApprovalActions', () => {
  const mockAccessToken = 'test-jwt-token';
  const getAccessToken = vi.fn().mockResolvedValue(mockAccessToken);
  const onResolved = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Builds a stubbed fetch that returns the given status and body.
   */
  function makeFetch(httpStatus: number, body: Record<string, unknown>): typeof fetch {
    return vi.fn().mockResolvedValue({
      ok: httpStatus >= 200 && httpStatus < 300,
      status: httpStatus,
      json: vi.fn().mockResolvedValue(body),
    }) as unknown as typeof fetch;
  }

  it('sets isVoting to true during the request and false after', async () => {
    let resolvePromise!: () => void;
    const fetchImpl = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        resolvePromise = () => resolve({
          ok: true,
          status: 200,
          json: vi.fn().mockResolvedValue({ approvalId: UUID(1), status: 'approved' }),
        } as unknown as Response);
      }),
    );

    const { result } = renderHook(() =>
      useApprovalActions({ fetchImpl, getAccessToken, onResolved }),
    );

    expect(result.current.isVoting).toBe(false);

    let votePromise: Promise<void>;
    act(() => {
      votePromise = result.current.vote(UUID(1), 'approved');
    });

    expect(result.current.isVoting).toBe(true);

    await act(async () => {
      resolvePromise();
      await votePromise;
    });

    expect(result.current.isVoting).toBe(false);
  });

  it('calls onResolved with the correct approvalId and status on approval', async () => {
    const fetchImpl = makeFetch(200, { approvalId: UUID(1), status: 'approved', reason: 'LGTM' });

    const { result } = renderHook(() =>
      useApprovalActions({ fetchImpl, getAccessToken, onResolved }),
    );

    await act(async () => {
      await result.current.vote(UUID(1), 'approved', 'LGTM');
    });

    expect(onResolved).toHaveBeenCalledWith(UUID(1), 'approved');
    expect(result.current.voteError).toBeNull();
  });

  it('calls onResolved on denial', async () => {
    const fetchImpl = makeFetch(200, { approvalId: UUID(1), status: 'denied' });

    const { result } = renderHook(() =>
      useApprovalActions({ fetchImpl, getAccessToken, onResolved }),
    );

    await act(async () => {
      await result.current.vote(UUID(1), 'denied', 'Too risky');
    });

    expect(onResolved).toHaveBeenCalledWith(UUID(1), 'denied');
  });

  it('sets voteError on 403 Forbidden (non-admin caller)', async () => {
    const fetchImpl = makeFetch(403, { error: 'Forbidden: only team admins may resolve' });

    const { result } = renderHook(() =>
      useApprovalActions({ fetchImpl, getAccessToken, onResolved }),
    );

    await act(async () => {
      await result.current.vote(UUID(1), 'approved');
    });

    expect(result.current.voteError).toContain('Forbidden');
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('treats 409 (already resolved) as success and calls onResolved', async () => {
    const fetchImpl = makeFetch(409, {
      error: 'Approval is already approved',
      approvalId: UUID(1),
      status: 'approved',
    });

    const { result } = renderHook(() =>
      useApprovalActions({ fetchImpl, getAccessToken, onResolved }),
    );

    await act(async () => {
      await result.current.vote(UUID(1), 'approved');
    });

    // 409 means it was already resolved — the caller's intent was satisfied
    expect(onResolved).toHaveBeenCalled();
    expect(result.current.voteError).toBeNull();
  });

  it('sets voteError on network failure', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('Network timeout')) as unknown as typeof fetch;

    const { result } = renderHook(() =>
      useApprovalActions({ fetchImpl, getAccessToken, onResolved }),
    );

    await act(async () => {
      await result.current.vote(UUID(1), 'approved');
    });

    expect(result.current.voteError).toBe('Network timeout');
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('sets voteError when access token is unavailable', async () => {
    const getTokenFailing = vi.fn().mockResolvedValue(null);

    const { result } = renderHook(() =>
      useApprovalActions({
        fetchImpl: vi.fn() as unknown as typeof fetch,
        getAccessToken: getTokenFailing,
        onResolved,
      }),
    );

    await act(async () => {
      await result.current.vote(UUID(1), 'approved');
    });

    expect(result.current.voteError).toContain('Session expired');
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('clearError resets the voteError to null', async () => {
    const fetchImpl = makeFetch(403, { error: 'Forbidden' });

    const { result } = renderHook(() =>
      useApprovalActions({ fetchImpl, getAccessToken, onResolved }),
    );

    await act(async () => {
      await result.current.vote(UUID(1), 'approved');
    });

    expect(result.current.voteError).not.toBeNull();

    act(() => {
      result.current.clearError();
    });

    expect(result.current.voteError).toBeNull();
  });

  it('prevents double-submit when isVoting is already true', async () => {
    let resolvePromise!: () => void;
    const fetchImpl = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        resolvePromise = () => resolve({
          ok: true,
          status: 200,
          json: vi.fn().mockResolvedValue({ approvalId: UUID(1), status: 'approved' }),
        } as unknown as Response);
      }),
    ) as unknown as typeof fetch;

    const { result } = renderHook(() =>
      useApprovalActions({ fetchImpl, getAccessToken, onResolved }),
    );

    // Start the first vote (don't await yet)
    let p1: Promise<void>;
    act(() => {
      p1 = result.current.vote(UUID(1), 'approved');
    });

    // Immediately try to submit a second vote
    await act(async () => {
      await result.current.vote(UUID(1), 'denied');
    });

    // Resolve the first and wait
    await act(async () => {
      resolvePromise();
      await p1;
    });

    // fetch should only have been called once (second vote was blocked)
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
