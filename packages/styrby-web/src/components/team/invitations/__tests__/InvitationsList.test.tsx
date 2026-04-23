/**
 * Component tests for InvitationsList
 *
 * Coverage:
 *   - Renders table with correct columns
 *   - Shows pagination when > 50 items
 *   - Shows "pending" status rows with Re-send and Revoke buttons
 *   - Non-pending rows do NOT show action buttons
 *   - "Expires in X" countdown displayed
 *   - Re-send button calls POST /api/invitations/[id]/resend
 *   - Revoke button calls POST /api/invitations/[id]/revoke (after confirm)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import * as React from 'react';

// Mock lucide-react icons to avoid SVG rendering issues in jsdom
vi.mock('lucide-react', () => ({
  Mail: () => React.createElement('span', { 'data-testid': 'icon-mail' }, 'Mail'),
  Users: () => React.createElement('span', { 'data-testid': 'icon-users' }, 'Users'),
  Link: () => React.createElement('span', { 'data-testid': 'icon-link' }, 'Link'),
  Check: () => React.createElement('span', { 'data-testid': 'icon-check' }, 'Check'),
  X: () => React.createElement('span', { 'data-testid': 'icon-x' }, 'X'),
  Trash2: () => React.createElement('span', { 'data-testid': 'icon-trash2' }, 'Trash2'),
  RefreshCw: () => React.createElement('span', { 'data-testid': 'icon-refresh' }, 'Refresh'),
  ChevronLeft: () => React.createElement('span', null, '<'),
  ChevronRight: () => React.createElement('span', null, '>'),
}));

import { InvitationsList } from '../InvitationsList';

// ── Module mocks ─────────────────────────────────────────────────────────────

// Mock Next.js useRouter so we can verify router.refresh() is called.
const mockRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

/** Minimal invitation row data shape for tests. */
interface MockInvitation {
  id: string;
  email: string;
  role: 'admin' | 'member' | 'viewer';
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  invited_at: string;
  expires_at: string;
  team_id: string;
}

function makeInvitation(overrides: Partial<MockInvitation> = {}): MockInvitation {
  return {
    id: 'inv-1',
    email: 'test@example.com',
    role: 'member',
    status: 'pending',
    invited_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    team_id: 'team-1',
    ...overrides,
  };
}

describe('InvitationsList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: fetch succeeds
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    // Default: confirm returns true (user clicks OK)
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
  });

  it('renders the invitations table with correct headers', () => {
    render(
      React.createElement(InvitationsList, {
        invitations: [makeInvitation()],
        teamId: 'team-1',
      }),
    );

    expect(screen.getByText(/email/i)).toBeDefined();
    expect(screen.getByText(/role/i)).toBeDefined();
    expect(screen.getByText(/status/i)).toBeDefined();
  });

  it('shows Re-send and Revoke buttons for pending invitations', () => {
    render(
      React.createElement(InvitationsList, {
        invitations: [makeInvitation({ status: 'pending' })],
        teamId: 'team-1',
      }),
    );

    // Pending rows should have both action buttons
    expect(screen.getByRole('button', { name: /re-send/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /revoke/i })).toBeDefined();
  });

  it('does not show action buttons for accepted invitations', () => {
    render(
      React.createElement(InvitationsList, {
        invitations: [makeInvitation({ status: 'accepted' })],
        teamId: 'team-1',
      }),
    );

    expect(screen.queryByRole('button', { name: /re-send/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /revoke/i })).toBeNull();
  });

  it('shows expires countdown for pending invitation', () => {
    const futureDate = new Date(Date.now() + 3_600_000).toISOString();
    render(
      React.createElement(InvitationsList, {
        invitations: [makeInvitation({ status: 'pending', expires_at: futureDate })],
        teamId: 'team-1',
      }),
    );

    // Should show "expires in X" text somewhere
    const expiresText = screen.queryByText(/expires in/i) ?? screen.queryByText(/expire/i);
    expect(expiresText).not.toBeNull();
  });

  it('shows pagination when more than 50 invitations', () => {
    const manyInvitations = Array.from({ length: 55 }, (_, i) =>
      makeInvitation({ id: `inv-${i}`, email: `user${i}@example.com` }),
    );

    render(
      React.createElement(InvitationsList, {
        invitations: manyInvitations,
        teamId: 'team-1',
      }),
    );

    // With 55 invitations and 50 per page, should show page 1 of 2
    expect(screen.getByText(/page 1/i) ?? screen.queryByText(/next/i)).not.toBeNull();
  });

  it('renders the invitation email in each row', () => {
    render(
      React.createElement(InvitationsList, {
        invitations: [makeInvitation({ email: 'uniqueuser@example.com' })],
        teamId: 'team-1',
      }),
    );

    expect(screen.getByText('uniqueuser@example.com')).toBeDefined();
  });

  /**
   * Re-send button must call POST /api/invitations/[id]/resend directly (not a stub).
   *
   * WHY: Fix 2 moved the fetch call into InvitationsList. This test verifies the
   * actual fetch path is called with the correct URL and method.
   */
  it('Re-send button POSTs to /api/invitations/[id]/resend', async () => {
    const inv = makeInvitation({ id: 'inv-abc123', status: 'pending' });

    render(
      React.createElement(InvitationsList, {
        invitations: [inv],
        teamId: 'team-1',
      }),
    );

    const resendBtn = screen.getByRole('button', { name: /re-send/i });
    fireEvent.click(resendBtn);

    // Allow the async handler to complete
    await vi.waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/invitations/inv-abc123/resend',
        { method: 'POST' },
      );
    });
  });

  /**
   * Revoke button must call POST /api/invitations/[id]/revoke directly (not a stub).
   * Must show a confirmation dialog before issuing the request.
   */
  it('Revoke button shows confirm then POSTs to /api/invitations/[id]/revoke', async () => {
    const inv = makeInvitation({ id: 'inv-xyz789', status: 'pending' });

    render(
      React.createElement(InvitationsList, {
        invitations: [inv],
        teamId: 'team-1',
      }),
    );

    const revokeBtn = screen.getByRole('button', { name: /revoke/i });
    fireEvent.click(revokeBtn);

    // Confirm dialog must have been shown
    expect(window.confirm).toHaveBeenCalled();

    // Fetch must have been called with the correct URL
    await vi.waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/invitations/inv-xyz789/revoke',
        { method: 'POST' },
      );
    });
  });

  it('Revoke button does NOT call fetch when confirm is cancelled', async () => {
    // User clicks "Cancel" in the confirm dialog
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(false));

    const inv = makeInvitation({ id: 'inv-cancel', status: 'pending' });

    render(
      React.createElement(InvitationsList, {
        invitations: [inv],
        teamId: 'team-1',
      }),
    );

    const revokeBtn = screen.getByRole('button', { name: /revoke/i });
    fireEvent.click(revokeBtn);

    // fetch should NOT have been called (user cancelled)
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
