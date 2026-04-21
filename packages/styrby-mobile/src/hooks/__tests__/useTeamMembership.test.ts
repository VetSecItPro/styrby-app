/**
 * Tests for useTeamMembership — Phase 1 #4 batch 1 follow-up.
 *
 * Mocks the Supabase client and exercises the three branches:
 *   1. No authenticated user → defaults (isTeamMember=false, userTeamId=null)
 *   2. Authenticated + has team → flips to true with the team_id
 *   3. Supabase throws → swallowed, defaults preserved
 *
 * @module hooks/__tests__/useTeamMembership
 */

import React from 'react';
import renderer from 'react-test-renderer';

const mockGetUser = jest.fn();
const mockSingle = jest.fn();

jest.mock('../../lib/supabase', () => ({
  supabase: {
    auth: { getUser: () => mockGetUser() },
    from: () => ({
      select: () => ({
        eq: () => ({
          limit: () => ({
            single: () => mockSingle(),
          }),
        }),
      }),
    }),
  },
}));

import { useTeamMembership, type UseTeamMembershipResult } from '../useTeamMembership';

/**
 * Tiny harness that renders the hook and gives us a way to peek at
 * the latest result on each render.
 */
function renderHook(): { results: UseTeamMembershipResult[] } {
  const results: UseTeamMembershipResult[] = [];
  function Probe() {
    results.push(useTeamMembership());
    return null;
  }
  let root: renderer.ReactTestRenderer;
  renderer.act(() => {
    root = renderer.create(React.createElement(Probe));
  });
  // Flush the useEffect's microtasks so the async getUser resolves.
  return { results, /* keep root referenced */ ...(root! && {}) };
}

describe('useTeamMembership', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns defaults synchronously on first render', () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    const { results } = renderHook();
    expect(results[0]).toEqual({ isTeamMember: false, userTeamId: null });
  });

  it('stays at defaults when there is no authenticated user', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    const { results } = renderHook();
    // Allow the useEffect's promise chain to settle.
    await renderer.act(async () => {
      await Promise.resolve();
    });
    expect(results[results.length - 1]).toEqual({ isTeamMember: false, userTeamId: null });
    // single() must NOT be called when there is no user.
    expect(mockSingle).not.toHaveBeenCalled();
  });

  it('flips to isTeamMember=true when the user belongs to a team', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1' } } });
    mockSingle.mockResolvedValue({ data: { team_id: 'team-abc' } });

    const { results } = renderHook();
    await renderer.act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const last = results[results.length - 1];
    expect(last.isTeamMember).toBe(true);
    expect(last.userTeamId).toBe('team-abc');
  });

  it('stays at defaults when the user has no team_members row', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1' } } });
    mockSingle.mockResolvedValue({ data: null });

    const { results } = renderHook();
    await renderer.act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const last = results[results.length - 1];
    expect(last).toEqual({ isTeamMember: false, userTeamId: null });
  });

  it('swallows errors and stays at defaults (no throw)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockGetUser.mockRejectedValue(new Error('network unreachable'));

    const { results } = renderHook();
    await renderer.act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const last = results[results.length - 1];
    expect(last).toEqual({ isTeamMember: false, userTeamId: null });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
