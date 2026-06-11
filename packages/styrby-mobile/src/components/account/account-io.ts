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
import { clearStoredKeyPair } from '@/services/encryption';
import { clearDeviceId } from '@/services/offline-sync';
import { clearAllCommands } from '@/services/offline-storage';
import { clearAtRestKey } from '@/services/at-rest';
import { getApiBaseUrl } from '@/lib/config';
import { DELETE_CONFIRMATION_PHRASE } from '@/types/account';
import { THEME_PREFERENCE_KEY } from '@/contexts/ThemeContext';
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

    // Success — PERMANENT deletion: wipe ALL local data (SEC-MOB-002). The
    // account is irreversibly gone server-side, so nothing should remain on the
    // device — most importantly the E2E NaCl private key (decrypts message
    // history) and any queued command payloads. (Contrast with performSignOut,
    // which is temporary and PRESERVES the key so re-login keeps history.)
    await clearPairingInfo();                       // pairing info + token (relay creds)
    await clearStoredKeyPair();                     // E2E private key — history now moot
    await clearAtRestKey();                          // device at-rest encryption key (SEC-MOB-001)
    await clearDeviceId();                          // device identifier
    await clearAllCommands().catch(() => undefined); // queued command payloads (best-effort)
    await SecureStore.deleteItemAsync(HAPTIC_PREFERENCE_KEY);
    await SecureStore.deleteItemAsync(THEME_PREFERENCE_KEY);
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
 *
 * WHY this does NOT clear the E2E keypair (SEC-MOB-002): sign-out is TEMPORARY.
 * The NaCl private key decrypts the user's entire message history; wiping it
 * here would permanently lock the user out of past sessions after they log back
 * in. The active relay credential (pairing token) IS cleared via
 * clearPairingInfo, and the Supabase session is cleared by signOut — so logout
 * holds no live credential while preserving the ability to read history. Full
 * key destruction happens only in deleteAccount (permanent).
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
