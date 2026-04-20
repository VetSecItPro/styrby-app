/**
 * Passkeys Settings Sub-Screen
 *
 * Lets authenticated users manage their WebAuthn passkeys on mobile:
 *   - List all registered passkeys (active and revoked)
 *   - Enroll a new passkey via expo-passkey (Face ID / Touch ID / PIN)
 *   - Revoke a passkey (soft delete: update revoked_at)
 *   - Rename a passkey (update device_name)
 *
 * This screen uses the same API proxy routes as the web settings page to
 * ensure symmetric behavior. Both platforms talk to the same edge function.
 *
 * WHY soft delete:
 * The server verifier needs the credential row with revoked_at set to
 * reject a revoked credential cleanly (vs. 404 "not found"). Hard deletion
 * would cause an ambiguous 404 which is harder to distinguish from a
 * misconfigured RP ID. (SOC2 CC6.6, CC7.2)
 *
 * WHY enrollment requires an authenticated session:
 * The edge function reads user ID and email from the Supabase JWT to build
 * PublicKeyCredentialCreationOptions. Without auth the edge function returns
 * 401 and we surface a clear error.
 *
 * @see app/settings/_layout.tsx — Stack navigator that owns this route
 * @module app/settings/passkeys
 */

import {
  View,
  Text,
  Pressable,
  ScrollView,
  Alert,
  ActivityIndicator,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useState, useEffect, useCallback } from 'react';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
// See login.tsx for the rationale on using bare 'expo-passkey' over '/native'.
import ExpoPasskey from 'expo-passkey';
import { supabase } from '../../src/lib/supabase';
import { getApiBaseUrl } from '../../src/lib/config';

// ============================================================================
// Types
// ============================================================================

/**
 * Passkey row as returned by the Supabase RLS SELECT.
 */
interface PasskeyRow {
  id: string;
  credential_id: string;
  device_name: string;
  transports: string[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

// ============================================================================
// PasskeyRow component
// ============================================================================

interface PasskeyRowItemProps {
  passkey: PasskeyRow;
  onRevoke: (id: string) => void;
  onRename: (id: string, name: string) => Promise<void>;
}

/**
 * Renders a single passkey item with rename and revoke affordances.
 *
 * @param passkey - The passkey row data
 * @param onRevoke - Callback to initiate revocation
 * @param onRename - Callback to save a new name
 */
function PasskeyRowItem({ passkey, onRevoke, onRename }: PasskeyRowItemProps) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(passkey.device_name);
  const [saving, setSaving] = useState(false);

  const isRevoked = passkey.revoked_at !== null;

  /**
   * Saves the new device name if changed.
   */
  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === passkey.device_name) {
      setEditing(false);
      setName(passkey.device_name);
      return;
    }
    setSaving(true);
    await onRename(passkey.id, trimmed);
    setSaving(false);
    setEditing(false);
  }

  /**
   * Confirms revocation with an Alert before executing.
   * WHY: Revocation is irreversible from UX perspective (no "undo" button).
   * A confirmation dialog prevents accidental taps.
   */
  function handleRevokePress() {
    Alert.alert(
      'Revoke passkey?',
      `"${passkey.device_name}" will no longer be usable for sign-in. This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Revoke', style: 'destructive', onPress: () => onRevoke(passkey.id) },
      ],
    );
  }

  return (
    <View
      className={`bg-zinc-900 rounded-xl p-4 mb-3 border ${
        isRevoked ? 'border-zinc-800 opacity-50' : 'border-zinc-700'
      }`}
    >
      <View className="flex-row items-center">
        {/* Icon */}
        <View className="w-10 h-10 rounded-full bg-amber-500/10 items-center justify-center mr-3">
          <Ionicons name="key-outline" size={20} color={isRevoked ? '#71717a' : '#f59e0b'} />
        </View>

        {/* Info */}
        <View className="flex-1 min-w-0">
          {editing ? (
            <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
              <TextInput
                value={name}
                onChangeText={setName}
                className="text-white text-sm font-medium border-b border-amber-500 pb-1 mb-1"
                autoFocus
                maxLength={80}
                accessibilityLabel="Passkey device name"
                onSubmitEditing={handleSave}
              />
            </KeyboardAvoidingView>
          ) : (
            <Text className="text-white text-sm font-medium" numberOfLines={1}>
              {passkey.device_name}
            </Text>
          )}

          <Text className="text-zinc-500 text-xs mt-0.5">
            Added {new Date(passkey.created_at).toLocaleDateString()}
            {passkey.last_used_at &&
              ` - Last used ${new Date(passkey.last_used_at).toLocaleDateString()}`}
          </Text>
          {isRevoked && (
            <Text className="text-red-400 text-xs mt-0.5">Revoked</Text>
          )}
        </View>

        {/* Action buttons */}
        {!isRevoked && (
          <View className="flex-row items-center gap-3 ml-2">
            {editing ? (
              <>
                {saving ? (
                  <ActivityIndicator size="small" color="#f59e0b" />
                ) : (
                  <>
                    <Pressable
                      onPress={handleSave}
                      accessibilityLabel="Save passkey name"
                      hitSlop={8}
                    >
                      <Ionicons name="checkmark" size={20} color="#22c55e" />
                    </Pressable>
                    <Pressable
                      onPress={() => { setEditing(false); setName(passkey.device_name); }}
                      accessibilityLabel="Cancel rename"
                      hitSlop={8}
                    >
                      <Ionicons name="close" size={20} color="#71717a" />
                    </Pressable>
                  </>
                )}
              </>
            ) : (
              <>
                <Pressable
                  onPress={() => setEditing(true)}
                  accessibilityLabel={`Rename passkey ${passkey.device_name}`}
                  hitSlop={8}
                >
                  <Ionicons name="pencil-outline" size={18} color="#71717a" />
                </Pressable>
                <Pressable
                  onPress={handleRevokePress}
                  accessibilityLabel={`Revoke passkey ${passkey.device_name}`}
                  hitSlop={8}
                >
                  <Ionicons name="trash-outline" size={18} color="#71717a" />
                </Pressable>
              </>
            )}
          </View>
        )}
      </View>
    </View>
  );
}

// ============================================================================
// Main screen
// ============================================================================

/**
 * PasskeysScreen — settings sub-screen for passkey management.
 *
 * @returns React Native element
 */
export default function PasskeysScreen() {
  const [passkeys, setPasskeys] = useState<PasskeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [enrolling, setEnrolling] = useState(false);

  /**
   * Fetches all passkeys for the current user via Supabase RLS.
   * RLS ensures only the authenticated user's rows are returned.
   */
  const fetchPasskeys = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('passkeys')
      .select('id, credential_id, device_name, transports, created_at, last_used_at, revoked_at')
      .order('created_at', { ascending: false });

    if (error) {
      Alert.alert('Error', 'Failed to load passkeys.');
    } else {
      setPasskeys((data as PasskeyRow[]) ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchPasskeys();
  }, [fetchPasskeys]);

  /**
   * Passkey enrollment flow.
   *
   * 1. Fetch the Supabase JWT for the Authorization header.
   * 2. POST challenge-register to the web API proxy.
   * 3. expo-passkey.Passkey.create() triggers the native enrollment UI.
   * 4. POST verify-register with the attestation response.
   * 5. Refresh the passkey list on success.
   */
  async function handleEnroll() {
    setEnrolling(true);
    try {
      const apiBase = getApiBaseUrl();

      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;

      if (!accessToken) {
        Alert.alert('Session expired', 'Please sign in again to add a passkey.');
        return;
      }

      // 1. Get registration challenge
      const challengeRes = await fetch(`${apiBase}/api/auth/passkey/challenge`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ action: 'challenge-register' }),
      });

      if (!challengeRes.ok) {
        const err = await challengeRes.json().catch(() => ({}));
        throw new Error(err.message ?? 'Failed to get registration challenge');
      }

      const challengeData = await challengeRes.json();

      // 2. Native enrollment UI
      // expo-passkey returns a JSON-string credential per WebAuthn L3.
      const attestationJson = await ExpoPasskey.createPasskey({
        requestJson: JSON.stringify(challengeData),
      });
      const attestationResponse = JSON.parse(attestationJson);

      // 3. Verify attestation
      const verifyRes = await fetch(`${apiBase}/api/auth/passkey/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ action: 'verify-register', response: attestationResponse }),
      });

      if (!verifyRes.ok) {
        const err = await verifyRes.json().catch(() => ({}));
        throw new Error(err.message ?? 'Passkey registration failed');
      }

      Alert.alert('Passkey added', 'You can now sign in with this passkey.');
      await fetchPasskeys();
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'NotAllowedError') {
          Alert.alert('Cancelled', 'Passkey registration was cancelled.');
        } else if (error.name === 'InvalidStateError') {
          Alert.alert('Already registered', 'This passkey is already linked to your account.');
        } else {
          Alert.alert('Failed to add passkey', error.message);
        }
      } else {
        Alert.alert('Failed to add passkey', 'Please try again.');
      }
    } finally {
      setEnrolling(false);
    }
  }

  /**
   * Soft-revokes a passkey by setting revoked_at to now().
   *
   * @param id - UUID of the passkey row to revoke
   */
  async function handleRevoke(id: string) {
    const { error } = await supabase
      .from('passkeys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', id);

    if (error) {
      Alert.alert('Error', 'Failed to revoke passkey.');
    } else {
      setPasskeys((prev) =>
        prev.map((p) => (p.id === id ? { ...p, revoked_at: new Date().toISOString() } : p)),
      );
    }
  }

  /**
   * Renames a passkey's device_name label.
   *
   * @param id - UUID of the passkey row
   * @param name - New display name (max 80 chars)
   */
  async function handleRename(id: string, name: string) {
    const { error } = await supabase
      .from('passkeys')
      .update({ device_name: name })
      .eq('id', id);

    if (error) {
      Alert.alert('Error', 'Failed to rename passkey.');
    } else {
      setPasskeys((prev) => prev.map((p) => (p.id === id ? { ...p, device_name: name } : p)));
    }
  }

  const activePasskeys = passkeys.filter((p) => !p.revoked_at);
  const revokedPasskeys = passkeys.filter((p) => p.revoked_at);

  return (
    <>
      {/* Screen header */}
      <Stack.Screen options={{ title: 'Passkeys' }} />

      <ScrollView
        className="flex-1 bg-background"
        contentContainerStyle={{ padding: 16 }}
        keyboardShouldPersistTaps="handled"
      >
        {/* Intro */}
        <Text className="text-zinc-400 text-sm mb-6">
          Passkeys let you sign in with Face ID, Touch ID, or your device PIN. They are
          phishing-resistant and work across your synced devices.
        </Text>

        {/* Add passkey button */}
        <Pressable
          onPress={handleEnroll}
          disabled={enrolling}
          className={`flex-row items-center justify-center py-4 rounded-xl mb-6 ${
            enrolling ? 'bg-amber-500/50' : 'bg-amber-500'
          }`}
          accessibilityRole="button"
          accessibilityLabel="Add a passkey"
        >
          {enrolling ? (
            <>
              <ActivityIndicator color="white" />
              <Text className="text-white font-semibold text-base ml-2">
                Follow the prompt...
              </Text>
            </>
          ) : (
            <>
              <Ionicons name="add" size={20} color="white" />
              <Text className="text-white font-semibold text-base ml-2">
                Add a passkey
              </Text>
            </>
          )}
        </Pressable>

        {/* Active passkeys */}
        <Text className="text-zinc-500 text-xs font-medium uppercase tracking-wide mb-3">
          Active passkeys
        </Text>

        {loading ? (
          <View className="items-center py-8">
            <ActivityIndicator color="#f59e0b" />
            <Text className="text-zinc-500 text-sm mt-2">Loading passkeys...</Text>
          </View>
        ) : activePasskeys.length === 0 ? (
          <View className="bg-zinc-900 rounded-xl p-6 items-center border border-dashed border-zinc-700 mb-6">
            <Ionicons name="key-outline" size={32} color="#71717a" />
            <Text className="text-zinc-400 text-sm text-center mt-2">
              No passkeys registered yet.
            </Text>
            <Text className="text-zinc-600 text-xs text-center mt-1">
              Tap "Add a passkey" above to enable biometric sign-in.
            </Text>
          </View>
        ) : (
          <View className="mb-6">
            {activePasskeys.map((pk) => (
              <PasskeyRowItem
                key={pk.id}
                passkey={pk}
                onRevoke={handleRevoke}
                onRename={handleRename}
              />
            ))}
          </View>
        )}

        {/* Revoked passkeys */}
        {revokedPasskeys.length > 0 && (
          <View className="mt-2">
            <Text className="text-zinc-500 text-xs font-medium uppercase tracking-wide mb-3">
              Revoked ({revokedPasskeys.length})
            </Text>
            {revokedPasskeys.map((pk) => (
              <PasskeyRowItem
                key={pk.id}
                passkey={pk}
                onRevoke={handleRevoke}
                onRename={handleRename}
              />
            ))}
          </View>
        )}

        {/* Cross-device notice */}
        <Text className="text-zinc-600 text-xs text-center mt-6 px-2">
          Passkeys sync via iCloud Keychain or Google Password Manager. Revoking removes access
          immediately across all devices.
        </Text>
      </ScrollView>
    </>
  );
}
