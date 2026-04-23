/**
 * Tests for useInviteLinkHandler hook.
 *
 * Written BEFORE implementation (TDD — RED phase).
 *
 * Verifies:
 * - Subscribes to Linking.addEventListener on mount
 * - Unsubscribes via returned subscription.remove() on unmount
 * - Navigates to /invite/[token] when a matching invite URL arrives
 * - Does NOT navigate for non-invite URLs
 * - Reads Linking.getInitialURL() on cold start and navigates if it matches
 *
 * WHY a custom hook test vs integration test: The hook encapsulates all
 * Linking subscription lifecycle. Testing it in isolation ensures we don't
 * leak subscriptions and verifies the navigation trigger without a full
 * render tree.
 */

import { renderHook, act } from '@testing-library/react-native';

// ============================================================================
// Fixtures
// ============================================================================

const VALID_TOKEN = 'a'.repeat(64);
const INVITE_URL_HTTPS = `https://styrbyapp.com/invite/${VALID_TOKEN}`;
const INVITE_URL_SCHEME = `styrby://invite/${VALID_TOKEN}`;
const UNRELATED_URL = 'https://styrbyapp.com/dashboard';

// ============================================================================
// Mocks
// ============================================================================

/**
 * Mutable store for the URL addEventListener callback so tests can fire events.
 * Prefixed `mock` per Babel hoisting rules.
 */
const mockLinkingCallbacks: Array<(event: { url: string }) => void> = [];
const mockRemoveFn = jest.fn();
const mockGetInitialURL = jest.fn(async () => null as string | null);

jest.mock('expo-linking', () => ({
  addEventListener: jest.fn((_event: string, cb: (e: { url: string }) => void) => {
    mockLinkingCallbacks.push(cb);
    return { remove: mockRemoveFn };
  }),
  getInitialURL: jest.fn(async () => mockGetInitialURL()),
  createURL: jest.fn((path: string) => `styrby://${path}`),
  openURL: jest.fn(async () => {}),
}));

const mockRouterPush = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: mockRouterPush,
    replace: jest.fn(),
    back: jest.fn(),
  }),
  router: {
    push: mockRouterPush,
    replace: jest.fn(),
    back: jest.fn(),
  },
}));

// ============================================================================
// Import hook AFTER mocks
// ============================================================================

import { useInviteLinkHandler } from '../useInviteLinkHandler';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Fires a URL event to all registered Linking callbacks.
 *
 * @param url - The URL to fire
 */
function fireLinkingEvent(url: string) {
  for (const cb of mockLinkingCallbacks) {
    cb({ url });
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('useInviteLinkHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset the callback array
    mockLinkingCallbacks.length = 0;
    // Default: no initial URL
    mockGetInitialURL.mockResolvedValue(null);
  });

  // --------------------------------------------------------------------------
  // Subscription lifecycle
  // --------------------------------------------------------------------------

  it('subscribes to Linking url events on mount', () => {
    const { unmount } = renderHook(() => useInviteLinkHandler());

    const Linking = require('expo-linking');
    expect(Linking.addEventListener).toHaveBeenCalledWith('url', expect.any(Function));

    unmount();
  });

  it('calls subscription.remove() on unmount', () => {
    const { unmount } = renderHook(() => useInviteLinkHandler());

    expect(mockRemoveFn).not.toHaveBeenCalled();
    unmount();
    expect(mockRemoveFn).toHaveBeenCalledTimes(1);
  });

  // --------------------------------------------------------------------------
  // Warm-start navigation — matching URLs
  // --------------------------------------------------------------------------

  it('navigates to /invite/[token] when an https invite URL event fires', async () => {
    renderHook(() => useInviteLinkHandler());

    await act(async () => {
      fireLinkingEvent(INVITE_URL_HTTPS);
    });

    expect(mockRouterPush).toHaveBeenCalledWith(`/invite/${VALID_TOKEN}`);
  });

  it('navigates to /invite/[token] when a styrby:// scheme invite URL event fires', async () => {
    renderHook(() => useInviteLinkHandler());

    await act(async () => {
      fireLinkingEvent(INVITE_URL_SCHEME);
    });

    expect(mockRouterPush).toHaveBeenCalledWith(`/invite/${VALID_TOKEN}`);
  });

  // --------------------------------------------------------------------------
  // Warm-start — non-matching URLs ignored
  // --------------------------------------------------------------------------

  it('does not navigate when an unrelated URL event fires', async () => {
    renderHook(() => useInviteLinkHandler());

    await act(async () => {
      fireLinkingEvent(UNRELATED_URL);
    });

    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Cold-start — getInitialURL
  // --------------------------------------------------------------------------

  it('navigates on cold start when getInitialURL returns an invite URL', async () => {
    mockGetInitialURL.mockResolvedValue(INVITE_URL_HTTPS);

    // WHY renderHook outside act + manual flush:
    // @testing-library/react-native's act() unmounts the hook immediately when
    // renderHook is called inside act(async). Instead, we mount outside act and
    // flush the pending getInitialURL promise by flushing the microtask queue.
    const { unmount } = renderHook(() => useInviteLinkHandler());
    // Flush the getInitialURL() promise resolution
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockRouterPush).toHaveBeenCalledWith(`/invite/${VALID_TOKEN}`);
    unmount();
  });

  it('does not navigate on cold start when getInitialURL returns null', async () => {
    mockGetInitialURL.mockResolvedValue(null);

    const { unmount } = renderHook(() => useInviteLinkHandler());
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockRouterPush).not.toHaveBeenCalled();
    unmount();
  });

  it('does not navigate on cold start when getInitialURL returns an unrelated URL', async () => {
    mockGetInitialURL.mockResolvedValue(UNRELATED_URL);

    const { unmount } = renderHook(() => useInviteLinkHandler());
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockRouterPush).not.toHaveBeenCalled();
    unmount();
  });

  // --------------------------------------------------------------------------
  // De-duplication — Android cold-start double-fire guard
  // --------------------------------------------------------------------------

  it('calls router.push exactly once when getInitialURL and the url event both fire the same token (Android cold-start race)', async () => {
    // Simulate Android App Links cold start: getInitialURL resolves to the
    // invite URL AND the 'url' event fires for the same URL before React
    // has had a chance to navigate. Without the de-dup guard, router.push
    // would be called twice, mounting InviteAcceptScreen twice and firing
    // two concurrent acceptInvitationFromToken requests.
    mockGetInitialURL.mockResolvedValue(INVITE_URL_HTTPS);

    const { unmount } = renderHook(() => useInviteLinkHandler());

    await act(async () => {
      // Flush the getInitialURL() promise (cold start path)
      await Promise.resolve();
      // Immediately fire the warm-start 'url' event for the same URL
      fireLinkingEvent(INVITE_URL_HTTPS);
    });

    // router.push must have been called exactly once despite both paths firing
    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).toHaveBeenCalledWith(`/invite/${VALID_TOKEN}`);
    unmount();
  });

  it('de-dupes by token, not by URL form — https and styrby:// for the same token count as one', async () => {
    // The handled Set is keyed on the extracted token, so the same token
    // arriving via different URL schemes (universal link vs custom scheme)
    // must still only navigate once.
    mockGetInitialURL.mockResolvedValue(INVITE_URL_HTTPS);

    const { unmount } = renderHook(() => useInviteLinkHandler());

    await act(async () => {
      await Promise.resolve();
      // Fire the styrby:// form of the same token
      fireLinkingEvent(INVITE_URL_SCHEME);
    });

    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).toHaveBeenCalledWith(`/invite/${VALID_TOKEN}`);
    unmount();
  });
});
