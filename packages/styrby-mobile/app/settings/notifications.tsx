/**
 * Notifications Settings Sub-Screen
 *
 * Owns: push notifications toggle, email notifications toggle,
 * quiet hours toggle + times, smart notifications priority selector (Pro+ gate).
 *
 * WHY a sub-screen: extracting the notification preferences section from the
 * 2,720-LOC settings monolith gives it a dedicated, scrollable view and
 * eliminates 10 state variables from the parent monolith component.
 *
 * Data: all preferences are stored in `notification_preferences` table.
 * Pattern: optimistic update on toggle → Supabase upsert → revert on error.
 * This matches the existing characterization test expectations.
 *
 * @see docs/planning/settings-refactor-plan-2026-04-19.md Section 3 row 2
 */

import {
  View,
  Text,
  Switch,
  ScrollView,
  ActivityIndicator,
  Pressable,
  Linking,
} from 'react-native';
import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../src/lib/supabase';
import { useCurrentUser } from '../../src/hooks/useCurrentUser';
import { useSubscriptionTier } from '../../src/hooks/useSubscriptionTier';
import { SectionHeader, SettingRow } from '../../src/components/ui';
import {
  formatTime,
  getThresholdDescription,
  getEstimatedNotificationPercentage,
} from 'styrby-shared';
import {
  canShowUpgradePrompt,
  POLAR_CUSTOMER_PORTAL_URL,
} from '../../src/lib/platform-billing';

// ============================================================================
// Component
// ============================================================================

/**
 * Notifications sub-screen.
 *
 * On mount: fetches notification_preferences row for the current user.
 * Creates a default row if none exists (PGRST116 = "no rows").
 * Each toggle: optimistic update → Supabase update → revert on error.
 *
 * @returns React element
 */
export default function NotificationsScreen() {
  const { user } = useCurrentUser();
  const { isPaid } = useSubscriptionTier(user?.id ?? null);

  // --------------------------------------------------------------------------
  // State
  // --------------------------------------------------------------------------

  /** Push notifications enabled state */
  const [pushEnabled, setPushEnabled] = useState(true);

  /** Email notifications enabled state */
  const [emailEnabled, setEmailEnabled] = useState(false);

  /** Quiet hours enabled state */
  const [quietHoursEnabled, setQuietHoursEnabled] = useState(false);

  /**
   * Quiet hours start time from notification_preferences.
   * WHY nullable: the column is nullable in the DB; null means "not configured"
   * and we use the default 10 PM display string in that case.
   */
  const [quietHoursStart, setQuietHoursStart] = useState<string | null>('22:00:00');

  /** Quiet hours end time */
  const [quietHoursEnd, setQuietHoursEnd] = useState<string | null>('07:00:00');

  /**
   * Priority threshold for smart notifications (1-5).
   * Lower values = fewer notifications (more filtering). Free users receive all.
   */
  const [priorityThreshold, setPriorityThreshold] = useState(3);

  /** Whether the priority save is in progress */
  const [prioritySaving, setPrioritySaving] = useState(false);

  /**
   * ID of the notification_preferences row.
   * WHY stored: distinguishes UPDATE (row exists) from INSERT (new user).
   */
  const [notifPrefId, setNotifPrefId] = useState<string | null>(null);

  /** Whether the initial data load is in progress */
  const [isLoading, setIsLoading] = useState(true);

  /**
   * Applies a notification_preferences row to local state.
   *
   * WHY defined before useEffect: the effect calls applyPrefs, so the callback
   * must be declared first. useCallback ensures stable reference across renders,
   * which satisfies the react-hooks/exhaustive-deps rule when applyPrefs is
   * listed as an effect dependency.
   *
   * @param prefs - Row from notification_preferences
   */
  const applyPrefs = useCallback((prefs: {
    id: string;
    push_enabled: boolean;
    email_enabled: boolean | null;
    quiet_hours_enabled: boolean;
    quiet_hours_start: string | null;
    quiet_hours_end: string | null;
    priority_threshold: number | null;
  }) => {
    setNotifPrefId(prefs.id);
    setPushEnabled(prefs.push_enabled);
    setEmailEnabled(prefs.email_enabled ?? false);
    setQuietHoursEnabled(prefs.quiet_hours_enabled);
    setQuietHoursStart(prefs.quiet_hours_start);
    setQuietHoursEnd(prefs.quiet_hours_end);
    setPriorityThreshold(prefs.priority_threshold ?? 3);
  }, []);

  // --------------------------------------------------------------------------
  // Mount: Load notification preferences
  // --------------------------------------------------------------------------

  useEffect(() => {
    if (!user) return;

    (async () => {
      setIsLoading(true);
      try {
        const { data: notifPrefs, error: notifError } = await supabase
          .from('notification_preferences')
          .select('id, user_id, push_enabled, email_enabled, quiet_hours_enabled, quiet_hours_start, quiet_hours_end, priority_threshold')
          .eq('user_id', user.id)
          .single();

        if (notifError && notifError.code === 'PGRST116') {
          // WHY: PGRST116 = "no rows returned" — new user without preferences row.
          // Insert defaults so subsequent toggles can use UPDATE instead of INSERT.
          const { data: newPrefs, error: insertError } = await supabase
            .from('notification_preferences')
            .insert({ user_id: user.id, push_enabled: true, priority_threshold: 3 })
            .select('id, user_id, push_enabled, email_enabled, quiet_hours_enabled, quiet_hours_start, quiet_hours_end, priority_threshold')
            .single();

          if (!insertError && newPrefs) {
            applyPrefs(newPrefs);
          }
        } else if (!notifError && notifPrefs) {
          applyPrefs(notifPrefs);
        }
      } catch {
        // Non-fatal: keep defaults
      } finally {
        setIsLoading(false);
      }
    })();
  }, [user, applyPrefs]);

  // --------------------------------------------------------------------------
  // Handlers (optimistic update pattern)
  // --------------------------------------------------------------------------

  /**
   * Builds a Supabase update chain for the current notifPrefId.
   * Extracts the shared "update existing row or insert new row" logic.
   *
   * @param updates - Fields to update
   * @param optimisticRevert - Callback to revert local state on failure
   */
  const updateOrInsert = useCallback(async (
    updates: Record<string, unknown>,
    optimisticRevert: () => void,
  ) => {
    try {
      if (!user) return;

      if (notifPrefId) {
        const { error } = await supabase
          .from('notification_preferences')
          .update(updates)
          .eq('id', notifPrefId);

        if (error) {
          optimisticRevert();
          if (__DEV__) {
            console.error('[Notifications] Failed to update preference:', error);
          }
        }
      } else {
        // Edge case: row was deleted between mount and toggle
        const { data, error } = await supabase
          .from('notification_preferences')
          .insert({ user_id: user.id, ...updates })
          .select('id')
          .single();

        if (error) {
          optimisticRevert();
          if (__DEV__) {
            console.error('[Notifications] Failed to insert preference:', error);
          }
        } else if (data) {
          setNotifPrefId(data.id);
        }
      }
    } catch {
      optimisticRevert();
    }
  }, [user, notifPrefId]);

  /**
   * Toggles push notifications and persists optimistically.
   * @param value - New push enabled state
   */
  const handlePushToggle = useCallback(async (value: boolean) => {
    setPushEnabled(value);
    await updateOrInsert(
      { push_enabled: value },
      () => setPushEnabled(!value),
    );
  }, [updateOrInsert]);

  /**
   * Toggles email notifications and persists optimistically.
   * @param value - New email enabled state
   */
  const handleEmailToggle = useCallback(async (value: boolean) => {
    setEmailEnabled(value);
    await updateOrInsert(
      { email_enabled: value },
      () => setEmailEnabled(!value),
    );
  }, [updateOrInsert]);

  /**
   * Toggles quiet hours and persists optimistically.
   * When enabling for the first time, sets default 10 PM - 7 AM times.
   * @param value - New quiet hours enabled state
   */
  const handleQuietHoursToggle = useCallback(async (value: boolean) => {
    setQuietHoursEnabled(value);

    const updateData: Record<string, unknown> = { quiet_hours_enabled: value };

    // WHY default times: quiet hours requires at least a start/end to be
    // meaningful. If the user enables quiet hours without having previously
    // configured times, default to a sensible range (10 PM - 7 AM).
    if (value && !quietHoursStart) {
      updateData.quiet_hours_start = '22:00:00';
      updateData.quiet_hours_end = '07:00:00';
      setQuietHoursStart('22:00:00');
      setQuietHoursEnd('07:00:00');
    }

    await updateOrInsert(
      updateData,
      () => setQuietHoursEnabled(!value),
    );
  }, [updateOrInsert, quietHoursStart]);

  /**
   * Updates the priority threshold and persists to Supabase.
   * WHY no optimistic revert here: priority changes are low-stakes UI feedback;
   * the visual state showing the saved value is more important than instant revert.
   * @param value - New priority level (1-5)
   */
  const handlePriorityChange = useCallback(async (value: number) => {
    const previous = priorityThreshold;
    setPriorityThreshold(value);
    setPrioritySaving(true);

    try {
      if (!notifPrefId) return;

      const { error } = await supabase
        .from('notification_preferences')
        .update({ priority_threshold: value })
        .eq('id', notifPrefId);

      if (error) {
        setPriorityThreshold(previous);
        if (__DEV__) {
          console.error('[Notifications] Failed to update priority:', error);
        }
      }
    } catch {
      setPriorityThreshold(previous);
    } finally {
      setPrioritySaving(false);
    }
  }, [notifPrefId, priorityThreshold]);

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  if (isLoading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator
          size="small"
          color="#f97316"
          accessibilityLabel="Loading notification preferences"
        />
      </View>
    );
  }

  return (
    <ScrollView className="flex-1 bg-background">
      {/* Push & Email toggles */}
      <SectionHeader title="Channels" />
      <View className="bg-background-secondary">
        <SettingRow
          icon="notifications"
          iconColor="#eab308"
          title="Push Notifications"
          trailing={
            <Switch
              value={pushEnabled}
              onValueChange={(v) => void handlePushToggle(v)}
              trackColor={{ false: '#3f3f46', true: '#f9731650' }}
              thumbColor={pushEnabled ? '#f97316' : '#71717a'}
              accessibilityRole="switch"
              accessibilityLabel="Toggle push notifications"
            />
          }
        />
        <SettingRow
          icon="mail"
          iconColor="#3b82f6"
          title="Email Notifications"
          trailing={
            <Switch
              value={emailEnabled}
              onValueChange={(v) => void handleEmailToggle(v)}
              trackColor={{ false: '#3f3f46', true: '#f9731650' }}
              thumbColor={emailEnabled ? '#f97316' : '#71717a'}
              accessibilityRole="switch"
              accessibilityLabel="Toggle email notifications"
            />
          }
        />
      </View>

      {/* Quiet Hours */}
      <SectionHeader title="Quiet Hours" />
      <View className="bg-background-secondary">
        <SettingRow
          icon="moon"
          iconColor="#6366f1"
          title="Quiet Hours"
          subtitle={quietHoursEnabled
            ? `${formatTime(quietHoursStart, '10:00 PM')} - ${formatTime(quietHoursEnd, '7:00 AM')}`
            : 'Disabled'}
          trailing={
            <Switch
              value={quietHoursEnabled}
              onValueChange={(v) => void handleQuietHoursToggle(v)}
              trackColor={{ false: '#3f3f46', true: '#f9731650' }}
              thumbColor={quietHoursEnabled ? '#f97316' : '#71717a'}
              accessibilityRole="switch"
              accessibilityLabel="Toggle quiet hours"
            />
          }
        />
      </View>

      {/* Smart Notifications (Pro+ gate) */}
      <SectionHeader title="Smart Notifications" />
      <View className="bg-background-secondary px-4 py-4">
        <View className="flex-row items-center justify-between mb-3">
          <View className="flex-row items-center">
            <Text style={{ fontSize: 18, color: '#f97316' }}>🔔</Text>
            <Text className="text-white font-medium ml-2">Notification Sensitivity</Text>
            {!isPaid && (
              <View className="ml-2 px-2 py-0.5 rounded-full bg-orange-500/10">
                <Text className="text-xs font-medium text-orange-400">Pro</Text>
              </View>
            )}
          </View>
          {prioritySaving && (
            <Text className="text-xs text-zinc-500">Saving...</Text>
          )}
        </View>

        <View
          style={{ opacity: isPaid ? 1 : 0.5 }}
          pointerEvents={isPaid ? 'auto' : 'none'}
        >
          {/* Priority level buttons */}
          <View className="flex-row justify-between mb-2">
            {[1, 2, 3, 4, 5].map((level) => (
              <Pressable
                key={level}
                onPress={() => void handlePriorityChange(level)}
                disabled={!isPaid || prioritySaving}
                className={`flex-1 mx-0.5 py-3 rounded-lg items-center ${
                  priorityThreshold === level ? 'bg-orange-500' : 'bg-zinc-800'
                }`}
                accessibilityRole="button"
                accessibilityLabel={`Set priority to ${getThresholdDescription(level)}`}
              >
                <Text
                  className={`text-xs font-medium ${
                    priorityThreshold === level ? 'text-white' : 'text-zinc-400'
                  }`}
                >
                  {level}
                </Text>
              </Pressable>
            ))}
          </View>

          <View className="flex-row justify-between">
            <Text className="text-xs text-zinc-500">Urgent only</Text>
            <Text className="text-xs text-zinc-500">All</Text>
          </View>

          {/* Current level description */}
          <View className="mt-4 p-3 rounded-lg bg-zinc-800/50 border border-zinc-700">
            <Text className="text-sm font-medium text-white mb-1">
              {getThresholdDescription(priorityThreshold)}
            </Text>
            <Text className="text-xs text-zinc-400 mb-2">
              You will receive approximately {getEstimatedNotificationPercentage(priorityThreshold)}% of notifications.
            </Text>
            <View className="space-y-1">
              <Text className="text-xs text-zinc-500 font-medium">Examples at this level:</Text>
              {priorityThreshold >= 1 && (
                <Text className="text-xs text-zinc-500">- Budget exceeded, dangerous tool permissions</Text>
              )}
              {priorityThreshold >= 2 && (
                <Text className="text-xs text-zinc-500">- Budget warnings, session errors</Text>
              )}
              {priorityThreshold >= 3 && (
                <Text className="text-xs text-zinc-500">- Session completions with significant cost</Text>
              )}
              {priorityThreshold >= 4 && (
                <Text className="text-xs text-zinc-500">- Low-cost session completions</Text>
              )}
              {priorityThreshold >= 5 && (
                <Text className="text-xs text-zinc-500">- Session started, all updates</Text>
              )}
            </View>
          </View>
        </View>

        {/* Pro upgrade CTA for free users.
            WHY platform-conditional: Apple Reader App rules (§3.1.3(a)) prohibit
            showing upgrade links on iOS. Android shows the full upgrade link. */}
        {!isPaid && (
          <View className="mt-4 p-3 rounded-lg bg-orange-500/5 border border-orange-500/20">
            <Text className="text-sm text-orange-400 mb-2">
              Smart notifications filter by importance to reduce notification fatigue.
            </Text>
            {canShowUpgradePrompt() ? (
              <Pressable
                onPress={() => Linking.openURL(POLAR_CUSTOMER_PORTAL_URL)}
                accessibilityRole="link"
                accessibilityLabel="Upgrade to Pro"
              >
                <Text className="text-sm font-medium text-orange-500">
                  Upgrade to Pro to enable
                </Text>
              </Pressable>
            ) : (
              <Text className="text-sm text-orange-500">
                Pro plan required to enable
              </Text>
            )}
          </View>
        )}
      </View>
    </ScrollView>
  );
}
