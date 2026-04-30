/**
 * Tests for writeMcpApprovalDecision.
 *
 * Coverage:
 *   - Happy-path INSERT carries the exact action / resource_type / metadata
 *     shape the CLI poll loop reads.
 *   - Auth failure (no user) throws with a clear error.
 *   - RLS / Postgres error from supabase surfaces with the underlying code.
 *   - userMessage is truncated at 280 chars on the way to the DB.
 *   - Empty / undefined userMessage is omitted from metadata (so the CLI
 *     fallback `meta.user_message ?? ''` keeps working).
 *
 * @module services/__tests__/mcp-approval.test
 */

// WHY inline jest.fn() inside the factory: jest.mock() is hoisted above
// const declarations, so referencing top-level mock vars in the factory
// throws ReferenceError. Defining the mocks inside the factory and pulling
// them back out via require() in beforeEach gives us full control with
// hoist-safe semantics.
jest.mock('@/lib/supabase', () => {
  const insert = jest.fn();
  const from = jest.fn(() => ({ insert }));
  const getUser = jest.fn();
  return {
    supabase: {
      auth: { getUser },
      from,
    },
    __mocks: { insert, from, getUser },
  };
});

import { writeMcpApprovalDecision } from '@/services/mcp-approval';
const supabaseMock = (jest.requireMock('@/lib/supabase') as { __mocks: { insert: jest.Mock; from: jest.Mock; getUser: jest.Mock } }).__mocks;
const mockGetUser = supabaseMock.getUser;
const mockInsert = supabaseMock.insert;
const mockFrom = supabaseMock.from;

const APPROVAL_ID = '11111111-2222-3333-4444-555555555555';
const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('writeMcpApprovalDecision', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: { id: USER_ID } }, error: null });
    mockInsert.mockResolvedValue({ error: null });
  });

  it('writes a decision row with the CLI-expected shape', async () => {
    await writeMcpApprovalDecision({
      approvalId: APPROVAL_ID,
      decision: 'approved',
      userMessage: 'LGTM',
    });

    expect(mockFrom).toHaveBeenCalledWith('audit_log');
    expect(mockInsert).toHaveBeenCalledTimes(1);
    const row = mockInsert.mock.calls[0][0];
    expect(row.user_id).toBe(USER_ID);
    expect(row.action).toBe('mcp_approval_decided');
    expect(row.resource_type).toBe('mcp_approval');
    expect(row.resource_id).toBe(APPROVAL_ID);
    expect(row.metadata).toEqual({
      approval_id: APPROVAL_ID,
      decision: 'approved',
      user_message: 'LGTM',
    });
  });

  it('omits user_message when not provided', async () => {
    await writeMcpApprovalDecision({
      approvalId: APPROVAL_ID,
      decision: 'denied',
    });
    const row = mockInsert.mock.calls[0][0];
    expect(row.metadata).toEqual({
      approval_id: APPROVAL_ID,
      decision: 'denied',
    });
    expect(row.metadata).not.toHaveProperty('user_message');
  });

  it('omits user_message when empty string', async () => {
    await writeMcpApprovalDecision({
      approvalId: APPROVAL_ID,
      decision: 'approved',
      userMessage: '',
    });
    const row = mockInsert.mock.calls[0][0];
    expect(row.metadata).not.toHaveProperty('user_message');
  });

  it('truncates user_message to 280 chars defensively', async () => {
    const longNote = 'x'.repeat(500);
    await writeMcpApprovalDecision({
      approvalId: APPROVAL_ID,
      decision: 'approved',
      userMessage: longNote,
    });
    const row = mockInsert.mock.calls[0][0];
    expect(row.metadata.user_message).toHaveLength(280);
  });

  it('throws when no authenticated user', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    await expect(
      writeMcpApprovalDecision({ approvalId: APPROVAL_ID, decision: 'approved' }),
    ).rejects.toThrow(/No authenticated user/);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('throws when getUser returns an error', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: null },
      error: { message: 'token expired' },
    });
    await expect(
      writeMcpApprovalDecision({ approvalId: APPROVAL_ID, decision: 'approved' }),
    ).rejects.toThrow(/Auth check failed: token expired/);
  });

  it('surfaces supabase INSERT errors with code', async () => {
    mockInsert.mockResolvedValueOnce({
      error: { code: '42501', message: 'new row violates row-level security policy' },
    });
    await expect(
      writeMcpApprovalDecision({ approvalId: APPROVAL_ID, decision: 'approved' }),
    ).rejects.toThrow(/\[42501\].*row-level security/);
  });

  it('surfaces supabase INSERT errors without code gracefully', async () => {
    mockInsert.mockResolvedValueOnce({
      error: { message: 'network timeout' },
    });
    await expect(
      writeMcpApprovalDecision({ approvalId: APPROVAL_ID, decision: 'denied' }),
    ).rejects.toThrow(/network timeout/);
  });
});
