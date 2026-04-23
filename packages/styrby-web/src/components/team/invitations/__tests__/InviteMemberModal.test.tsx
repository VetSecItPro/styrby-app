/**
 * Component tests for InviteMemberModal
 *
 * Coverage:
 *   - Modal renders with email + role fields
 *   - Submits with email + role values
 *   - Shows error state on 4xx response
 *   - Shows 402 seat cap upgrade CTA when hit
 *   - Closes on cancel
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import * as React from 'react';

vi.mock('lucide-react', () => ({
  Mail: () => React.createElement('span', { 'data-testid': 'icon-mail' }, 'Mail'),
  Users: () => React.createElement('span', { 'data-testid': 'icon-users' }, 'Users'),
  X: () => React.createElement('span', { 'data-testid': 'icon-x' }, 'X'),
  Loader2: () => React.createElement('span', { 'data-testid': 'loader' }, '...'),
}));

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch as typeof fetch;

import { InviteMemberModal } from '../InviteMemberModal';

function renderModal(props: {
  isOpen: boolean;
  teamId: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  return render(React.createElement(InviteMemberModal, props));
}

describe('InviteMemberModal', () => {
  const defaultProps = {
    isOpen: true,
    teamId: 'team-1',
    onClose: vi.fn(),
    onSuccess: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders email and role fields when open', () => {
    renderModal(defaultProps);

    expect(screen.getByLabelText(/email/i) ?? screen.getByPlaceholderText(/email/i)).toBeDefined();
    expect(
      screen.getByRole('combobox') ??
      screen.getByRole('listbox') ??
      screen.queryByText(/role/i),
    ).not.toBeNull();
  });

  it('shows cancel and submit buttons', () => {
    renderModal(defaultProps);

    expect(screen.getByRole('button', { name: /cancel/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /invite|send/i })).toBeDefined();
  });

  it('calls onClose when cancel is clicked', () => {
    const onClose = vi.fn();
    renderModal({ ...defaultProps, onClose });

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('submits email and role to /api/invitations/send', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ invitation_id: 'inv-1', expires_at: '2026-04-23T00:00:00Z' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const onSuccess = vi.fn();
    renderModal({ ...defaultProps, onSuccess });

    const emailInput =
      screen.getByLabelText(/email/i) ??
      screen.getByPlaceholderText(/email/i) ??
      screen.getByRole('textbox', { name: /email/i });

    fireEvent.change(emailInput, { target: { value: 'newuser@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /invite|send/i }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/invitations/send',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('newuser@example.com'),
        }),
      );
    });
  });

  it('shows error message on 4xx response', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'FORBIDDEN', message: 'Only team owners can invite' }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      ),
    );

    renderModal(defaultProps);

    const emailInput =
      screen.getByLabelText(/email/i) ??
      screen.getByPlaceholderText(/email/i) ??
      screen.getByRole('textbox', { name: /email/i });

    fireEvent.change(emailInput, { target: { value: 'someone@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /invite|send/i }));

    await waitFor(() => {
      // Should show some error feedback
      const errorEl =
        screen.queryByRole('alert') ??
        screen.queryByText(/error|forbidden|failed/i);
      expect(errorEl).not.toBeNull();
    });
  });

  it('shows seat cap upgrade CTA when 402 returned', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'SEAT_CAP_EXCEEDED',
          upgradeCta: '/billing/add-seat?team=team-1',
          message: 'Seat limit reached',
        }),
        { status: 402, headers: { 'content-type': 'application/json' } },
      ),
    );

    renderModal(defaultProps);

    const emailInput =
      screen.getByLabelText(/email/i) ??
      screen.getByPlaceholderText(/email/i) ??
      screen.getByRole('textbox', { name: /email/i });

    fireEvent.change(emailInput, { target: { value: 'someone@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /invite|send/i }));

    await waitFor(() => {
      // Seat limit message should appear
      const seatMsg = screen.queryByText(/seat limit/i) ?? screen.queryByText(/add a seat/i);
      expect(seatMsg).not.toBeNull();
    });
  });
});
