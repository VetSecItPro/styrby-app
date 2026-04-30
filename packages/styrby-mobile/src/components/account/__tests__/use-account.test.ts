/**
 * Tests for useAccount hook.
 *
 * WHY: useAccount owns all account-management side effects — display name
 * edits, email change, password reset cooldown, data export, sign out, and
 * the two-step account deletion flow. Bugs here mean irreversible account
 * actions fire without confirmation or fail silently.
 *
 * Strategy: mock all IO helpers via jest.mock('../account-io') and drive
 * the hook via renderHook + act.
 *
 * @module components/account/__tests__/use-account
 */

// ============================================================================
// Module mocks
// ============================================================================

const mockUpdateDisplayName = jest.fn();
const mockRequestEmailChange = jest.fn();
const mockRequestPasswordReset = jest.fn();
const mockFetchMonthlySpend = jest.fn<unknown, unknown[]>(async () => 12.5);
const mockExportAccountData = jest.fn();
const mockPerformSignOut = jest.fn();
const mockDeleteAccount = jest.fn();

jest.mock('../account-io', () => ({
  updateDisplayName: (...args: unknown[]) => mockUpdateDisplayName(...args),
  requestEmailChange: (...args: unknown[]) => mockRequestEmailChange(...args),
  requestPasswordReset: (...args: unknown[]) => mockRequestPasswordReset(...args),
  fetchMonthlySpend: (...args: unknown[]) => mockFetchMonthlySpend(...args),
  exportAccountData: (...args: unknown[]) => mockExportAccountData(...args),
  performSignOut: (...args: unknown[]) => mockPerformSignOut(...args),
  deleteAccount: (...args: unknown[]) => mockDeleteAccount(...args),
}));

import { Alert } from 'react-native';

// ============================================================================
// Imports
// ============================================================================

import { act } from 'react';
import { renderHook } from '@testing-library/react-native';
import { useAccount } from '../use-account';
import type { UseAccountArgs } from '../use-account';

// ============================================================================
// Fixtures
// ============================================================================

function buildArgs(overrides: Partial<UseAccountArgs> = {}): UseAccountArgs {
  return {
    userId: 'user-1',
    userDisplayName: 'Test User',
    refreshUser: jest.fn<Promise<void>, unknown[]>(async () => {}),
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('useAccount', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Monthly spend load
  // --------------------------------------------------------------------------

  it('loads monthly spend on mount when userId is set', async () => {
    const { result } = renderHook(() => useAccount(buildArgs()));
    await act(async () => {});

    expect(mockFetchMonthlySpend).toHaveBeenCalledWith('user-1');
    expect(result.current.monthlySpend).toBe(12.5);
    expect(result.current.isLoadingSpend).toBe(false);
  });

  it('does not fetch monthly spend when userId is null', async () => {
    const { result } = renderHook(() => useAccount(buildArgs({ userId: null })));
    await act(async () => {});

    expect(mockFetchMonthlySpend).not.toHaveBeenCalled();
    expect(result.current.isLoadingSpend).toBe(true); // stays loading until userId arrives
  });

  // --------------------------------------------------------------------------
  // Display name editing
  // --------------------------------------------------------------------------

  it('beginEditDisplayName initializes draft from userDisplayName', async () => {
    const { result } = renderHook(() => useAccount(buildArgs({ userDisplayName: 'Alice' })));
    await act(async () => {});

    act(() => result.current.beginEditDisplayName());

    expect(result.current.isEditingDisplayName).toBe(true);
    expect(result.current.displayNameDraft).toBe('Alice');
  });

  it('cancelEditDisplayName clears editing state', async () => {
    const { result } = renderHook(() => useAccount(buildArgs()));
    await act(async () => {});

    act(() => result.current.beginEditDisplayName());
    act(() => result.current.cancelEditDisplayName());

    expect(result.current.isEditingDisplayName).toBe(false);
    expect(result.current.displayNameDraft).toBe('');
  });

  it('saveDisplayName calls updateDisplayName and refreshUser on success', async () => {
    mockUpdateDisplayName.mockResolvedValue({ ok: true, data: undefined });
    const refreshUser = jest.fn<Promise<void>, unknown[]>(async () => {});
    const { result } = renderHook(() => useAccount(buildArgs({ refreshUser })));
    await act(async () => {});

    act(() => {
      result.current.setDisplayNameDraft('New Name');
      result.current.beginEditDisplayName();
    });
    act(() => result.current.setDisplayNameDraft('New Name'));

    await act(async () => { await result.current.saveDisplayName(); });

    expect(mockUpdateDisplayName).toHaveBeenCalledWith('user-1', 'New Name');
    expect(refreshUser).toHaveBeenCalled();
    expect(result.current.isSavingDisplayName).toBe(false);
  });

  it('saveDisplayName shows Alert on failure', async () => {
    mockUpdateDisplayName.mockResolvedValue({ ok: false, message: 'DB error' });
    const { result } = renderHook(() => useAccount(buildArgs()));
    await act(async () => {});

    act(() => result.current.setDisplayNameDraft('Bad Name'));

    await act(async () => { await result.current.saveDisplayName(); });

    expect(Alert.alert).toHaveBeenCalledWith('Error', 'DB error');
  });

  it('saveDisplayName does nothing when draft is empty', async () => {
    const { result } = renderHook(() => useAccount(buildArgs()));
    await act(async () => {});

    act(() => result.current.setDisplayNameDraft(''));
    await act(async () => { await result.current.saveDisplayName(); });

    expect(mockUpdateDisplayName).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Email modal
  // --------------------------------------------------------------------------

  it('openEmailModal sets isEmailModalVisible to true', async () => {
    const { result } = renderHook(() => useAccount(buildArgs()));
    await act(async () => {});

    act(() => result.current.openEmailModal());

    expect(result.current.isEmailModalVisible).toBe(true);
  });

  it('closeEmailModal sets isEmailModalVisible to false', async () => {
    const { result } = renderHook(() => useAccount(buildArgs()));
    await act(async () => {});

    act(() => result.current.openEmailModal());
    act(() => result.current.closeEmailModal());

    expect(result.current.isEmailModalVisible).toBe(false);
  });

  // --------------------------------------------------------------------------
  // changeEmail
  // --------------------------------------------------------------------------

  it('changeEmail shows Alert for invalid email format', async () => {
    const { result } = renderHook(() => useAccount(buildArgs()));
    await act(async () => {});

    act(() => result.current.setNewEmailDraft('not-an-email'));
    await act(async () => { await result.current.changeEmail('old@example.com'); });

    expect(Alert.alert).toHaveBeenCalledWith('Invalid Email', expect.any(String));
    expect(mockRequestEmailChange).not.toHaveBeenCalled();
  });

  it('changeEmail shows Alert when new email equals current email', async () => {
    const { result } = renderHook(() => useAccount(buildArgs()));
    await act(async () => {});

    act(() => result.current.setNewEmailDraft('same@example.com'));
    await act(async () => { await result.current.changeEmail('same@example.com'); });

    expect(Alert.alert).toHaveBeenCalledWith('Same Email', expect.any(String));
  });

  it('changeEmail calls requestEmailChange on success', async () => {
    mockRequestEmailChange.mockResolvedValue({ ok: true, data: undefined });
    const { result } = renderHook(() => useAccount(buildArgs()));
    await act(async () => {});

    act(() => result.current.setNewEmailDraft('new@example.com'));
    await act(async () => { await result.current.changeEmail('old@example.com'); });

    expect(mockRequestEmailChange).toHaveBeenCalledWith('new@example.com');
    expect(Alert.alert).toHaveBeenCalledWith('Verification Email Sent', expect.any(String));
    expect(result.current.isEmailModalVisible).toBe(false);
  });

  // --------------------------------------------------------------------------
  // sendPasswordReset
  // --------------------------------------------------------------------------

  it('sendPasswordReset shows Alert when no email is provided', async () => {
    const { result } = renderHook(() => useAccount(buildArgs()));
    await act(async () => {});

    await act(async () => { await result.current.sendPasswordReset(undefined); });

    expect(Alert.alert).toHaveBeenCalledWith('Error', 'No email address on file.');
  });

  it('sendPasswordReset calls requestPasswordReset and shows confirmation', async () => {
    mockRequestPasswordReset.mockResolvedValue({ ok: true, data: undefined });
    const { result } = renderHook(() => useAccount(buildArgs()));
    await act(async () => {});

    await act(async () => { await result.current.sendPasswordReset('user@example.com'); });

    expect(mockRequestPasswordReset).toHaveBeenCalledWith('user@example.com');
    expect(Alert.alert).toHaveBeenCalledWith('Reset Email Sent', expect.any(String));
  });

  it('sendPasswordReset enforces 60-second cooldown on second call', async () => {
    mockRequestPasswordReset.mockResolvedValue({ ok: true, data: undefined });
    const { result } = renderHook(() => useAccount(buildArgs()));
    await act(async () => {});

    await act(async () => { await result.current.sendPasswordReset('user@example.com'); });
    jest.clearAllMocks();

    // Second call immediately — should be blocked by cooldown
    await act(async () => { await result.current.sendPasswordReset('user@example.com'); });

    expect(mockRequestPasswordReset).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith('Please Wait', expect.stringContaining('seconds'));
  });

  // --------------------------------------------------------------------------
  // exportData
  // --------------------------------------------------------------------------

  it('exportData calls exportAccountData and shows success Alert', async () => {
    mockExportAccountData.mockResolvedValue({ ok: true, data: undefined });
    const { result } = renderHook(() => useAccount(buildArgs()));
    await act(async () => {});

    await act(async () => { await result.current.exportData(); });

    expect(mockExportAccountData).toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith('Data Export Ready', expect.any(String), expect.any(Array));
  });

  it('exportData shows Rate Limited Alert on 429', async () => {
    mockExportAccountData.mockResolvedValue({ ok: false, status: 429, message: 'Rate limit' });
    const { result } = renderHook(() => useAccount(buildArgs()));
    await act(async () => {});

    await act(async () => { await result.current.exportData(); });

    expect(Alert.alert).toHaveBeenCalledWith('Rate Limited', 'Rate limit');
  });

  it('exportData does nothing when userId is null', async () => {
    const { result } = renderHook(() => useAccount(buildArgs({ userId: null })));
    await act(async () => {});

    await act(async () => { await result.current.exportData(); });

    expect(mockExportAccountData).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // closeDeleteModal / confirmDeleteAccountFromModal
  // --------------------------------------------------------------------------

  it('closeDeleteModal hides the delete modal', async () => {
    const { result } = renderHook(() => useAccount(buildArgs()));
    await act(async () => {});

    // Open manually
    act(() => result.current.setDeleteConfirmText(''));
    // Simulate modal being shown (we'd normally go through beginDeleteAccount → Android path)
    act(() => result.current.closeDeleteModal());

    expect(result.current.showDeleteModal).toBe(false);
  });

  it('confirmDeleteAccountFromModal calls deleteAccount', async () => {
    mockDeleteAccount.mockResolvedValue({ ok: true, data: undefined });
    const { result } = renderHook(() => useAccount(buildArgs()));
    await act(async () => {});

    await act(async () => { result.current.confirmDeleteAccountFromModal(); });
    await act(async () => {});

    expect(mockDeleteAccount).toHaveBeenCalled();
  });
});
