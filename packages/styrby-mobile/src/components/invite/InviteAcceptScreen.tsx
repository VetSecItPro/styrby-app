/**
 * InviteAcceptScreen
 *
 * Orchestrator component for the invitation accept flow. Manages the
 * state machine and delegates all rendering to named sub-components.
 *
 * This component owns:
 * - State machine transitions (idle -> loading -> success | error states)
 * - Authentication check (redirect to login if no session)
 * - API call via acceptInvitationFromToken
 * - Navigation on success or terminal error
 *
 * Sub-components handle all visual rendering so this file stays under 100 LOC.
 *
 * WHY orchestrator pattern:
 * Each state has meaningfully different UI (spinner, 2 CTA buttons, terminal
 * message, etc.). Cramming all of that into one render function creates a
 * long file that is hard to test in isolation. The orchestrator stays thin and
 * readable; sub-components are independently testable.
 *
 * @see InviteLoadingState — spinner while API call is in-flight
 * @see InviteWrongAccountState — 403 EMAIL_MISMATCH recovery
 * @see InviteExpiredState — 410 EXPIRED terminal
 * @see InviteInvalidState — 404 NOT_FOUND terminal
 * @see InviteErrorState — generic failure with retry
 */

import React, { useCallback, useEffect, useState } from 'react';
import { View, Text } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { acceptInvitationFromToken } from '../../lib/handle-invite-deep-link';
import { signOut } from '../../lib/supabase';
import type { Session } from '@supabase/supabase-js';
import { InviteLoadingState } from './InviteLoadingState';
import { InviteWrongAccountState } from './InviteWrongAccountState';
import { InviteExpiredState } from './InviteExpiredState';
import { InviteInvalidState } from './InviteInvalidState';
import { InviteErrorState } from './InviteErrorState';

// ============================================================================
// Types
// ============================================================================

/**
 * Discriminated union representing every state the invite accept screen can be in.
 *
 * WHY discriminated union: impossible states (e.g. loading + error) are
 * unrepresentable. TypeScript narrows the state in each branch so sub-component
 * props are always type-safe.
 */
type InviteScreenState =
  | { phase: 'loading' }
  | { phase: 'wrong_account' }
  | { phase: 'expired' }
  | { phase: 'invalid' }
  | { phase: 'error'; message: string }
  | { phase: 'success'; teamId: string; teamName?: string };

// ============================================================================
// Component
// ============================================================================

/**
 * Orchestrator for the invite accept flow.
 *
 * Receives the `token` route param from Expo Router's file-based routing
 * (`app/invite/[token].tsx`). Checks auth, calls the web API, then renders
 * the appropriate sub-component based on the result.
 *
 * @returns React element
 */
export function InviteAcceptScreen(): React.ReactElement {
  const router = useRouter();
  const { token } = useLocalSearchParams<{ token: string }>();
  const [state, setState] = useState<InviteScreenState>({ phase: 'loading' });

  /**
   * Attempts to accept the invitation using the current Supabase session.
   *
   * Called on mount and again when the user taps Retry after a NETWORK_ERROR.
   *
   * @param session - The active Supabase session; must be non-null when called.
   */
  const attemptAccept = useCallback(
    async (session: Session) => {
      setState({ phase: 'loading' });

      const result = await acceptInvitationFromToken(token, session);

      if (result.status === 'accepted') {
        setState({ phase: 'success', teamId: result.teamId });
        // Navigate to the team tab after a brief moment so the user sees the
        // success state before the transition.
        setTimeout(() => {
          router.replace(`/(tabs)/team` as never);
        }, 1500);
        return;
      }

      // Map error codes to specific screen states
      const code = result.code;
      if (code === 'EMAIL_MISMATCH') {
        setState({ phase: 'wrong_account' });
      } else if (code === 'EXPIRED') {
        setState({ phase: 'expired' });
      } else if (code === 'NOT_FOUND') {
        setState({ phase: 'invalid' });
      } else if (code === 'ALREADY_ACCEPTED') {
        // WHY navigate to team on already-accepted: the user is already a
        // member — send them to the team tab so they can start working.
        router.replace(`/(tabs)/team` as never);
      } else {
        setState({ phase: 'error', message: result.message });
      }
    },
    [token, router],
  );

  // On mount: check auth, then attempt the accept
  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      const { data: { session } } = await supabase.auth.getSession();

      if (cancelled) return;

      if (!session) {
        // Redirect to login, preserving the token so the app returns here
        // after the user authenticates.
        router.replace(`/(auth)/login?returnTo=/invite/${token}` as never);
        return;
      }

      await attemptAccept(session);
    };

    run();

    return () => { cancelled = true; };
  }, [token, router, attemptAccept]);

  /**
   * Retry handler — re-fetches the session and re-attempts the API call.
   * Only called from InviteErrorState (network / 5xx errors).
   */
  const handleRetry = useCallback(async () => {
    // WHY: set loading synchronously BEFORE the await so the error-state
    // button disappears from the tree immediately, preventing a second
    // tap from enqueueing a concurrent fetch during the getSession await.
    setState({ phase: 'loading' });

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      router.replace(`/(auth)/login?returnTo=/invite/${token}` as never);
      return;
    }
    await attemptAccept(session);
  }, [token, router, attemptAccept]);

  /**
   * Sign out handler for the wrong-account state.
   * After signing out, Expo Router's auth guard in _layout.tsx redirects to login.
   */
  const handleSignOut = useCallback(async () => {
    await signOut();
  }, []);

  /**
   * Switch account — same as sign out on mobile (iOS doesn't have account
   * switcher for custom apps; user must sign in again with correct account).
   */
  const handleSwitchAccount = useCallback(async () => {
    await signOut();
  }, []);

  // ---- Render sub-component based on current phase ----

  switch (state.phase) {
    case 'loading':
      return <InviteLoadingState />;

    case 'wrong_account':
      return (
        <InviteWrongAccountState
          onSignOut={handleSignOut}
          onSwitchAccount={handleSwitchAccount}
        />
      );

    case 'expired':
      return <InviteExpiredState onGoHome={() => router.replace('/(tabs)/' as never)} />;

    case 'invalid':
      return <InviteInvalidState onGoHome={() => router.replace('/(tabs)/' as never)} />;

    case 'error':
      return <InviteErrorState message={state.message} onRetry={handleRetry} />;

    case 'success':
      // WHY: The navigation away happens in setTimeout after success. We show a
      // brief "You're in!" confirmation while the navigation delay elapses.
      return (
        <View
          className="flex-1 items-center justify-center px-8"
          accessibilityRole="alert"
          accessibilityLabel="Success, you have joined the team"
        >
          <Text className="text-white text-2xl font-bold text-center mb-2">
            You're in!
          </Text>
          <Text className="text-zinc-400 text-center">
            Taking you to your team...
          </Text>
        </View>
      );
  }
}
