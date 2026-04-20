/**
 * Tests for PasskeysPage — settings/account/passkeys
 *
 * Covers:
 * - Initial render: loading state, then empty state
 * - List render: active passkeys shown, revoked passkeys hidden under details
 * - Add passkey: happy path (challenge -> attestation -> verify -> refresh)
 * - Add passkey: user cancels (NotAllowedError shows graceful message)
 * - Add passkey: already registered (InvalidStateError)
 * - Revoke: calls supabase update, card moves to revoked section
 * - Rename: inline edit flow, save via button
 * - Rename: cancel restores original name
 * - Error states: fetch failure, revoke failure
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PasskeysPage from '../page';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockSelect = vi.fn();
const mockUpdate = vi.fn();
const mockGetSession = vi.fn();

// Supabase client mock
vi.mock('@/lib/supabase/client', () => ({
  createClient: vi.fn(() => ({
    auth: { getSession: mockGetSession },
    from: vi.fn((table: string) => {
      if (table === 'passkeys') {
        return {
          select: vi.fn().mockReturnThis(),
          order: mockSelect,
          update: vi.fn(() => ({
            eq: mockUpdate,
          })),
          eq: vi.fn().mockReturnThis(),
        };
      }
      return {};
    }),
  })),
}));

// @simplewebauthn/browser mock
// WHY vi.hoisted: vi.mock is hoisted to the top of the file by vitest, so
// any variable referenced inside the factory must also be hoisted. Defining
// the mock fn via vi.hoisted() ensures it is initialized before the mock
// factory runs.
const { mockStartRegistration } = vi.hoisted(() => ({
  mockStartRegistration: vi.fn(),
}));
vi.mock('@simplewebauthn/browser', () => ({
  startRegistration: mockStartRegistration,
  startAuthentication: vi.fn(),
}));

// Fetch mock helper
function mockFetchSequence(responses: Array<{ ok: boolean; json: unknown }>) {
  let callIndex = 0;
  global.fetch = vi.fn().mockImplementation(() => {
    const r = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    return Promise.resolve({
      ok: r.ok,
      json: () => Promise.resolve(r.json),
      text: () => Promise.resolve(JSON.stringify(r.json)),
    });
  }) as typeof fetch;
}

// Sample passkey rows
const sampleActive = {
  id: 'pk-001',
  credential_id: 'cred-abc',
  device_name: 'MacBook Pro',
  transports: ['internal'],
  created_at: '2026-01-15T10:00:00Z',
  last_used_at: '2026-04-01T08:00:00Z',
  revoked_at: null,
};

const sampleRevoked = {
  id: 'pk-002',
  credential_id: 'cred-def',
  device_name: 'Old iPhone',
  transports: ['internal'],
  created_at: '2025-12-01T10:00:00Z',
  last_used_at: null,
  revoked_at: '2026-03-01T10:00:00Z',
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe('PasskeysPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGetSession.mockResolvedValue({
      data: { session: { access_token: 'test-token' } },
    });
  });

  it('shows loading state initially', () => {
    // Never resolves during this test
    mockSelect.mockReturnValue(new Promise(() => {}));

    render(<PasskeysPage />);
    expect(screen.getByText(/loading passkeys/i)).toBeTruthy();
  });

  it('shows empty state when no passkeys', async () => {
    mockSelect.mockResolvedValue({ data: [], error: null });

    render(<PasskeysPage />);

    await waitFor(() => {
      expect(screen.getByText(/no passkeys registered yet/i)).toBeTruthy();
    });
  });

  it('renders active passkeys list', async () => {
    mockSelect.mockResolvedValue({ data: [sampleActive], error: null });

    render(<PasskeysPage />);

    await waitFor(() => {
      expect(screen.getByText('MacBook Pro')).toBeTruthy();
    });
  });

  it('renders revoked passkeys under collapsed section', async () => {
    mockSelect.mockResolvedValue({ data: [sampleActive, sampleRevoked], error: null });

    render(<PasskeysPage />);

    await waitFor(() => {
      expect(screen.getByText(/1 revoked passkey/i)).toBeTruthy();
    });
  });

  it('shows error when passkey fetch fails', async () => {
    mockSelect.mockResolvedValue({ data: null, error: { message: 'DB error' } });

    render(<PasskeysPage />);

    await waitFor(() => {
      expect(screen.getByText(/failed to load passkeys/i)).toBeTruthy();
    });
  });

  it('enrolls a new passkey successfully', async () => {
    mockSelect
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({ data: [sampleActive], error: null });

    mockFetchSequence([
      { ok: true, json: { challenge: 'reg-challenge', user: {} } },
      { ok: true, json: { success: true, credentialId: 'new-cred' } },
    ]);

    mockStartRegistration.mockResolvedValue({ id: 'new-cred', type: 'public-key' });

    render(<PasskeysPage />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /add a passkey/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: /add a passkey/i }));

    await waitFor(() => {
      expect(screen.getByText(/passkey added successfully/i)).toBeTruthy();
    });

    expect(mockStartRegistration).toHaveBeenCalledOnce();
  });

  it('shows graceful message when user cancels enrollment', async () => {
    mockSelect.mockResolvedValue({ data: [], error: null });

    mockFetchSequence([{ ok: true, json: { challenge: 'reg-challenge' } }]);

    const cancelError = new Error('User cancelled');
    cancelError.name = 'NotAllowedError';
    mockStartRegistration.mockRejectedValue(cancelError);

    render(<PasskeysPage />);
    await waitFor(() => screen.getByRole('button', { name: /add a passkey/i }));
    fireEvent.click(screen.getByRole('button', { name: /add a passkey/i }));

    await waitFor(() => {
      expect(screen.getByText(/registration cancelled/i)).toBeTruthy();
    });
  });

  it('shows graceful message for already-registered passkey', async () => {
    mockSelect.mockResolvedValue({ data: [], error: null });

    mockFetchSequence([{ ok: true, json: { challenge: 'reg-challenge' } }]);

    const dupError = new Error('Already registered');
    dupError.name = 'InvalidStateError';
    mockStartRegistration.mockRejectedValue(dupError);

    render(<PasskeysPage />);
    await waitFor(() => screen.getByRole('button', { name: /add a passkey/i }));
    fireEvent.click(screen.getByRole('button', { name: /add a passkey/i }));

    await waitFor(() => {
      expect(screen.getByText(/already registered/i)).toBeTruthy();
    });
  });

  it('revokes an active passkey', async () => {
    mockSelect.mockResolvedValue({ data: [sampleActive], error: null });
    mockUpdate.mockResolvedValue({ error: null });

    render(<PasskeysPage />);

    await waitFor(() => screen.getByText('MacBook Pro'));

    const revokeBtn = screen.getByLabelText(/revoke passkey MacBook Pro/i);
    fireEvent.click(revokeBtn);

    await waitFor(() => {
      expect(screen.getByText(/passkey revoked/i)).toBeTruthy();
    });

    expect(mockUpdate).toHaveBeenCalled();
  });

  it('shows error when revoke fails', async () => {
    mockSelect.mockResolvedValue({ data: [sampleActive], error: null });
    mockUpdate.mockResolvedValue({ error: { message: 'DB error' } });

    render(<PasskeysPage />);
    await waitFor(() => screen.getByText('MacBook Pro'));

    fireEvent.click(screen.getByLabelText(/revoke passkey MacBook Pro/i));

    await waitFor(() => {
      expect(screen.getByText(/failed to revoke/i)).toBeTruthy();
    });
  });

  it('renames a passkey', async () => {
    mockSelect.mockResolvedValue({ data: [sampleActive], error: null });
    mockUpdate.mockResolvedValue({ error: null });

    render(<PasskeysPage />);
    await waitFor(() => screen.getByText('MacBook Pro'));

    // Click rename (pencil icon)
    fireEvent.click(screen.getByLabelText(/rename passkey MacBook Pro/i));

    // Should show an input
    const input = screen.getByLabelText(/passkey device name/i);
    expect(input).toBeTruthy();

    fireEvent.change(input, { target: { value: 'Work MacBook' } });
    fireEvent.click(screen.getByLabelText(/save name/i));

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalled();
    });
  });

  it('cancels rename without saving', async () => {
    mockSelect.mockResolvedValue({ data: [sampleActive], error: null });

    render(<PasskeysPage />);
    await waitFor(() => screen.getByText('MacBook Pro'));

    fireEvent.click(screen.getByLabelText(/rename passkey MacBook Pro/i));

    const input = screen.getByLabelText(/passkey device name/i);
    fireEvent.change(input, { target: { value: 'New Name' } });
    fireEvent.click(screen.getByLabelText(/cancel rename/i));

    // Original name still shown, update not called
    expect(screen.getByText('MacBook Pro')).toBeTruthy();
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
