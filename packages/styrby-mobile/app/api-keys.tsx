/**
 * API Keys Screen
 *
 * Full-screen management interface for the user's API keys.
 *
 * Features:
 * - List view showing name, key prefix (sk_...xxxx), created date, last used
 * - FAB to create a new key (name input form)
 * - After creation: one-time modal showing the full plaintext key with
 *   "Copy" button and native Share sheet
 * - Revoke/delete with confirmation Alert
 * - Power-tier gate — non-Power users see an upgrade prompt
 * - Pull-to-refresh
 *
 * Security: the plaintext key is shown ONCE in the post-creation modal and
 * is never stored in state beyond the modal's lifetime.
 *
 * Navigated to from Settings > Developer Tools section.
 */

import { useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  Pressable,
  Modal,
  ScrollView,
  TextInput,
  Alert,
  ActivityIndicator,
  RefreshControl,
  KeyboardAvoidingView,
  Platform,
  Linking,
  Share,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { z } from 'zod';
import {
  useApiKeys,
  type ApiKey,
  type CreateApiKeyInput,
} from '../src/hooks/useApiKeys';

// ============================================================================
// Constants
// ============================================================================

/**
 * Expiration options available in the create-key form.
 */
const EXPIRATION_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: 'Never expires' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
  { value: 180, label: '180 days' },
  { value: 365, label: '1 year' },
];

/**
 * Zod schema for the create-key form.
 */
const CreateKeyFormSchema = z.object({
  name: z
    .string()
    .min(1, 'Name is required')
    .max(100, 'Name must be 100 characters or less'),
});

// ============================================================================
// Helpers
// ============================================================================

/**
 * Formats an ISO 8601 date string into a short human-readable label.
 *
 * @param iso - ISO 8601 date string, or null
 * @param fallback - String to return when iso is null
 * @returns Formatted date string (e.g., "Mar 29, 2026") or the fallback
 */
function formatDate(iso: string | null, fallback = 'Never'): string {
  if (!iso) return fallback;
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

/**
 * Masks a plaintext API key to show only the prefix and last 4 characters.
 * Used as a display hint for the one-time reveal modal.
 *
 * @param secret - The full plaintext API key
 * @returns Masked display string (e.g., "sk_live_...a4b2")
 */
function maskSecret(secret: string): string {
  if (secret.length <= 12) return secret;
  const last4 = secret.slice(-4);
  const prefix = secret.slice(0, 10);
  return `${prefix}...${last4}`;
}

// ============================================================================
// Sub-Components
// ============================================================================

interface ApiKeyListItemProps {
  /** The API key record to display */
  apiKey: ApiKey;
  /** Called when the revoke button is pressed */
  onRevoke: (apiKey: ApiKey) => void;
}

/**
 * A single row in the API keys list.
 *
 * Shows: name, key prefix, scopes, created date, last used, revoked badge.
 *
 * @param props - Component props
 * @returns React element
 */
function ApiKeyListItem({ apiKey, onRevoke }: ApiKeyListItemProps) {
  const isRevoked = apiKey.revoked_at !== null;
  const isExpired =
    apiKey.expires_at !== null && new Date(apiKey.expires_at) < new Date();

  return (
    <View
      className="bg-zinc-900 rounded-2xl p-4 mb-3 mx-4"
      style={{ opacity: isRevoked || isExpired ? 0.5 : 1 }}
      accessibilityRole="summary"
      accessibilityLabel={`API key ${apiKey.name}, prefix ${apiKey.key_prefix}, ${isRevoked ? 'revoked' : isExpired ? 'expired' : 'active'}`}
    >
      {/* Header: name + status badge */}
      <View className="flex-row items-center justify-between mb-1">
        <Text className="text-white font-semibold text-base flex-1 mr-2" numberOfLines={1}>
          {apiKey.name}
        </Text>
        {isRevoked ? (
          <View className="bg-red-500/20 px-2 py-0.5 rounded-full">
            <Text style={{ color: '#ef4444', fontSize: 11, fontWeight: '600' }}>
              Revoked
            </Text>
          </View>
        ) : isExpired ? (
          <View className="bg-orange-500/20 px-2 py-0.5 rounded-full">
            <Text style={{ color: '#fb923c', fontSize: 11, fontWeight: '600' }}>
              Expired
            </Text>
          </View>
        ) : (
          <View className="bg-green-500/20 px-2 py-0.5 rounded-full">
            <Text style={{ color: '#4ade80', fontSize: 11, fontWeight: '600' }}>
              Active
            </Text>
          </View>
        )}
      </View>

      {/* Key prefix */}
      <Text className="text-zinc-400 font-mono text-sm mb-2">{apiKey.key_prefix}</Text>

      {/* Scopes */}
      <View className="flex-row mb-2">
        {apiKey.scopes.map((scope) => (
          <View key={scope} className="bg-zinc-800 px-2 py-0.5 rounded mr-1">
            <Text style={{ color: '#a1a1aa', fontSize: 11, fontWeight: '600' }}>
              {scope}
            </Text>
          </View>
        ))}
      </View>

      {/* Footer */}
      <View className="flex-row items-center justify-between">
        <View>
          <Text className="text-zinc-500 text-xs">
            Created {formatDate(apiKey.created_at)}
          </Text>
          <Text className="text-zinc-600 text-xs">
            Last used: {formatDate(apiKey.last_used_at, 'Never')}
          </Text>
        </View>
        {!isRevoked && (
          <Pressable
            onPress={() => onRevoke(apiKey)}
            className="p-2 active:opacity-60"
            accessibilityRole="button"
            accessibilityLabel={`Revoke API key ${apiKey.name}`}
            hitSlop={8}
          >
            <Ionicons name="trash-outline" size={18} color="#71717a" />
          </Pressable>
        )}
      </View>
    </View>
  );
}

// ============================================================================
// Create Key Form Sheet
// ============================================================================

interface CreateFormSheetProps {
  /** Whether the sheet is visible */
  visible: boolean;
  /** Close without saving */
  onClose: () => void;
  /** Submit the form */
  onSave: (input: CreateApiKeyInput) => Promise<void>;
  /** True while the save operation is in progress */
  isSaving: boolean;
}

/**
 * Bottom-sheet style modal for creating a new API key.
 *
 * Contains: name input, expiration picker.
 * Validates with Zod before saving.
 *
 * @param props - Form sheet props
 * @returns React element
 */
function CreateKeyFormSheet({ visible, onClose, onSave, isSaving }: CreateFormSheetProps) {
  const [name, setName] = useState('');
  const [expiresInDays, setExpiresInDays] = useState<number | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  /**
   * Resets the form.
   */
  const resetForm = useCallback(() => {
    setName('');
    setExpiresInDays(null);
    setValidationError(null);
  }, []);

  /**
   * Validates form data and triggers the save callback.
   */
  const handleSave = useCallback(async () => {
    setValidationError(null);

    const result = CreateKeyFormSchema.safeParse({ name: name.trim() });

    if (!result.success) {
      setValidationError(result.error.issues[0]?.message ?? 'Invalid form data');
      return;
    }

    await onSave({
      name: result.data.name,
      scopes: ['read'],
      expires_in_days: expiresInDays,
    });

    resetForm();
  }, [name, expiresInDays, onSave, resetForm]);

  /**
   * Closes the sheet and resets form state.
   */
  const handleClose = useCallback(() => {
    resetForm();
    onClose();
  }, [onClose, resetForm]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1 bg-zinc-950"
      >
        {/* Header */}
        <View className="flex-row items-center justify-between px-4 py-4 border-b border-zinc-800">
          <Pressable
            onPress={handleClose}
            className="p-1 active:opacity-60"
            accessibilityRole="button"
            accessibilityLabel="Cancel and close"
          >
            <Text className="text-zinc-400 text-base">Cancel</Text>
          </Pressable>
          <Text className="text-white font-semibold text-lg">New API Key</Text>
          <Pressable
            onPress={handleSave}
            disabled={isSaving}
            className="p-1 active:opacity-60"
            accessibilityRole="button"
            accessibilityLabel="Create API key"
          >
            {isSaving ? (
              <ActivityIndicator size="small" color="#f97316" />
            ) : (
              <Text className="text-brand font-semibold text-base">Create</Text>
            )}
          </Pressable>
        </View>

        <ScrollView
          className="flex-1 px-4 pt-4"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Validation Error */}
          {validationError && (
            <View className="bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2 mb-4">
              <Text className="text-red-400 text-sm">{validationError}</Text>
            </View>
          )}

          {/* Security notice */}
          <View className="bg-orange-500/10 border border-orange-500/30 rounded-xl px-3 py-3 mb-4 flex-row items-start">
            <Ionicons name="warning" size={16} color="#fb923c" style={{ marginTop: 1 }} />
            <Text className="text-orange-400 text-sm ml-2 flex-1">
              The API key will be shown <Text className="font-bold">once</Text> after
              creation. Copy it immediately — you will not be able to retrieve it again.
            </Text>
          </View>

          {/* Name */}
          <Text className="text-zinc-400 text-xs font-semibold uppercase mb-2">
            Key Name
          </Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="CI Integration"
            placeholderTextColor="#52525b"
            className="bg-zinc-900 text-white rounded-xl px-4 py-3 mb-4"
            autoCapitalize="words"
            returnKeyType="done"
            accessibilityLabel="API key name"
          />

          {/* Expiration */}
          <Text className="text-zinc-400 text-xs font-semibold uppercase mb-2">
            Expiration
          </Text>
          <View className="bg-zinc-900 rounded-2xl mb-8 overflow-hidden">
            {EXPIRATION_OPTIONS.map((option, index) => {
              const isSelected = expiresInDays === option.value;
              return (
                <Pressable
                  key={`exp-${option.value ?? 'never'}`}
                  onPress={() => setExpiresInDays(option.value)}
                  className={`flex-row items-center px-4 py-3 active:bg-zinc-800 ${
                    index < EXPIRATION_OPTIONS.length - 1 ? 'border-b border-zinc-800' : ''
                  }`}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: isSelected }}
                  accessibilityLabel={`Set expiration to ${option.label}`}
                >
                  <View
                    className="w-5 h-5 rounded-full border-2 items-center justify-center mr-3"
                    style={{
                      borderColor: isSelected ? '#f97316' : '#3f3f46',
                    }}
                  >
                    {isSelected && (
                      <View
                        className="w-2.5 h-2.5 rounded-full"
                        style={{ backgroundColor: '#f97316' }}
                      />
                    )}
                  </View>
                  <Text className="text-white text-sm">{option.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ============================================================================
// Secret Reveal Modal
// ============================================================================

interface SecretModalProps {
  /** The plaintext API key to display, or null when hidden */
  secret: string | null;
  /** The name of the newly created key */
  keyName: string;
  /** Called when the user dismisses the modal */
  onClose: () => void;
}

/**
 * One-time reveal modal for the newly created API key's plaintext secret.
 *
 * WHY: Styrby hashes API keys with bcrypt after creation. This is the only
 * time the plaintext is available. We show it in a focused modal with a
 * prominent copy button and a clear warning to save it before dismissing.
 *
 * @param props - Modal props
 * @returns React element
 */
function SecretRevealModal({ secret, keyName, onClose }: SecretModalProps) {
  const [copied, setCopied] = useState(false);

  /**
   * Copies the plaintext key to the clipboard and shows confirmation.
   */
  const handleCopy = useCallback(async () => {
    if (!secret) return;
    await Clipboard.setStringAsync(secret);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }, [secret]);

  /**
   * Opens the native share sheet with the API key.
   */
  const handleShare = useCallback(async () => {
    if (!secret) return;
    try {
      await Share.share({
        message: `Styrby API Key (${keyName}): ${secret}`,
        title: 'Styrby API Key',
      });
    } catch {
      // User cancelled share — no action needed
    }
  }, [secret, keyName]);

  /**
   * Confirms the user has saved the key before closing.
   */
  const handleClose = useCallback(() => {
    Alert.alert(
      'Have you saved your key?',
      'Once you close this dialog, you will not be able to see the full key again.',
      [
        { text: 'Go Back', style: 'cancel' },
        { text: "Yes, I've saved it", style: 'destructive', onPress: onClose },
      ]
    );
  }, [onClose]);

  return (
    <Modal
      visible={secret !== null}
      animationType="fade"
      transparent
      onRequestClose={handleClose}
    >
      <View
        className="flex-1 items-center justify-center px-6"
        style={{ backgroundColor: 'rgba(0,0,0,0.85)' }}
      >
        <View className="bg-zinc-900 rounded-3xl p-6 w-full max-w-sm">
          {/* Icon */}
          <View className="w-14 h-14 rounded-2xl bg-green-500/15 items-center justify-center mb-4 self-center">
            <Ionicons name="key" size={28} color="#4ade80" />
          </View>

          <Text className="text-white font-bold text-xl text-center mb-1">
            API Key Created
          </Text>
          <Text className="text-zinc-400 text-sm text-center mb-4">
            Copy your API key now. This is the <Text className="font-bold text-white">only time</Text>{' '}
            it will be shown in full.
          </Text>

          {/* Key display */}
          <View className="bg-zinc-950 rounded-xl px-3 py-3 mb-4">
            <Text
              className="text-green-400 font-mono text-xs"
              selectable
              numberOfLines={3}
            >
              {secret ?? ''}
            </Text>
          </View>

          {/* Masked hint */}
          <Text className="text-zinc-500 text-xs text-center mb-4">
            After closing, only{' '}
            <Text className="font-mono">{secret ? maskSecret(secret) : ''}</Text>{' '}
            will be visible.
          </Text>

          {/* Actions */}
          <View className="gap-3">
            <Pressable
              onPress={handleCopy}
              className="bg-brand rounded-xl py-3 items-center flex-row justify-center active:opacity-80"
              accessibilityRole="button"
              accessibilityLabel="Copy API key to clipboard"
            >
              <Ionicons
                name={copied ? 'checkmark' : 'copy-outline'}
                size={18}
                color="white"
              />
              <Text className="text-white font-semibold ml-2">
                {copied ? 'Copied!' : 'Copy to Clipboard'}
              </Text>
            </Pressable>
            <Pressable
              onPress={handleShare}
              className="bg-zinc-800 rounded-xl py-3 items-center flex-row justify-center active:opacity-80"
              accessibilityRole="button"
              accessibilityLabel="Share API key"
            >
              <Ionicons name="share-outline" size={18} color="#a1a1aa" />
              <Text className="text-zinc-300 font-semibold ml-2">Share</Text>
            </Pressable>
            <Pressable
              onPress={handleClose}
              className="py-3 items-center active:opacity-60"
              accessibilityRole="button"
              accessibilityLabel="Close and discard key"
            >
              <Text className="text-zinc-500 text-sm">I have saved it — close</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ============================================================================
// Power Tier Gate
// ============================================================================

/**
 * Full-screen upgrade prompt shown to non-Power-tier users.
 *
 * @returns React element
 */
function PowerTierGate() {
  return (
    <View className="flex-1 bg-background items-center justify-center px-8">
      <View className="w-20 h-20 rounded-3xl bg-orange-500/15 items-center justify-center mb-6">
        <Ionicons name="code-slash" size={40} color="#f97316" />
      </View>
      <Text className="text-white text-2xl font-bold text-center mb-2">
        Power Plan Required
      </Text>
      <Text className="text-zinc-400 text-center mb-6">
        API keys are available on the Power plan. Build integrations and automate
        your Styrby workflow with direct API access.
      </Text>
      <Pressable
        className="bg-brand px-8 py-4 rounded-2xl active:opacity-80"
        onPress={() =>
          Linking.openURL('https://polar.sh/styrby/portal').catch(() => null)
        }
        accessibilityRole="button"
        accessibilityLabel="Upgrade to Power plan"
      >
        <Text className="text-white font-bold text-base">Upgrade to Power</Text>
      </Pressable>
    </View>
  );
}

// ============================================================================
// Screen
// ============================================================================

/**
 * API Keys screen.
 *
 * Renders the user's API key list with create and revoke capabilities.
 * Non-Power-tier users see an upgrade prompt.
 *
 * @returns React element
 */
export default function ApiKeysScreen() {
  const {
    keys,
    isLoading,
    isMutating,
    error,
    isPowerTier,
    keyLimit,
    keyCount,
    refresh,
    createKey,
    revokeKey,
  } = useApiKeys();

  const [isFormVisible, setIsFormVisible] = useState(false);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [createdKeyName, setCreatedKeyName] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);

  const canCreate = keyLimit === 0 || keyCount < keyLimit;

  // --------------------------------------------------------------------------
  // Handlers
  // --------------------------------------------------------------------------

  /**
   * Handles creation of a new API key.
   * On success, shows the one-time secret modal.
   *
   * @param input - Create key form data
   */
  const handleCreateKey = useCallback(
    async (input: CreateApiKeyInput): Promise<void> => {
      const result = await createKey(input);
      if (result) {
        setIsFormVisible(false);
        setCreatedKeyName(input.name);
        setRevealedSecret(result.secret);
      } else {
        Alert.alert('Error', 'Failed to create API key. Please try again.');
      }
    },
    [createKey]
  );

  /**
   * Prompts for confirmation then revokes an API key.
   *
   * @param apiKey - The key to revoke
   */
  const handleRevoke = useCallback(
    (apiKey: ApiKey) => {
      Alert.alert(
        'Revoke API Key?',
        `Are you sure you want to revoke "${apiKey.name}"? Any integrations using this key will immediately stop working.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Revoke',
            style: 'destructive',
            onPress: async () => {
              const success = await revokeKey(apiKey.id);
              if (!success) {
                Alert.alert('Error', 'Failed to revoke API key. Please try again.');
              }
            },
          },
        ]
      );
    },
    [revokeKey]
  );

  /**
   * Dismisses the secret modal and clears the in-memory plaintext.
   *
   * WHY: We zero out the secret state immediately when the user closes the
   * modal so the plaintext key doesn't linger in memory any longer than
   * necessary.
   */
  const handleSecretModalClose = useCallback(() => {
    setRevealedSecret(null);
    setCreatedKeyName('');
  }, []);

  /**
   * Handles pull-to-refresh.
   */
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await refresh();
    setIsRefreshing(false);
  }, [refresh]);

  // --------------------------------------------------------------------------
  // Render: Loading
  // --------------------------------------------------------------------------

  if (isLoading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="large" color="#f97316" />
        <Text className="text-zinc-500 mt-4">Loading API keys...</Text>
      </View>
    );
  }

  // --------------------------------------------------------------------------
  // Render: Power Tier Gate
  // --------------------------------------------------------------------------

  if (!isPowerTier) {
    return <PowerTierGate />;
  }

  // --------------------------------------------------------------------------
  // Render: Error (no data)
  // --------------------------------------------------------------------------

  if (error && keys.length === 0) {
    return (
      <View className="flex-1 bg-background items-center justify-center px-6">
        <Ionicons name="alert-circle-outline" size={48} color="#ef4444" />
        <Text className="text-white text-lg font-semibold mt-4">
          Failed to Load API Keys
        </Text>
        <Text className="text-zinc-500 text-center mt-2">{error}</Text>
        <Pressable
          onPress={refresh}
          className="bg-brand px-6 py-3 rounded-xl mt-6 active:opacity-80"
          accessibilityRole="button"
          accessibilityLabel="Retry loading API keys"
        >
          <Text className="text-white font-semibold">Try Again</Text>
        </Pressable>
      </View>
    );
  }

  // --------------------------------------------------------------------------
  // Render: Main
  // --------------------------------------------------------------------------

  return (
    <View className="flex-1 bg-background">
      {/* Info bar */}
      <View className="px-4 py-3 border-b border-zinc-800/50">
        <Text className="text-zinc-400 text-sm">
          {keyCount} / {keyLimit} active keys.{' '}
          Keys are hashed immediately — save the plaintext when you create one.
        </Text>
      </View>

      <FlatList
        data={keys}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <ApiKeyListItem apiKey={item} onRevoke={handleRevoke} />
        )}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            tintColor="#f97316"
            colors={['#f97316']}
          />
        }
        contentContainerStyle={
          keys.length === 0 ? { flexGrow: 1 } : { paddingTop: 12, paddingBottom: 100 }
        }
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <View className="flex-1 items-center justify-center py-20 px-6">
            <Ionicons name="code-slash-outline" size={48} color="#3f3f46" />
            <Text className="text-zinc-400 font-semibold text-lg mt-4">
              No API keys yet
            </Text>
            <Text className="text-zinc-500 text-center mt-2">
              Create an API key to build integrations and automate your
              Styrby workflow programmatically.
            </Text>
            <Pressable
              onPress={() => setIsFormVisible(true)}
              className="bg-brand px-6 py-3 rounded-xl mt-6 active:opacity-80 flex-row items-center"
              accessibilityRole="button"
              accessibilityLabel="Create your first API key"
            >
              <Ionicons name="add" size={20} color="white" />
              <Text className="text-white font-semibold ml-2">Create API Key</Text>
            </Pressable>
          </View>
        }
      />

      {/* FAB */}
      {keys.length > 0 && canCreate && (
        <View className="absolute bottom-6 right-6">
          <Pressable
            onPress={() => setIsFormVisible(true)}
            className="w-14 h-14 rounded-full bg-brand items-center justify-center shadow-lg active:opacity-80"
            style={{
              shadowColor: '#f97316',
              shadowOffset: { width: 0, height: 4 },
              shadowOpacity: 0.3,
              shadowRadius: 8,
              elevation: 8,
            }}
            accessibilityRole="button"
            accessibilityLabel="Create new API key"
          >
            <Ionicons name="add" size={28} color="white" />
          </Pressable>
        </View>
      )}

      {/* Limit reached hint */}
      {keys.length > 0 && !canCreate && (
        <View className="absolute bottom-6 left-4 right-4">
          <View className="bg-zinc-900 border border-zinc-700 rounded-xl px-4 py-3 flex-row items-center">
            <Ionicons name="information-circle" size={18} color="#71717a" />
            <Text className="text-zinc-400 text-sm ml-2">
              Key limit reached ({keyLimit} max on your plan).
            </Text>
          </View>
        </View>
      )}

      {/* Create Form Sheet */}
      <CreateKeyFormSheet
        visible={isFormVisible}
        onClose={() => setIsFormVisible(false)}
        onSave={handleCreateKey}
        isSaving={isMutating}
      />

      {/* One-time Secret Modal */}
      <SecretRevealModal
        secret={revealedSecret}
        keyName={createdKeyName}
        onClose={handleSecretModalClose}
      />
    </View>
  );
}
