/**
 * Cloud Tasks Screen
 *
 * Full-screen Power-tier feature for monitoring async cloud agent tasks.
 *
 * What it does:
 * - Lists the user's most-recent cloud tasks (queued / running / completed /
 *   failed / cancelled) with live status updates via Supabase Realtime
 * - Tapping a task opens a detail sheet with the full prompt, result, error,
 *   and cost
 * - Active tasks (queued, running) can be cancelled directly from the list
 *   or detail sheet — the cancel handler updates `cloud_tasks.status` to
 *   'cancelled' and the relay infrastructure terminates the agent execution
 *
 * Tier gate:
 * - Free and Pro users see the PowerTierGate upgrade prompt
 * - Power users see the live task list
 *
 * Navigated to from the Dashboard's "Cloud Tasks" card link.
 *
 * Backend wiring:
 * - cloud_tasks Supabase table (migration 063)
 * - Realtime channel filtered by user_id
 * - Cancel via Supabase UPDATE; the relay watches for status='cancelled'
 *   transitions and terminates the running agent (CLI side: cloud.ts:496)
 */

import { useCallback, useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router, Stack } from 'expo-router';
import { supabase } from '../src/lib/supabase';
import { CloudTasks } from '../src/components/CloudTasks';
import { CloudTaskSubmitSheet } from '../src/components/cloud-tasks/CloudTaskSubmitSheet';
import { PowerTierGate } from '../src/components/tier/PowerTierGate';
import { useSubscriptionTier } from '../src/hooks/useSubscriptionTier';
import { cancelCloudTask } from '../src/services/cloud-tasks';

/**
 * Renders the Cloud Tasks screen.
 *
 * Behavior:
 * 1. Resolves the authenticated user (auth.getUser).
 * 2. Looks up subscription tier via useSubscriptionTier.
 * 3. While loading: spinner.
 * 4. Non-Power: PowerTierGate upgrade prompt.
 * 5. Power: <CloudTasks userId={user.id} onCancelTask={cancelCloudTask} />.
 *
 * @returns React element
 */
export default function CloudTasksScreen() {
  const [userId, setUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [isSubmitSheetOpen, setIsSubmitSheetOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!cancelled) setUserId(user?.id ?? null);
      } finally {
        if (!cancelled) setAuthLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const { tier, isLoading: tierLoading } = useSubscriptionTier(userId);

  // Stable callback so CloudTasks's useCallback deps don't rebuild every render.
  const handleCancel = useCallback(async (taskId: string) => {
    await cancelCloudTask(taskId);
  }, []);

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  // Loading: auth check OR tier check still in flight
  if (authLoading || (userId !== null && tierLoading)) {
    return (
      <>
        <Stack.Screen options={{ title: 'Cloud Tasks' }} />
        <View className="flex-1 bg-background items-center justify-center">
          <ActivityIndicator size="large" color="#f97316" />
          <Text className="text-zinc-500 mt-4">Loading…</Text>
        </View>
      </>
    );
  }

  // Not authenticated — defensive; the route group should already enforce auth
  // but render a clear state if we ever land here without a session.
  if (userId === null) {
    return (
      <>
        <Stack.Screen options={{ title: 'Cloud Tasks' }} />
        <View className="flex-1 bg-background items-center justify-center px-8">
          <Ionicons name="lock-closed-outline" size={40} color="#71717a" />
          <Text className="text-white text-lg font-semibold mt-4 text-center">
            Sign in to view cloud tasks
          </Text>
          <Pressable
            onPress={() => router.replace('/(auth)/login')}
            className="bg-brand px-6 py-3 rounded-xl mt-6 active:opacity-80"
            accessibilityRole="button"
            accessibilityLabel="Go to sign-in screen"
          >
            <Text className="text-white font-bold">Sign in</Text>
          </Pressable>
        </View>
      </>
    );
  }

  // Tier gate: free + pro users get the upgrade prompt
  if (tier !== 'power') {
    return (
      <>
        <Stack.Screen options={{ title: 'Cloud Tasks' }} />
        <PowerTierGate
          feature="Cloud Tasks"
          description="Submit long-running agent jobs from your CLI and monitor them live from the phone — code reviews, refactors, and any async task with real-time status, cost tracking, and one-tap cancellation."
          icon="cloud"
        />
      </>
    );
  }

  // Power tier: render the task list + submit FAB
  return (
    <>
      <Stack.Screen options={{ title: 'Cloud Tasks' }} />
      <View className="flex-1 bg-background">
        <CloudTasks userId={userId} onCancelTask={handleCancel} />

        {/* Floating "+" button to open the submit sheet. Positioned bottom-right
            following standard mobile FAB convention. Realtime delivers the new
            task to the list automatically once submitCloudTask returns, so we
            don't need to optimistically inject the row here — but onSubmitted
            is wired in case we want to in the future (Realtime can lag). */}
        <Pressable
          onPress={() => setIsSubmitSheetOpen(true)}
          style={{
            position: 'absolute',
            right: 20,
            bottom: 24,
            width: 56,
            height: 56,
            borderRadius: 28,
            backgroundColor: '#f97316',
            alignItems: 'center',
            justifyContent: 'center',
            shadowColor: '#000',
            shadowOpacity: 0.3,
            shadowRadius: 8,
            shadowOffset: { width: 0, height: 4 },
            elevation: 6,
          }}
          accessibilityRole="button"
          accessibilityLabel="Submit a new cloud task"
        >
          <Ionicons name="add" size={28} color="white" />
        </Pressable>

        <CloudTaskSubmitSheet
          visible={isSubmitSheetOpen}
          onDismiss={() => setIsSubmitSheetOpen(false)}
          onSubmitted={() => {
            // Realtime will deliver the new row to <CloudTasks/> automatically;
            // this hook exists so future iterations could optimistically inject
            // it sooner if needed. Currently a no-op besides closing the sheet
            // (handled by the dismiss path inside the sheet).
          }}
        />
      </View>
    </>
  );
}
