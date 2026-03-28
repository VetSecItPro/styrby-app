/**
 * Accept Invite Screen Tests
 *
 * Validates the full state machine of the AcceptInviteScreen:
 * loading → invalid | ready → accepting | declining → accepted | declined | error
 *
 * Uses react-test-renderer (node environment, no DOM/jsdom). All Supabase
 * interactions are mocked so no network calls occur.
 *
 * State machine states covered:
 * - loading:   ActivityIndicator shown on mount while token is validated
 * - invalid:   no token provided, or invitation already used / expired
 * - ready:     valid pending invitation — shows team name, role, email, action buttons
 * - accepting: spinner while accept mutation is in-flight
 * - declining: spinner while decline mutation is in-flight
 * - accepted:  success confirmation after accept
 * - declined:  success confirmation after decline
 * - error:     Supabase query/mutation failure
 */

import React from 'react';
import renderer, { act } from 'react-test-renderer';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Recursively collects all text content from a react-test-renderer JSON tree.
 *
 * @param node - The JSON tree node or array of nodes
 * @returns Array of string text values found anywhere in the tree
 */
function collectText(
  node: renderer.ReactTestRendererJSON | renderer.ReactTestRendererJSON[] | null,
): string[] {
  if (!node) return [];
  if (Array.isArray(node)) return node.flatMap(collectText);
  if (typeof node === 'string') return [node as unknown as string];
  const texts: string[] = [];
  if (node.children) {
    for (const child of node.children) {
      if (typeof child === 'string') texts.push(child);
      else texts.push(...collectText(child));
    }
  }
  return texts;
}

/**
 * Returns true if any text node in the rendered tree contains the given substring.
 *
 * @param tree - react-test-renderer JSON output
 * @param text - Substring to look for
 * @returns true if found
 */
function hasText(
  tree: renderer.ReactTestRendererJSON | renderer.ReactTestRendererJSON[] | null,
  text: string,
): boolean {
  return collectText(tree).some((t) => t.includes(text));
}

// ============================================================================
// Mock: expo-router
// ============================================================================

/**
 * WHY: AcceptInviteScreen reads `token` from useLocalSearchParams and navigates
 * with useRouter. We expose a mutable params object and a router replace spy
 * so individual tests can control the token value and assert navigation calls.
 *
 * Variable names must start with `mock` to pass Jest's hoisting restrictions
 * inside jest.mock() factory closures.
 */
const mockRouterReplace = jest.fn();
const mockLocalSearchParams: Record<string, string> = {};

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: mockRouterReplace, back: jest.fn() },
  useRouter: () => ({ push: jest.fn(), replace: mockRouterReplace, back: jest.fn() }),
  useLocalSearchParams: jest.fn(() => mockLocalSearchParams),
  Link: 'Link',
  Stack: { Screen: 'StackScreen' },
}));

// ============================================================================
// Mock: @expo/vector-icons
// ============================================================================

/**
 * WHY: Ionicons tries to load native font assets which are unavailable in a
 * Node test environment. A string stub prevents the crash while preserving
 * the element in the rendered tree for structure assertions.
 */
jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

// ============================================================================
// Mock: @/lib/supabase
// ============================================================================

/**
 * Builds a chainable Supabase query mock that resolves to `resolvedValue`.
 *
 * WHY: The component calls .from().select().eq().single() as a fluent chain.
 * Each method returns the same object so the chain works for any depth.
 * The `then` property makes it directly awaitable: `await supabase.from(...)`.
 *
 * This function must be prefixed with `mock` to be accessible inside the
 * jest.mock() factory closure (Jest hoisting restriction).
 *
 * @param resolvedValue - The `{ data, error }` object the awaited chain returns
 * @returns A chainable, thenable mock object
 */
const mockSupabaseChain = (
  resolvedValue: { data: unknown; error: unknown } = { data: null, error: null },
) => {
  const chain: Record<string, unknown> = {};
  const methods = [
    'select', 'eq', 'order', 'gte', 'limit', 'not',
    'single', 'insert', 'update', 'delete', 'upsert', 'maybeSingle',
  ];
  for (const m of methods) chain[m] = jest.fn(() => chain);
  chain.then = (resolve: (v: unknown) => void) =>
    Promise.resolve(resolvedValue).then(resolve);
  return chain;
};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getUser: jest.fn(async () => ({
        data: { user: { id: 'user-uuid-test' } },
        error: null,
      })),
      onAuthStateChange: jest.fn(() => ({
        data: { subscription: { unsubscribe: jest.fn() } },
      })),
    },
    from: jest.fn(() => mockSupabaseChain()),
    channel: jest.fn(() => ({
      on: jest.fn().mockReturnThis(),
      subscribe: jest.fn(),
    })),
    removeChannel: jest.fn(),
  },
}));

// ============================================================================
// Import component (AFTER all mocks are registered)
// ============================================================================

import AcceptInviteScreen from '../team/accept-invite';

// ============================================================================
// Supabase mock access helpers
// ============================================================================

/**
 * Returns the mocked supabase object from the module registry.
 *
 * WHY a lazy require: importing with static import after jest.mock gives the
 * mocked version, but we also need to access it per-test after clearAllMocks
 * resets mock implementations. require() re-fetches from the registry cache.
 */
function getMockSupabase() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@/lib/supabase').supabase as {
    auth: { getUser: jest.Mock };
    from: jest.Mock;
  };
}

/**
 * Queues a successful Supabase from() response for the next call only.
 *
 * @param data - Row data to return
 */
function setupFromSuccess(data: unknown) {
  getMockSupabase().from.mockReturnValueOnce(mockSupabaseChain({ data, error: null }));
}

/**
 * Queues an errored Supabase from() response for the next call only.
 *
 * @param error - Error object to return
 */
function setupFromError(error: unknown) {
  getMockSupabase().from.mockReturnValueOnce(mockSupabaseChain({ data: null, error }));
}

/**
 * Queues a successful empty Supabase from() response for the next call only.
 * Used for mutation calls (update, upsert) where the return value is not used.
 */
function setupFromEmpty() {
  getMockSupabase().from.mockReturnValueOnce(mockSupabaseChain({ data: null, error: null }));
}

// ============================================================================
// Fixtures
// ============================================================================

/**
 * A valid, pending team invitation row as returned by the Supabase query.
 * Matches the InvitationRowSchema shape defined in accept-invite.tsx.
 *
 * WHY real UUID format: InvitationRowSchema uses z.string().uuid() for id,
 * team_id, and invited_by. Non-UUID strings cause Zod to reject the fixture,
 * putting the component in the 'invalid' state instead of 'ready'.
 */
const VALID_INVITATION = {
  id: '11111111-1111-4111-a111-111111111111',
  team_id: '22222222-2222-4222-a222-222222222222',
  email: 'dev@example.com',
  invited_by: '33333333-3333-4333-a333-333333333333',
  role: 'member' as const,
  status: 'pending' as const,
  expires_at: null,
  token: 'abc123deadbeef',
  teams: { name: 'Acme Engineering' },
  invited_by_profile: { display_name: 'Alice', email: 'alice@example.com' },
};

/** Expired invitation: expires_at is in the past, status still pending. */
const EXPIRED_INVITATION = {
  ...VALID_INVITATION,
  status: 'pending' as const,
  expires_at: '2020-01-01T00:00:00.000Z',
};

/** Invitation that has already been accepted (server-side status). */
const ALREADY_ACCEPTED_INVITATION = {
  ...VALID_INVITATION,
  status: 'accepted' as const,
};

/** Invitation that has already been declined (server-side status). */
const ALREADY_DECLINED_INVITATION = {
  ...VALID_INVITATION,
  status: 'declined' as const,
};

/** Invitation with status 'expired' (server-side flag). */
const SERVER_EXPIRED_INVITATION = {
  ...VALID_INVITATION,
  status: 'expired' as const,
};

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Mounts the screen and flushes all async effects (useEffect, state updates).
 *
 * WHY: The component's validateToken() is async. We must wrap in act() and
 * then call instance.toJSON() AFTER act() completes to observe the settled
 * state. Calling toJSON() inside the act() callback captures the initial
 * (loading) render, not the resolved state.
 *
 * @returns A mounted instance with all async effects flushed
 */
async function mountAndSettle(): Promise<renderer.ReactTestRenderer> {
  let instance!: renderer.ReactTestRenderer;
  await act(async () => {
    instance = renderer.create(<AcceptInviteScreen />);
  });
  return instance;
}

// ============================================================================
// Tests
// ============================================================================

describe('AcceptInviteScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: empty params (no token)
    Object.keys(mockLocalSearchParams).forEach((k) => delete mockLocalSearchParams[k]);
    // Restore default implementations after clearAllMocks() resets them.
    // WHY: clearAllMocks() clears mock.calls and mock.instances but also
    // removes any mockReturnValue / mockResolvedValue set by previous calls
    // on jest.fn() objects. We restore sensible defaults here.
    const sb = getMockSupabase();
    sb.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-uuid-test' } },
      error: null,
    });
    sb.from.mockReturnValue(mockSupabaseChain());
  });

  // --------------------------------------------------------------------------
  // Basic render
  // --------------------------------------------------------------------------

  /**
   * Smoke test: the screen must mount without throwing regardless of state.
   */
  it('renders without crashing', () => {
    const tree = renderer.create(<AcceptInviteScreen />).toJSON();
    expect(tree).toBeTruthy();
  });

  // --------------------------------------------------------------------------
  // Loading state
  // --------------------------------------------------------------------------

  /**
   * On mount with a token the component is synchronously in 'loading' while
   * validateToken() is pending. We capture the tree without act() so we see
   * the initial synchronous render, not the settled state.
   *
   * WHY no act(): act() flushes microtasks and lets validateToken complete,
   * taking us past the loading state. Skipping act() intentionally here to
   * test the initial render.
   */
  it('shows ActivityIndicator and loading text on initial mount when a token is present', () => {
    Object.assign(mockLocalSearchParams, { token: 'some-token' });
    // Never-resolving chain keeps the component in loading state
    const pendingChain: Record<string, unknown> = {};
    const methods = ['select', 'eq', 'single', 'update', 'upsert'];
    for (const m of methods) pendingChain[m] = jest.fn(() => pendingChain);
    pendingChain.then = () => new Promise(() => {}); // never resolves
    getMockSupabase().from.mockReturnValue(pendingChain);

    const tree = renderer.create(<AcceptInviteScreen />).toJSON();
    expect(hasText(tree, 'Validating invitation...')).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Invalid state — no token
  // --------------------------------------------------------------------------

  /**
   * When useLocalSearchParams returns {} (no token key), the component
   * synchronously transitions to the 'invalid' state and shows the reason.
   */
  it('shows invalid state when no token is provided', async () => {
    // mockLocalSearchParams is empty per beforeEach
    const instance = await mountAndSettle();
    const tree = instance.toJSON();

    expect(hasText(tree, 'Invalid Invitation')).toBe(true);
    expect(hasText(tree, 'No invitation token provided.')).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Invalid state — token not found in database
  // --------------------------------------------------------------------------

  /**
   * When Supabase returns an error (e.g. PGRST116 not-found), the component
   * shows "invalid or has been revoked".
   */
  it('shows invalid state when Supabase returns an error for the token', async () => {
    Object.assign(mockLocalSearchParams, { token: 'nonexistent-token' });
    setupFromError({ message: 'Row not found', code: 'PGRST116' });

    const instance = await mountAndSettle();
    const tree = instance.toJSON();

    expect(hasText(tree, 'Invalid Invitation')).toBe(true);
    expect(hasText(tree, 'invalid or has been revoked')).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Invalid state — already accepted
  // --------------------------------------------------------------------------

  it('shows invalid state when invitation was already accepted', async () => {
    Object.assign(mockLocalSearchParams, { token: ALREADY_ACCEPTED_INVITATION.token });
    setupFromSuccess(ALREADY_ACCEPTED_INVITATION);

    const instance = await mountAndSettle();
    const tree = instance.toJSON();

    expect(hasText(tree, 'Invalid Invitation')).toBe(true);
    expect(hasText(tree, 'already been accepted')).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Invalid state — already declined
  // --------------------------------------------------------------------------

  it('shows invalid state when invitation was already declined', async () => {
    Object.assign(mockLocalSearchParams, { token: ALREADY_DECLINED_INVITATION.token });
    setupFromSuccess(ALREADY_DECLINED_INVITATION);

    const instance = await mountAndSettle();
    const tree = instance.toJSON();

    expect(hasText(tree, 'Invalid Invitation')).toBe(true);
    expect(hasText(tree, 'already been declined')).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Invalid state — server-side expired status
  // --------------------------------------------------------------------------

  /**
   * When the database row has status === 'expired', the component detects it
   * via the status check, before the client-side isExpired() date check.
   */
  it('shows expired state when invitation status is expired on the server', async () => {
    Object.assign(mockLocalSearchParams, { token: SERVER_EXPIRED_INVITATION.token });
    setupFromSuccess(SERVER_EXPIRED_INVITATION);

    const instance = await mountAndSettle();
    const tree = instance.toJSON();

    expect(hasText(tree, 'Invalid Invitation')).toBe(true);
    expect(hasText(tree, 'expired')).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Invalid state — client-side expiry check (expires_at in the past)
  // --------------------------------------------------------------------------

  /**
   * Even with status 'pending', if expires_at is in the past the component
   * rejects the invitation via the isExpired() helper.
   */
  it('shows expired state when expires_at is in the past', async () => {
    Object.assign(mockLocalSearchParams, { token: EXPIRED_INVITATION.token });
    setupFromSuccess(EXPIRED_INVITATION);

    const instance = await mountAndSettle();
    const tree = instance.toJSON();

    expect(hasText(tree, 'Invalid Invitation')).toBe(true);
    expect(hasText(tree, 'expired')).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Ready state — invitation details card
  // --------------------------------------------------------------------------

  /**
   * With a valid pending invitation, the screen renders the team name, role,
   * and invited email inside the details card.
   */
  it('shows invitation details (team name, role, email) in ready state', async () => {
    Object.assign(mockLocalSearchParams, { token: VALID_INVITATION.token });
    setupFromSuccess(VALID_INVITATION);

    const instance = await mountAndSettle();
    const tree = instance.toJSON();

    expect(hasText(tree, 'Team Invitation')).toBe(true);
    expect(hasText(tree, 'Acme Engineering')).toBe(true);
    expect(hasText(tree, 'Member')).toBe(true);
    expect(hasText(tree, 'dev@example.com')).toBe(true);
  });

  /**
   * The 'admin' role should display as "Admin" (via the formatRole helper).
   */
  it('displays Admin role label when invitation role is admin', async () => {
    const adminInvitation = { ...VALID_INVITATION, role: 'admin' as const };
    Object.assign(mockLocalSearchParams, { token: adminInvitation.token });
    setupFromSuccess(adminInvitation);

    const instance = await mountAndSettle();
    const tree = instance.toJSON();

    expect(hasText(tree, 'Admin')).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Ready state — action buttons
  // --------------------------------------------------------------------------

  /**
   * Both the Accept and Decline buttons must be present in the ready state.
   */
  it('shows Accept Invitation and Decline buttons in ready state', async () => {
    Object.assign(mockLocalSearchParams, { token: VALID_INVITATION.token });
    setupFromSuccess(VALID_INVITATION);

    const instance = await mountAndSettle();
    const tree = instance.toJSON();

    expect(hasText(tree, 'Accept Invitation')).toBe(true);
    expect(hasText(tree, 'Decline')).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Accepted state
  // --------------------------------------------------------------------------

  /**
   * After tapping Accept the component calls:
   * 1. auth.getUser()
   * 2. supabase.from('team_invitations').update(...)
   * 3. supabase.from('team_members').upsert(...)
   *
   * All succeed → state transitions to 'accepted' and shows the success screen.
   */
  it('shows accepted confirmation after successfully accepting the invitation', async () => {
    Object.assign(mockLocalSearchParams, { token: VALID_INVITATION.token });
    setupFromSuccess(VALID_INVITATION); // validateToken
    setupFromEmpty();                   // update team_invitations → accepted
    setupFromEmpty();                   // upsert team_members

    const instance = await mountAndSettle();

    const acceptButton = instance.root.findAll(
      (node) => node.props.accessibilityLabel === 'Accept team invitation',
    )[0];

    await act(async () => {
      if (acceptButton?.props.onPress) {
        acceptButton.props.onPress();
      }
    });

    const tree = instance.toJSON();
    expect(hasText(tree, 'Welcome to the Team!')).toBe(true);
    expect(hasText(tree, 'successfully joined')).toBe(true);
    expect(hasText(tree, 'View Team')).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Declined state
  // --------------------------------------------------------------------------

  /**
   * After tapping Decline and the update succeeds, the screen shows the
   * declined confirmation with a "Go to Dashboard" button.
   */
  it('shows declined confirmation after successfully declining the invitation', async () => {
    Object.assign(mockLocalSearchParams, { token: VALID_INVITATION.token });
    setupFromSuccess(VALID_INVITATION); // validateToken
    setupFromEmpty();                   // update team_invitations → declined

    const instance = await mountAndSettle();

    const declineButton = instance.root.findAll(
      (node) => node.props.accessibilityLabel === 'Decline team invitation',
    )[0];

    await act(async () => {
      if (declineButton?.props.onPress) {
        declineButton.props.onPress();
      }
    });

    const tree = instance.toJSON();
    expect(hasText(tree, 'Invitation Declined')).toBe(true);
    expect(hasText(tree, 'declined the team invitation')).toBe(true);
    expect(hasText(tree, 'Go to Dashboard')).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Error state — validateToken throws
  // --------------------------------------------------------------------------

  /**
   * When supabase.from() throws synchronously (e.g. catastrophic network
   * error), the component catches it and transitions to the 'error' state.
   */
  it('shows error state when the Supabase query throws an exception', async () => {
    Object.assign(mockLocalSearchParams, { token: 'bad-token' });
    getMockSupabase().from.mockImplementationOnce(() => {
      throw new Error('Network unavailable');
    });

    const instance = await mountAndSettle();
    const tree = instance.toJSON();

    expect(hasText(tree, 'Something Went Wrong')).toBe(true);
    expect(hasText(tree, 'Failed to load invitation')).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Error state — accept mutation fails
  // --------------------------------------------------------------------------

  /**
   * If the team_invitations update returns an error during accept, the
   * component transitions to 'error' rather than 'accepted'.
   */
  it('shows error state when the accept mutation fails', async () => {
    Object.assign(mockLocalSearchParams, { token: VALID_INVITATION.token });
    setupFromSuccess(VALID_INVITATION);          // validateToken succeeds
    setupFromError({ message: 'Permission denied' }); // update fails

    const instance = await mountAndSettle();

    const acceptButton = instance.root.findAll(
      (node) => node.props.accessibilityLabel === 'Accept team invitation',
    )[0];

    await act(async () => {
      if (acceptButton?.props.onPress) {
        acceptButton.props.onPress();
      }
    });

    const tree = instance.toJSON();
    expect(hasText(tree, 'Something Went Wrong')).toBe(true);
    expect(hasText(tree, 'Permission denied')).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Error state — decline mutation fails
  // --------------------------------------------------------------------------

  /**
   * If the team_invitations update returns an error during decline, the
   * screen transitions to 'error' instead of 'declined'.
   */
  it('shows error state when the decline mutation fails', async () => {
    Object.assign(mockLocalSearchParams, { token: VALID_INVITATION.token });
    setupFromSuccess(VALID_INVITATION);    // validateToken succeeds
    setupFromError({ message: 'Forbidden' }); // decline update fails

    const instance = await mountAndSettle();

    const declineButton = instance.root.findAll(
      (node) => node.props.accessibilityLabel === 'Decline team invitation',
    )[0];

    await act(async () => {
      if (declineButton?.props.onPress) {
        declineButton.props.onPress();
      }
    });

    const tree = instance.toJSON();
    expect(hasText(tree, 'Something Went Wrong')).toBe(true);
    expect(hasText(tree, 'Forbidden')).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Error state — user not signed in during accept
  // --------------------------------------------------------------------------

  /**
   * handleAccept calls auth.getUser() first. If the user is not signed in,
   * the component shows 'error' with a "must be signed in" message.
   */
  it('shows error state when user is not signed in while accepting', async () => {
    Object.assign(mockLocalSearchParams, { token: VALID_INVITATION.token });
    setupFromSuccess(VALID_INVITATION);
    getMockSupabase().auth.getUser.mockResolvedValueOnce({
      data: { user: null },
      error: { message: 'Not authenticated' },
    });

    const instance = await mountAndSettle();

    const acceptButton = instance.root.findAll(
      (node) => node.props.accessibilityLabel === 'Accept team invitation',
    )[0];

    await act(async () => {
      if (acceptButton?.props.onPress) {
        acceptButton.props.onPress();
      }
    });

    const tree = instance.toJSON();
    expect(hasText(tree, 'Something Went Wrong')).toBe(true);
    expect(hasText(tree, 'must be signed in')).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Navigation — Go to Dashboard in invalid state
  // --------------------------------------------------------------------------

  /**
   * The "Go to Dashboard" button in the invalid state should call
   * router.replace('/(tabs)/') when pressed.
   */
  it('calls router.replace to dashboard when Go to Dashboard is pressed in invalid state', async () => {
    // No token → lands in invalid state
    const instance = await mountAndSettle();

    const dashboardButton = instance.root.findAll(
      (node) => node.props.accessibilityLabel === 'Go to dashboard',
    )[0];

    await act(async () => {
      if (dashboardButton?.props.onPress) {
        dashboardButton.props.onPress();
      }
    });

    expect(mockRouterReplace).toHaveBeenCalledWith('/(tabs)/');
  });

  // --------------------------------------------------------------------------
  // Navigation — View Team after accept
  // --------------------------------------------------------------------------

  /**
   * After a successful accept, the "View Team" button should navigate to the
   * team tab via router.replace('/(tabs)/team').
   */
  it('calls router.replace to team tab when View Team is pressed after accepting', async () => {
    Object.assign(mockLocalSearchParams, { token: VALID_INVITATION.token });
    setupFromSuccess(VALID_INVITATION); // validateToken
    setupFromEmpty();                   // update team_invitations
    setupFromEmpty();                   // upsert team_members

    const instance = await mountAndSettle();

    const acceptButton = instance.root.findAll(
      (node) => node.props.accessibilityLabel === 'Accept team invitation',
    )[0];

    await act(async () => {
      if (acceptButton?.props.onPress) {
        acceptButton.props.onPress();
      }
    });

    const viewTeamButton = instance.root.findAll(
      (node) => node.props.accessibilityLabel === 'View team',
    )[0];

    await act(async () => {
      if (viewTeamButton?.props.onPress) {
        viewTeamButton.props.onPress();
      }
    });

    expect(mockRouterReplace).toHaveBeenCalledWith('/(tabs)/team');
  });
});
