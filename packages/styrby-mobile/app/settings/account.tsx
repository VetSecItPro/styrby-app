/**
 * Account Settings Sub-Screen — Orchestrator
 *
 * Owns: data fetching glue (current user, subscription tier), top-level
 * scroll layout, and modal mounting. All section UI lives in
 * `src/components/account/*` and all state + async flows live in the
 * `useAccount` hook.
 *
 * WHY orchestrator pattern: the Account section was the most complex block
 * in the original 2,720-LOC settings monolith — 12 state variables, 4 async
 * flows, 2 modals, and 2 account-deletion paths (iOS/Android). After PR #80
 * extracted it as a dedicated screen it grew back to 898 LOC, so this PR
 * splits the screen into an orchestrator + 6 focused sub-components +
 * 1 hook + shared types/constants.
 *
 * Security notes:
 * - Account deletion calls the web app's DELETE /api/account/delete endpoint
 *   which uses the Supabase admin client (service role key). The mobile app
 *   never has the service role key. (SOC2 CC6.2, CC6.6)
 * - Data export calls POST /api/account/export — server-side rate-limited.
 *   (GDPR Art. 20)
 * - Email change uses Supabase's built-in verification email flow. The new
 *   email is not applied until the user clicks the verification link.
 *
 * @see docs/planning/settings-refactor-plan-2026-04-19.md Section 3 row 1
 */

import { View, ScrollView, ActivityIndicator, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useSubscriptionTier } from '@/hooks/useSubscriptionTier';
import {
  BillingSection,
  DangerSection,
  DataSection,
  DeleteAccountModal,
  EmailChangeModal,
  ProfileSection,
  useAccount,
} from '@/components/account';

/**
 * Account sub-screen orchestrator.
 *
 * @returns React element
 */
export default function AccountScreen() {
  const router = useRouter();
  const { user, isLoading: isLoadingUser, refresh: refreshUser } = useCurrentUser();
  const { tier, isLoading: isLoadingTier } = useSubscriptionTier(user?.id ?? null);

  const account = useAccount({
    userId: user?.id ?? null,
    userDisplayName: user?.displayName,
    refreshUser,
  });

  if (isLoadingUser) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator
          size="small"
          color="#f97316"
          accessibilityLabel="Loading account data"
        />
      </View>
    );
  }

  return (
    <>
      <ScrollView className="flex-1 bg-background">
        <ProfileSection
          displayName={user?.displayName}
          email={user?.email}
          isEditing={account.isEditingDisplayName}
          draft={account.displayNameDraft}
          isSaving={account.isSavingDisplayName}
          onDraftChange={account.setDisplayNameDraft}
          onBeginEdit={account.beginEditDisplayName}
          onCancelEdit={account.cancelEditDisplayName}
          onSave={() => void account.saveDisplayName()}
          onPressChangeEmail={account.openEmailModal}
          onPressResetPassword={() => void account.sendPasswordReset(user?.email)}
          isSendingPasswordReset={account.isSendingPasswordReset}
        />

        <DataSection
          isExporting={account.isExportingData}
          onPressExport={() => void account.exportData()}
        />

        <BillingSection
          tier={tier}
          isLoadingTier={isLoadingTier}
          monthlySpend={account.monthlySpend}
          isLoadingSpend={account.isLoadingSpend}
          onPressUsageAndCosts={() => router.push('/(tabs)/costs')}
        />

        <DangerSection
          isSigningOut={account.isSigningOut}
          isDeleting={account.isDeletingAccount}
          onSignOut={account.signOutAccount}
          onDelete={account.beginDeleteAccount}
        />
      </ScrollView>

      <EmailChangeModal
        visible={account.isEmailModalVisible}
        currentEmail={user?.email}
        draft={account.newEmailDraft}
        isSubmitting={account.isChangingEmail}
        onDraftChange={account.setNewEmailDraft}
        onSubmit={() => void account.changeEmail(user?.email)}
        onClose={account.closeEmailModal}
      />

      {/* WHY iOS guard: Alert.prompt handles the iOS confirmation natively.
          Only Android needs the custom modal. */}
      {Platform.OS !== 'ios' && (
        <DeleteAccountModal
          visible={account.showDeleteModal}
          confirmText={account.deleteConfirmText}
          isDeleting={account.isDeletingAccount}
          onConfirmTextChange={account.setDeleteConfirmText}
          onConfirm={account.confirmDeleteAccountFromModal}
          onClose={account.closeDeleteModal}
        />
      )}
    </>
  );
}
