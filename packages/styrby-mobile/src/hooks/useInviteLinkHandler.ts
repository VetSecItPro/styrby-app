/**
 * useInviteLinkHandler Hook
 *
 * Handles team invitation deep-link URLs on both cold start and warm start.
 *
 * Cold start: When the app is launched by tapping an invite link, iOS/Android
 * passes the URL to `Linking.getInitialURL()`. We read it once on mount and
 * navigate if it matches an invite pattern.
 *
 * Warm start: When the app is already running and an invite link is tapped,
 * iOS/Android fires the `url` event via `Linking.addEventListener`. We
 * subscribe on mount and unsubscribe on unmount to prevent memory leaks.
 *
 * WHY a hook (not inline in _layout.tsx):
 * - Testable in isolation: renderHook() mocks Linking and asserts navigation
 * - Reusable: can be moved to any screen if the linking architecture changes
 * - Single Responsibility: _layout.tsx stays focused on auth/onboarding routing
 *
 * WHY router.push (not router.replace):
 * We push onto the stack so the user can go back to wherever they were when
 * the invite link arrived. Replace would destroy that back-navigation history.
 *
 * @example
 * // In app/_layout.tsx (called once at root)
 * useInviteLinkHandler();
 */

import { useEffect, useRef, useCallback } from 'react';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { extractInviteToken } from '../lib/handle-invite-deep-link';

/**
 * Registers deep-link listeners for team invitation URLs.
 *
 * Reads the initial URL on cold start and subscribes to URL events for
 * warm start. Navigates to `/invite/[token]` when a matching URL is detected.
 *
 * Must be called exactly once at the app root (e.g. `_layout.tsx`).
 * Cleans up the subscription automatically on unmount.
 *
 * @returns void — the hook operates via side effects only
 */
export function useInviteLinkHandler(): void {
  const router = useRouter();

  /**
   * Tracks tokens that have already triggered navigation this session.
   *
   * WHY a ref (not state): we don't want to re-render when the set changes,
   * we just need a stable mutable reference across the effect closure lifetime.
   */
  const handled = useRef<Set<string>>(new Set());

  /**
   * Routes an incoming URL to the invite screen if it is a valid invite link.
   *
   * De-duplicates by token so that Android App Links cold-start (which can fire
   * BOTH getInitialURL AND the 'url' event for the same URL) only triggers one
   * router.push, preventing InviteAcceptScreen from mounting twice.
   *
   * @param url - The full URL string (universal link or custom scheme)
   */
  const handleUrl = useCallback((url: string | null): void => {
    if (!url) return;

    const token = extractInviteToken(url);
    if (!token) return;

    // WHY: Android App Links can fire BOTH getInitialURL AND the 'url'
    // event for the same cold-start URL. Without this guard, router.push
    // is called twice, mounting InviteAcceptScreen twice, firing two
    // concurrent accept API calls. The Set is keyed on the raw token
    // (not the URL) so the same token from different URL forms
    // (https vs styrby://) still de-dupes.
    if (handled.current.has(token)) return;
    handled.current.add(token);

    // WHY router.push: preserves navigation history so the user can dismiss
    // the invite screen and return to what they were doing.
    router.push(`/invite/${token}` as never);
  }, [router]);

  useEffect(() => {
    // Cold start: the app was launched by tapping the invite link.
    // getInitialURL() resolves to the launch URL, or null if the app was
    // opened normally.
    Linking.getInitialURL().then((url) => {
      handleUrl(url);
    });

    // Warm start: the app was already running when the invite link was tapped.
    const subscription = Linking.addEventListener('url', ({ url }) => {
      handleUrl(url);
    });

    return () => {
      // WHY explicit removal: Linking listeners are global. Without cleanup,
      // multiple hook instances (e.g. during hot reload) would accumulate
      // listeners and fire duplicate navigation calls for a single URL event.
      subscription.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // WHY empty deps: We intentionally run this effect only on mount/unmount.
  // handleUrl is stable (only uses router which is stable from useRouter),
  // and re-registering the listener on every render would cause duplicate events.
}
