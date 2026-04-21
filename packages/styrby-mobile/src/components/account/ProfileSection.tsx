/**
 * Account Settings — Profile Section
 *
 * Renders the inline display-name editor + the Change Email and Reset
 * Password rows. Owned state for inline editing lives in the orchestrator
 * hook (useAccount); this component is presentation-only.
 *
 * WHY split out: the inline edit branch (TextInput + save/cancel buttons)
 * is the most visually involved part of the screen and was the largest
 * contributor to the orchestrator's previous 898-LOC bulk.
 */

import { View, TextInput, Pressable, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SectionHeader, SettingRow } from '@/components/ui';

/**
 * Props consumed by {@link ProfileSection}.
 *
 * WHY a wide prop interface: keeping the section presentation-only means
 * every interactive callback must be passed in. This makes the component
 * trivially testable in isolation.
 */
export interface ProfileSectionProps {
  /** Current user's display name (null when unset in auth, undefined while loading) */
  displayName: string | null | undefined;
  /** Current user's email (or undefined while loading) */
  email: string | undefined;

  // Display name editing state
  isEditing: boolean;
  draft: string;
  isSaving: boolean;
  onDraftChange: (next: string) => void;
  onBeginEdit: () => void;
  onCancelEdit: () => void;
  onSave: () => void;

  // Other rows
  onPressChangeEmail: () => void;
  onPressResetPassword: () => void;
  isSendingPasswordReset: boolean;
}

/**
 * Profile section: display name (with inline edit), change email, reset password.
 */
export function ProfileSection(props: ProfileSectionProps) {
  const {
    displayName,
    email,
    isEditing,
    draft,
    isSaving,
    onDraftChange,
    onBeginEdit,
    onCancelEdit,
    onSave,
    onPressChangeEmail,
    onPressResetPassword,
    isSendingPasswordReset,
  } = props;

  return (
    <>
      <SectionHeader title="Profile" />
      <View className="bg-background-secondary">
        {isEditing ? (
          <View className="flex-row items-center px-4 py-3">
            <View
              className="w-8 h-8 rounded-lg items-center justify-center mr-3"
              style={{ backgroundColor: '#f9731620' }}
            >
              <Ionicons name="person" size={18} color="#f97316" />
            </View>
            <TextInput
              className="flex-1 text-white bg-zinc-800 rounded-lg px-3 py-2 text-base mr-2"
              value={draft}
              onChangeText={onDraftChange}
              placeholder="Display name"
              placeholderTextColor="#71717a"
              autoFocus
              autoCapitalize="words"
              returnKeyType="done"
              onSubmitEditing={onSave}
              accessibilityLabel="Display name input"
            />
            <Pressable
              onPress={onSave}
              disabled={isSaving || !draft.trim()}
              className="p-2"
              accessibilityRole="button"
              accessibilityLabel="Save display name"
            >
              {isSaving ? (
                <ActivityIndicator size="small" color="#22c55e" />
              ) : (
                <Ionicons name="checkmark" size={22} color="#22c55e" />
              )}
            </Pressable>
            <Pressable
              onPress={onCancelEdit}
              className="p-2 ml-1"
              accessibilityRole="button"
              accessibilityLabel="Cancel display name edit"
            >
              <Ionicons name="close" size={22} color="#71717a" />
            </Pressable>
          </View>
        ) : (
          <SettingRow
            icon="person"
            iconColor="#f97316"
            title={displayName ?? 'Set Display Name'}
            subtitle="Tap edit to change your name"
            trailing={
              <Pressable
                onPress={onBeginEdit}
                className="p-1"
                accessibilityRole="button"
                accessibilityLabel="Edit display name"
              >
                <Ionicons name="pencil" size={18} color="#71717a" />
              </Pressable>
            }
          />
        )}

        <SettingRow
          icon="mail"
          iconColor="#3b82f6"
          title="Change Email"
          subtitle={email ?? 'Not signed in'}
          onPress={onPressChangeEmail}
        />

        <SettingRow
          icon="key"
          iconColor="#eab308"
          title="Reset Password"
          subtitle="Send reset link to your email"
          onPress={onPressResetPassword}
          trailing={
            isSendingPasswordReset ? (
              <ActivityIndicator size="small" color="#eab308" />
            ) : undefined
          }
        />
      </View>
    </>
  );
}
