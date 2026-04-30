/**
 * Tests for useMcpApproval hook.
 *
 * Coverage:
 *   - Loads the audit_log request row and parses metadata.
 *   - Surfaces fetch errors and missing-row state cleanly.
 *   - submit('denied') skips the biometric prompt regardless of risk.
 *   - submit('approved') for low/medium risk skips the biometric prompt.
 *   - submit('approved') for high/critical risk gates on the biometric prompt.
 *   - Cancelling biometric surfaces an error and never calls writeDecision.
 *   - Successful submit calls onResolved with the decision.
 *   - Double-submit is prevented while a write is in-flight.
 *
 * @module components/mcp-approval/__tests__/useMcpApproval.test
 */

import { renderHook, act, waitFor } from '@testing-library/react-native';

// WHY mocks defined inside the factory: jest.mock is hoisted above const
// declarations, so referencing top-level vars from the factory throws.
jest.mock('@/lib/supabase', () => {
  const maybeSingle = jest.fn();
  const limit = jest.fn(() => ({ maybeSingle }));
  const eqAction = jest.fn(() => ({ limit }));
  const eqResource = jest.fn(() => ({ eq: eqAction }));
  const select = jest.fn(() => ({ eq: eqResource }));
  const from = jest.fn(() => ({ select }));
  return {
    supabase: { auth: { getUser: jest.fn() }, from },
    __mocks: { maybeSingle, from },
  };
});

jest.mock('@/services/mcp-approval', () => {
  const writeMcpApprovalDecision = jest.fn();
  return { writeMcpApprovalDecision, __mocks: { writeMcpApprovalDecision } };
});

import { useMcpApproval } from '@/components/mcp-approval/useMcpApproval';
const supabaseMock = (jest.requireMock('@/lib/supabase') as { __mocks: { maybeSingle: jest.Mock; from: jest.Mock } }).__mocks;
const mcpServiceMock = (jest.requireMock('@/services/mcp-approval') as { __mocks: { writeMcpApprovalDecision: jest.Mock } }).__mocks;
const mockMaybeSingle = supabaseMock.maybeSingle;
const mockWriteDecision = mcpServiceMock.writeMcpApprovalDecision;

const APPROVAL_ID = '11111111-2222-3333-4444-555555555555';

function makeRequestRow(overrides: { metadata?: Record<string, unknown> } = {}): unknown {
  return {
    id: 'audit-row-1',
    action: 'mcp_approval_requested',
    resource_type: 'mcp_approval',
    resource_id: APPROVAL_ID,
    metadata: {
      approval_id: APPROVAL_ID,
      requested_action: 'bash',
      reason: 'install deps',
      risk: 'medium',
      machine_id: 'machineabc12345',
      context: { command: 'npm install' },
      ...(overrides.metadata ?? {}),
    },
    created_at: new Date().toISOString(),
  };
}

describe('useMcpApproval', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMaybeSingle.mockResolvedValue({ data: makeRequestRow(), error: null });
    mockWriteDecision.mockResolvedValue(undefined);
  });

  it('loads the request and exposes parsed fields', async () => {
    const { result } = renderHook(() => useMcpApproval({ approvalId: APPROVAL_ID }));

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.loadError).toBeNull();
    expect(result.current.request).not.toBeNull();
    expect(result.current.request?.requestedAction).toBe('bash');
    expect(result.current.request?.reason).toBe('install deps');
    expect(result.current.request?.risk).toBe('medium');
    expect(result.current.request?.context).toEqual({ command: 'npm install' });
  });

  it('reports a load error when the row is missing', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const { result } = renderHook(() => useMcpApproval({ approvalId: APPROVAL_ID }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.loadError).toMatch(/not found/);
    expect(result.current.request).toBeNull();
  });

  it('reports a load error when supabase returns an error', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: { message: 'oh no' } });
    const { result } = renderHook(() => useMcpApproval({ approvalId: APPROVAL_ID }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.loadError).toMatch(/oh no/);
  });

  it('reports a load error when metadata is malformed', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: { ...(makeRequestRow() as Record<string, unknown>), metadata: { broken: true } },
      error: null,
    });
    const { result } = renderHook(() => useMcpApproval({ approvalId: APPROVAL_ID }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.loadError).toMatch(/malformed/);
  });

  it('submit("denied") never invokes the biometric prompt even on high risk', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: makeRequestRow({ metadata: { risk: 'high' } }),
      error: null,
    });
    const biometricPrompt = jest.fn(async () => true);
    const onResolved = jest.fn();

    const { result } = renderHook(() =>
      useMcpApproval({ approvalId: APPROVAL_ID, biometricPrompt, onResolved }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.submit('denied', 'too risky');
    });

    expect(biometricPrompt).not.toHaveBeenCalled();
    expect(mockWriteDecision).toHaveBeenCalledWith({
      approvalId: APPROVAL_ID,
      decision: 'denied',
      userMessage: 'too risky',
    });
    expect(onResolved).toHaveBeenCalledWith('denied');
  });

  it('submit("approved") on medium risk skips the biometric gate', async () => {
    const biometricPrompt = jest.fn(async () => true);
    const { result } = renderHook(() =>
      useMcpApproval({ approvalId: APPROVAL_ID, biometricPrompt }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.submit('approved');
    });

    expect(biometricPrompt).not.toHaveBeenCalled();
    expect(mockWriteDecision).toHaveBeenCalled();
  });

  it('submit("approved") on high risk requires biometric and writes when it passes', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: makeRequestRow({ metadata: { risk: 'high' } }),
      error: null,
    });
    const biometricPrompt = jest.fn(async () => true);
    const onResolved = jest.fn();

    const { result } = renderHook(() =>
      useMcpApproval({ approvalId: APPROVAL_ID, biometricPrompt, onResolved }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.submit('approved');
    });

    expect(biometricPrompt).toHaveBeenCalledTimes(1);
    expect(mockWriteDecision).toHaveBeenCalled();
    expect(onResolved).toHaveBeenCalledWith('approved');
  });

  it('submit("approved") on critical risk still gates on biometric', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: makeRequestRow({ metadata: { risk: 'critical' } }),
      error: null,
    });
    const biometricPrompt = jest.fn(async () => true);
    const { result } = renderHook(() =>
      useMcpApproval({ approvalId: APPROVAL_ID, biometricPrompt }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.submit('approved');
    });

    expect(biometricPrompt).toHaveBeenCalledTimes(1);
  });

  it('cancelled biometric prompts surface an error and skip the write', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: makeRequestRow({ metadata: { risk: 'high' } }),
      error: null,
    });
    const biometricPrompt = jest.fn(async () => false);
    const onResolved = jest.fn();

    const { result } = renderHook(() =>
      useMcpApproval({ approvalId: APPROVAL_ID, biometricPrompt, onResolved }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.submit('approved');
    });

    expect(mockWriteDecision).not.toHaveBeenCalled();
    expect(onResolved).not.toHaveBeenCalled();
    expect(result.current.submitError).toMatch(/Biometric/);
  });

  it('write failures surface the error message', async () => {
    mockWriteDecision.mockRejectedValueOnce(new Error('relay down'));
    const { result } = renderHook(() => useMcpApproval({ approvalId: APPROVAL_ID }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.submit('approved');
    });

    expect(result.current.submitError).toMatch(/relay down/);
  });

  it('does not double-submit while a write is in flight', async () => {
    let resolveWrite!: () => void;
    mockWriteDecision.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    );

    const { result } = renderHook(() => useMcpApproval({ approvalId: APPROVAL_ID }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let firstCall!: Promise<void>;
    act(() => {
      firstCall = result.current.submit('approved');
    });

    // immediate second call should be ignored
    await act(async () => {
      await result.current.submit('denied');
    });

    await act(async () => {
      resolveWrite();
      await firstCall;
    });

    expect(mockWriteDecision).toHaveBeenCalledTimes(1);
  });
});
