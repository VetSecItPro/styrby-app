/**
 * useCurrentUser — Supabase auth user hook.
 *
 * Provides the authenticated user's id, email, display name, and avatar
 * initial to any screen that needs them without prop-drilling through the
 * settings screen tree.
 *
 * WHY: Previously every screen that needed user info called
 * `supabase.auth.getUser()` directly and then duplicated the display-name /
 * initial extraction logic. This hook centralizes the normalization via
 * `extractUserInfo` and caches the result per component instance. Supabase
 * caches the session token in memory so repeat calls across sub-screens do
 * not hit the network.
 *
 * Extracted in S2 of the Phase 0.6.1 settings refactor.
 *
 * @see docs/planning/settings-refactor-plan-2026-04-19.md Section 4
 */

import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

/**
 * Authenticated user display data.
 */
export interface CurrentUser {
  /** Supabase user id (UUID) */
  id: string;
  /** User's email address */
  email: string;
  /** Display name from user_metadata, if available */
  displayName: string | null;
  /** Single uppercase character for the avatar badge */
  initial: string;
}

/**
 * Minimal shape of the Supabase auth user object we care about.
 * WHY: Keeping this narrow lets callers pass mock users in tests without
 * pulling the full @supabase/supabase-js User type through the mock layer.
 */
interface SupabaseAuthUser {
  id: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
}

/**
 * Extracts display information from a Supabase auth user.
 *
 * WHY: Supabase stores display_name in user_metadata but the field name
 * varies by auth provider (full_name for GitHub, display_name for email /
 * OAuth). We check the common fields in priority order and fall back to
 * email-derived initials.
 *
 * @param user - Supabase auth user
 * @returns Normalized CurrentUser
 */
export function extractUserInfo(user: SupabaseAuthUser): CurrentUser {
  const email = user.email ?? 'unknown';
  const metadata = user.user_metadata ?? {};

  const displayName =
    (metadata.display_name as string | undefined) ??
    (metadata.full_name as string | undefined) ??
    (metadata.name as string | undefined) ??
    null;

  const initial = displayName
    ? displayName.charAt(0).toUpperCase()
    : email.charAt(0).toUpperCase();

  return { id: user.id, email, displayName, initial };
}

/**
 * Hook: fetches and returns the currently authenticated Supabase user.
 *
 * @returns An object with `{ user, isLoading, error, refresh }`
 *
 * @example
 * const { user, isLoading } = useCurrentUser();
 * if (isLoading) return <ActivityIndicator />;
 * return <Text>{user?.email}</Text>;
 */
export function useCurrentUser(): {
  user: CurrentUser | null;
  isLoading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
} {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const load = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const {
        data: { user: authUser },
        error: authError,
      } = await supabase.auth.getUser();
      if (authError) {
        throw authError;
      }
      setUser(authUser ? extractUserInfo(authUser) : null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    let isMounted = true;
    (async () => {
      try {
        const {
          data: { user: authUser },
          error: authError,
        } = await supabase.auth.getUser();
        if (!isMounted) return;
        if (authError) {
          setError(authError instanceof Error ? authError : new Error(String(authError)));
          setUser(null);
        } else {
          setUser(authUser ? extractUserInfo(authUser) : null);
        }
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setUser(null);
        }
      } finally {
        if (isMounted) setIsLoading(false);
      }
    })();
    return () => {
      isMounted = false;
    };
  }, []);

  return { user, isLoading, error, refresh: load };
}
