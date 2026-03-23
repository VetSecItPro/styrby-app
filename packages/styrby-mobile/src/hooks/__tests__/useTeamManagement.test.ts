/**
 * useTeamManagement Hook Test Suite
 *
 * Tests the team management hook, including:
 * - Team creation
 * - Member invitation with CSPRNG token generation
 * - Role changes
 * - Member removal
 * - Error handling for unauthenticated users
 */

import { renderHook, act, waitFor } from '@testing-library/react-native';

// ============================================================================
// Mock Setup
// ============================================================================

let mockAuthUser: { id: string } | null = { id: 'test-user-id' };
let mockRpcResults: Record<string, { data: unknown; error: unknown }> = {};
let mockQueryResults: Record<string, { data: unknown; error: unknown }> = {};

jest.mock('expo-crypto', () => ({
  getRandomBytes: jest.fn(() => new Uint8Array(16).fill(0xab)),
}));

jest.mock('@/lib/supabase', () => {
  const createChain = (table: string) => {
    const getResult = () =>
      mockQueryResults[table] || { data: null, error: null };

    const chain: Record<string, unknown> = {};
    const chainMethods = ['select', 'eq', 'order', 'insert', 'update', 'delete', 'limit'];
    for (const method of chainMethods) {
      chain[method] = jest.fn(() => chain);
    }
    chain.single = jest.fn(() => Promise.resolve(getResult()));
    chain.maybeSingle = jest.fn(() => Promise.resolve(getResult()));
    chain.then = (resolve: (v: unknown) => void) =>
      Promise.resolve(getResult()).then(resolve);
    return chain;
  };

  return {
    supabase: {
      auth: {
        getUser: jest.fn(async () => ({
          data: { user: mockAuthUser },
          error: null,
        })),
      },
      from: jest.fn((table: string) => createChain(table)),
      rpc: jest.fn((name: string) => {
        const result = mockRpcResults[name] || { data: null, error: null };
        return Promise.resolve(result);
      }),
    },
  };
});

jest.mock('styrby-shared', () => ({}));

import { useTeamManagement } from '../useTeamManagement';
import { supabase } from '@/lib/supabase';

// ============================================================================
// Test Data
// ============================================================================

const validTeam = {
  id: 'team-1',
  name: 'Engineering',
  description: 'The engineering team',
  owner_id: 'test-user-id',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

const validTeamMember = {
  member_id: 'member-1',
  user_id: 'test-user-id',
  role: 'owner',
  display_name: 'Test User',
  email: 'test@example.com',
  avatar_url: null,
  joined_at: '2024-01-01T00:00:00Z',
};

const validUserTeamRow = {
  team_id: 'team-1',
  team_name: 'Engineering',
  team_description: 'The engineering team',
  owner_id: 'test-user-id',
  role: 'owner',
  member_count: 1,
  joined_at: '2024-01-01T00:00:00Z',
};

const validInvitation = {
  id: 'invite-1',
  team_id: 'team-1',
  email: 'newuser@example.com',
  invited_by: 'test-user-id',
  role: 'member',
  token: 'abababababababababababababababab',
  status: 'pending',
  expires_at: '2024-02-01T00:00:00Z',
  created_at: '2024-01-01T00:00:00Z',
};

/**
 * Sets up mock responses for a user who has a team.
 */
function setupWithTeam() {
  mockRpcResults = {
    get_user_teams: { data: [validUserTeamRow], error: null },
    get_team_members: { data: [validTeamMember], error: null },
  };
  mockQueryResults = {
    teams: { data: validTeam, error: null },
    team_invitations: { data: [], error: null },
  };
}

/**
 * Sets up mock responses for a user with no team.
 */
function setupNoTeam() {
  mockRpcResults = {
    get_user_teams: { data: [], error: null },
    get_team_members: { data: [], error: null },
  };
  mockQueryResults = {};
}

// ============================================================================
// Tests
// ============================================================================

describe('useTeamManagement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthUser = { id: 'test-user-id' };
    setupNoTeam();
  });

  // --------------------------------------------------------------------------
  // Initial State
  // --------------------------------------------------------------------------

  it('starts in loading state', () => {
    const { result } = renderHook(() => useTeamManagement());
    expect(result.current.isLoading).toBe(true);
  });

  it('loads team data on mount when user has a team', async () => {
    setupWithTeam();

    const { result } = renderHook(() => useTeamManagement());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.team).not.toBeNull();
    expect(result.current.team?.name).toBe('Engineering');
    expect(result.current.currentUserRole).toBe('owner');
    expect(result.current.members).toHaveLength(1);
  });

  it('sets null team when user has no team', async () => {
    setupNoTeam();

    const { result } = renderHook(() => useTeamManagement());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.team).toBeNull();
    expect(result.current.currentUserRole).toBeNull();
    expect(result.current.members).toHaveLength(0);
  });

  it('sets error when user is not authenticated', async () => {
    mockAuthUser = null;

    const { result } = renderHook(() => useTeamManagement());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBe('You must be signed in to view team data.');
  });

  // --------------------------------------------------------------------------
  // Create Team
  // --------------------------------------------------------------------------

  it('creates a team successfully', async () => {
    setupNoTeam();

    // After creation, the hook reloads data; set up responses for that reload
    const { result } = renderHook(() => useTeamManagement());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Configure the insert response
    mockQueryResults = {
      ...mockQueryResults,
      teams: { data: validTeam, error: null },
    };

    // Also set up the reload responses
    mockRpcResults = {
      get_user_teams: { data: [validUserTeamRow], error: null },
      get_team_members: { data: [validTeamMember], error: null },
    };
    mockQueryResults.team_invitations = { data: [], error: null };

    let createdTeam: unknown = null;
    await act(async () => {
      createdTeam = await result.current.createTeam('Engineering', 'The engineering team');
    });

    expect(createdTeam).not.toBeNull();
    expect(result.current.isMutating).toBe(false);
  });

  it('rejects team creation with empty name', async () => {
    setupNoTeam();

    const { result } = renderHook(() => useTeamManagement());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let createdTeam: unknown = 'not-null';
    await act(async () => {
      createdTeam = await result.current.createTeam('');
    });

    expect(createdTeam).toBeNull();
    expect(result.current.error).toBe('Team name is required.');
  });

  it('rejects team creation with name exceeding 100 characters', async () => {
    setupNoTeam();

    const { result } = renderHook(() => useTeamManagement());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let createdTeam: unknown = 'not-null';
    await act(async () => {
      createdTeam = await result.current.createTeam('x'.repeat(101));
    });

    expect(createdTeam).toBeNull();
    expect(result.current.error).toBe('Team name must be 100 characters or fewer.');
  });

  // --------------------------------------------------------------------------
  // Invite Member
  // --------------------------------------------------------------------------

  it('sends invitation with CSPRNG token', async () => {
    setupWithTeam();

    const { result } = renderHook(() => useTeamManagement());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    mockQueryResults = {
      ...mockQueryResults,
      team_invitations: { data: validInvitation, error: null },
    };

    let success = false;
    await act(async () => {
      success = await result.current.inviteMember('newuser@example.com', 'member');
    });

    expect(success).toBe(true);

    // Verify supabase.from was called with 'team_invitations' for the insert
    const fromCalls = (supabase.from as jest.Mock).mock.calls;
    const invitationCalls = fromCalls.filter(
      (call: string[]) => call[0] === 'team_invitations',
    );
    expect(invitationCalls.length).toBeGreaterThan(0);
  });

  it('rejects invitation with invalid email', async () => {
    setupWithTeam();

    const { result } = renderHook(() => useTeamManagement());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let success = true;
    await act(async () => {
      success = await result.current.inviteMember('not-an-email', 'member');
    });

    expect(success).toBe(false);
    expect(result.current.error).toBe('Please enter a valid email address.');
  });

  it('rejects invitation when user has no team', async () => {
    setupNoTeam();

    const { result } = renderHook(() => useTeamManagement());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let success = true;
    await act(async () => {
      success = await result.current.inviteMember('user@example.com', 'member');
    });

    expect(success).toBe(false);
    expect(result.current.error).toBe('You must have a team before inviting members.');
  });

  // --------------------------------------------------------------------------
  // Update Member Role
  // --------------------------------------------------------------------------

  it('updates member role successfully', async () => {
    setupWithTeam();

    const { result } = renderHook(() => useTeamManagement());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    mockQueryResults.team_members = { data: null, error: null };

    let success = false;
    await act(async () => {
      success = await result.current.updateMemberRole('member-1', 'admin');
    });

    expect(success).toBe(true);
    expect(result.current.isMutating).toBe(false);
  });

  it('handles role update error', async () => {
    setupWithTeam();

    const { result } = renderHook(() => useTeamManagement());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    mockQueryResults.team_members = {
      data: null,
      error: { message: 'Permission denied' },
    };

    let success = true;
    await act(async () => {
      success = await result.current.updateMemberRole('member-1', 'admin');
    });

    expect(success).toBe(false);
    expect(result.current.error).toBe('Permission denied');
  });

  // --------------------------------------------------------------------------
  // Remove Member
  // --------------------------------------------------------------------------

  it('removes member successfully', async () => {
    setupWithTeam();

    const { result } = renderHook(() => useTeamManagement());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    mockQueryResults.team_members = { data: null, error: null };

    let success = false;
    await act(async () => {
      success = await result.current.removeMember('member-1');
    });

    expect(success).toBe(true);
    expect(result.current.isMutating).toBe(false);
  });

  it('handles removal error', async () => {
    setupWithTeam();

    const { result } = renderHook(() => useTeamManagement());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    mockQueryResults.team_members = {
      data: null,
      error: { message: 'Cannot remove owner' },
    };

    let success = true;
    await act(async () => {
      success = await result.current.removeMember('member-1');
    });

    expect(success).toBe(false);
    expect(result.current.error).toBe('Cannot remove owner');
  });
});
