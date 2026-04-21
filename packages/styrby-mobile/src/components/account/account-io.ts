/**
 * Account Settings — Side-Effect IO
 *
 * Thin wrappers around Supabase + the styrbyapp.com REST endpoints used by
 * the Account screen. Each function returns a discriminated result rather
 * than throwing, so the hook can map errors to user-facing Alert copy
 * without try/catch noise.
 *
 * WHY split out: keeps `use-account.ts` focused on React state; lets us
 * test the network/auth side independently in future iterations.
 */

import * as SecureStore from 'expo-secure-store';
import * as Clipboard from 'expo-clipboard';
import { supabase, signOut } from '@/lib/supabase';
import { clearPairingInfo } from '@/services/pairing';
import { getApiBaseUrl } from '@/lib/config';
import { DELETE_CONFIRMATION_PHRASE } from '@/types/account';
import { HAPTIC_PREFERENCE_KEY } from './constants';

/**
 * Standard outcome of a network operation: either success with optional
 * payload, or a tagged failure with a user-facing message and HTTP status.
 */
export type IoResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; status?: number; message: string };

/**
 * Persists `display_name` to the profiles table for the given user.
 *
 * @param userId - Supabase auth user id (UUID)
 * @param displayName - Already-trimmed display name
 */
export async function updateDisplayName(
  userId: string,
  displayName: string,
): Promise<IoResult> {
  try {
    const { error } = await supabase
      .from('profiles')
      .update({ display_name: displayName })
      .eq('id', userId);
    if (error) {
      if (__DEV__) console.error('[Account] Failed to save display name:', error);
      return { ok: false, message: 'Failed to save display name. Please try again.' };
    }
    return { ok: true, data: undefined };
  } catch {
    return { ok: false, message: 'An unexpected error occurred. Please try again.' };
  }
}

/**
 * Sends a Supabase verification email to start the email change flow.
 *
 * WHY verification flow: Supabase's built-in email change flow requires
 * the user to verify the new address before it takes effect. (OWASP A07)
 */
export async function requestEmailChange(newEmail: string): Promise<IoResult> {
  try {
    const { error } = await supabase.auth.updateUser({ email: newEmail });
    if (error) {
      // WHY: Supabase returns a descriptive error for already-registered emails.
      const message = error.message.includes('already registered')
        ? 'This email address is already in use by another account.'
        : error.message;
      return { ok: false, message };
    }
    return { ok: true, data: undefined };
  } catch (err) {
    if (__DEV__) console.error('[Account] Email change error:', err);
    return { ok: false, message: 'An unexpected error occurred. Please try again.' };
  }
}

/**
 * Sends a Supabase password reset email to the user's current address.
 */
export async function requestPasswordReset(email: string): Promise<IoResult> {
  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email);
    if (error) return { ok: false, message: error.message };
    return { ok: true, data: undefined };
  } catch (err) {
    if (__DEV__) console.error('[Account] Password reset error:', err);
    return { ok: false, message: 'An unexpected error occurred. Please try again.' };
  }
}

/**
 * Sums `cost_records.cost_usd` for the current user since the start of the
 * current calendar month.
 *
 * @returns Total spend in USD, or 0 on error/no data (non-fatal).
 */
export async function fetchMonthlySpend(userId: string): Promise<number> {
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const { data, error } = await supabase
      .from('cost_records')
      .select('cost_usd')
      .eq('user_id', userId)
      .gte('created_at', monthStart);

    if (error || !data) return 0;
    return data.reduce(
      (sum: number, record: { cost_usd: number }) => sum + (record.cost_usd ?? 0),
      0,
    );
  } catch {
    return 0;
  }
}

/**
 * Calls POST /api/account/export, copies the JSON export to the clipboard.
 *
 * WHY web API: the export endpoint uses the Supabase service role to query
 * 20 tables, write an audit log entry, and enforce hourly rate limits.
 * Reusing the server-side endpoint avoids duplicating this logic on mobile.
 */
export async function exportAccountData(): Promise<IoResult> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) {
      return { ok: false, message: 'You must be signed in to export your data.' };
    }

    const response = await fetch(`${getApiBaseUrl()}/api/account/export`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      if (response.status === 429) {
        return {
          ok: false,
          status: 429,
          message: 'You can only export your data once per hour. Please try again later.',
        };
      }
      return { ok: false, status: response.status, message: 'Failed to export your data. Please try again.' };
    }

    const exportJson = await response.text();
    await Clipboard.setStringAsync(exportJson);
    return { ok: true, data: undefined };
  } catch (err) {
    if (__DEV__) console.error('[Account] Data export error:', err);
    return {
      ok: false,
      message: 'Failed to export your data. Please check your connection and try again.',
    };
  }
}

/**
 * Calls DELETE /api/account/delete with the typed-confirmation phrase, then
 * clears local pairing/SecureStore data and signs the user out on success.
 *
 * WHY web API: the delete endpoint uses the Supabase admin client to ban
 * the user in auth.users. Mobile apps must never contain the service role
 * key. (SOC2 CC6.2, CC6.6)
 */
export async function deleteAccount(): Promise<IoResult> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) {
      return { ok: false, message: 'You must be signed in to delete your account.' };
    }

    const response = await fetch(`${getApiBaseUrl()}/api/account/delete`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ confirmation: DELETE_CONFIRMATION_PHRASE }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return {
          ok: false,
          status: 429,
          message: 'You can only attempt account deletion once per day. Please try again later.',
        };
      }
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      const errorMessage = typeof errorData.error === 'string'
        ? errorData.error
        : 'Failed to delete account. Please try again.';
      return { ok: false, status: response.status, message: errorMessage };
    }

    // Success: clear local data and sign out
    await clearPairingInfo();
    await SecureStore.deleteItemAsync(HAPTIC_PREFERENCE_KEY);
    await signOut();
    // Root layout auth listener redirects to login on signOut
    return { ok: true, data: undefined };
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : 'An unexpected error occurred. Please try again.';
    return { ok: false, message };
  }
}

/**
 * Performs the full sign-out cleanup sequence used by the Sign Out button.
 *
 * WHY clear pairing first: if signOut fails partway through, no orphan
 * pairing data remains to confuse the relay hook in _layout.
 */
export async function performSignOut(): Promise<IoResult> {
  try {
    await clearPairingInfo();
    await SecureStore.deleteItemAsync(HAPTIC_PREFERENCE_KEY);
    const { error } = await signOut();
    if (error) return { ok: false, message: error.message };
    return { ok: true, data: undefined };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'An unexpected error occurred.';
    return { ok: false, message };
  }
}
