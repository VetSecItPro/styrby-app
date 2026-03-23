/**
 * Onboarding Progress Hook
 *
 * Checks the user's onboarding completion state and computes a tier-specific
 * checklist of setup steps. Each step maps to a table in Supabase that indicates
 * whether the user has completed a particular action (e.g., pairing a device,
 * setting a budget alert).
 *
 * Tier-based step progression:
 * - Free: "Pair your first device" (machines table)
 * - Pro: + "Set a budget alert" (budget_alerts) + "Configure notifications" (notification_preferences or device_tokens)
 * - Power: + "Create a team" (teams via team_members) + "Generate an API key" (api_keys)
 *
 * Uses the same patterns as useSessions and useBudgetAlerts for Supabase queries,
 * loading states, and error handling.
 */

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { safeParseSingle, SubscriptionTierRowSchema } from '../lib/schemas';
import type { SubscriptionTier } from 'styrby-shared';

// ============================================================================
// Types
// ============================================================================

/**
 * Represents a single step in the onboarding checklist.
 * Each step corresponds to a user action that can be verified by querying
 * the relevant Supabase table.
 */
export interface ChecklistStep {
  /** Unique identifier for the step */
  id: string;
  /** Human-readable label shown in the checklist UI */
  label: string;
  /** Whether this step has been completed */
  completed: boolean;
  /** The expo-router path to navigate to when the user taps this step */
  route: string;
  /** Ionicons icon name for the step */
  icon: string;
  /** Minimum subscription tier required for this step to appear */
  requiredTier: SubscriptionTier;
}

/**
 * Return type for the useOnboarding hook.
 */
export interface UseOnboardingReturn {
  /** Whether the full onboarding flow has been marked complete */
  isComplete: boolean;
  /** Whether the initial data is being loaded */
  isLoading: boolean;
  /** Error message from the most recent operation, or null */
  error: string | null;
  /** Tier-filtered checklist steps with completion status */
  steps: ChecklistStep[];
  /** Number of steps the user has completed */
  completedCount: number;
  /** Total number of steps for the user's tier */
  totalCount: number;
  /** The user's current subscription tier */
  tier: SubscriptionTier;
  /** Marks onboarding as complete by setting profiles.onboarding_completed_at */
  markComplete: () => Promise<void>;
  /** Refreshes onboarding data from Supabase */
  refresh: () => Promise<void>;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * All possible onboarding steps across all tiers.
 * Steps are filtered at runtime based on the user's subscription tier.
 *
 * WHY: Defining all steps statically makes it easy to add new steps per tier
 * without modifying the hook logic. The requiredTier field controls visibility.
 */
const ALL_STEPS: Omit<ChecklistStep, 'completed'>[] = [
  {
    id: 'pair_device',
    label: 'Pair your first device',
    route: '/(auth)/scan',
    icon: 'qr-code',
    requiredTier: 'free',
  },
  {
    id: 'set_budget_alert',
    label: 'Set a budget alert',
    route: '/budget-alerts',
    icon: 'wallet',
    requiredTier: 'pro',
  },
  {
    id: 'configure_notifications',
    label: 'Configure notifications',
    route: '/(tabs)/settings',
    icon: 'notifications',
    requiredTier: 'pro',
  },
  {
    id: 'create_team',
    label: 'Create a team',
    route: '/(tabs)/team',
    icon: 'people',
    requiredTier: 'power',
  },
  {
    id: 'generate_api_key',
    label: 'Generate an API key',
    route: '/(tabs)/settings',
    icon: 'key',
    requiredTier: 'power',
  },
];

/**
 * Maps each tier to the set of tiers whose steps should be visible.
 *
 * WHY: A power user should see free and pro steps too. This mapping
 * avoids complex conditional logic in the step-filtering code.
 */
const TIER_INCLUDES: Record<SubscriptionTier, SubscriptionTier[]> = {
  free: ['free'],
  pro: ['free', 'pro'],
  power: ['free', 'pro', 'power'],
  team: ['free', 'pro', 'power', 'team'],
};

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook for managing onboarding state and computing tier-specific checklist progress.
 *
 * Fetches the user's profile (for onboarding_completed_at), subscription tier,
 * and queries relevant tables to determine which checklist steps are complete.
 *
 * @returns Onboarding state, checklist steps, and a markComplete function
 *
 * @example
 * const {
 *   isComplete, isLoading, steps, completedCount, totalCount,
 *   tier, markComplete, refresh,
 * } = useOnboarding();
 *
 * if (!isComplete && !isLoading) {
 *   // Show onboarding banner or modal
 * }
 */
export function useOnboarding(): UseOnboardingReturn {
  const [isComplete, setIsComplete] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tier, setTier] = useState<SubscriptionTier>('free');
  const [stepCompletions, setStepCompletions] = useState<Record<string, boolean>>({});

  // --------------------------------------------------------------------------
  // Data Loading
  // --------------------------------------------------------------------------

  /**
   * Fetches onboarding state from Supabase.
   *
   * Loads in parallel:
   * 1. Profile (for onboarding_completed_at)
   * 2. Subscription tier
   * 3. Step completion checks (machines, budget_alerts, notification_preferences, team_members, api_keys)
   *
   * @throws Sets error state if the user is not authenticated or a query fails
   */
  const loadOnboardingState = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        setError('You must be signed in to view onboarding status.');
        setIsLoading(false);
        return;
      }

      // Fetch profile, subscription, and all step checks in parallel
      const [
        profileResult,
        subscriptionResult,
        machinesResult,
        budgetAlertsResult,
        notifPrefsResult,
        deviceTokensResult,
        teamMembersResult,
        apiKeysResult,
      ] = await Promise.all([
        supabase
          .from('profiles')
          .select('onboarding_completed_at')
          .eq('id', user.id)
          .single(),
        supabase
          .from('subscriptions')
          .select('tier')
          .eq('user_id', user.id)
          .single(),
        supabase
          .from('machines')
          .select('id')
          .eq('user_id', user.id)
          .limit(1),
        supabase
          .from('budget_alerts')
          .select('id')
          .eq('user_id', user.id)
          .limit(1),
        supabase
          .from('notification_preferences')
          .select('id')
          .eq('user_id', user.id)
          .limit(1),
        supabase
          .from('device_tokens')
          .select('id')
          .eq('user_id', user.id)
          .limit(1),
        supabase
          .from('team_members')
          .select('id')
          .eq('user_id', user.id)
          .limit(1),
        supabase
          .from('api_keys')
          .select('id')
          .eq('user_id', user.id)
          .limit(1),
      ]);

      // Determine onboarding completion
      if (!profileResult.error && profileResult.data) {
        setIsComplete(profileResult.data.onboarding_completed_at !== null);
      }

      // Determine tier (default to free if no subscription row exists)
      const tierRow = safeParseSingle(
        SubscriptionTierRowSchema,
        subscriptionResult.data,
        'subscription_tier',
      );
      const userTier = (tierRow?.tier as SubscriptionTier) ?? 'free';
      setTier(userTier);

      // Compute step completions based on table row existence
      // WHY: We check for at least one row in each table rather than a specific
      // configuration, because the presence of any row means the user has engaged
      // with that feature.
      const completions: Record<string, boolean> = {
        pair_device: !machinesResult.error && (machinesResult.data?.length ?? 0) > 0,
        set_budget_alert: !budgetAlertsResult.error && (budgetAlertsResult.data?.length ?? 0) > 0,
        configure_notifications:
          (!notifPrefsResult.error && (notifPrefsResult.data?.length ?? 0) > 0) ||
          (!deviceTokensResult.error && (deviceTokensResult.data?.length ?? 0) > 0),
        create_team: !teamMembersResult.error && (teamMembersResult.data?.length ?? 0) > 0,
        generate_api_key: !apiKeysResult.error && (apiKeysResult.data?.length ?? 0) > 0,
      };

      setStepCompletions(completions);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load onboarding state';
      setError(message);
      if (__DEV__) {
        console.error('[useOnboarding] Error loading state:', err);
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Load on mount
  useEffect(() => {
    loadOnboardingState();
  }, [loadOnboardingState]);

  // --------------------------------------------------------------------------
  // Computed Values
  // --------------------------------------------------------------------------

  /**
   * Filters the full step list to only include steps relevant to the user's tier,
   * and attaches the computed completion status for each step.
   */
  const visibleTiers = TIER_INCLUDES[tier] ?? TIER_INCLUDES.free;
  const steps: ChecklistStep[] = ALL_STEPS
    .filter((step) => visibleTiers.includes(step.requiredTier))
    .map((step) => ({
      ...step,
      completed: stepCompletions[step.id] ?? false,
    }));

  const completedCount = steps.filter((s) => s.completed).length;
  const totalCount = steps.length;

  // --------------------------------------------------------------------------
  // Actions
  // --------------------------------------------------------------------------

  /**
   * Marks onboarding as complete by setting profiles.onboarding_completed_at
   * to the current timestamp. Updates local state immediately for responsive UI.
   *
   * @throws Sets error state if the database update fails
   */
  const markComplete = useCallback(async () => {
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        const authError = new Error('You must be signed in to complete onboarding.');
        setError(authError.message);
        throw authError;
      }

      const { error: updateError } = await supabase
        .from('profiles')
        .update({ onboarding_completed_at: new Date().toISOString() })
        .eq('id', user.id);

      if (updateError) {
        setError(updateError.message);
        if (__DEV__) {
          console.error('[useOnboarding] Failed to mark complete:', updateError);
        }
        throw updateError;
      }

      setIsComplete(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to complete onboarding';
      setError(message);
      if (__DEV__) {
        console.error('[useOnboarding] markComplete error:', err);
      }
      throw err;
    }
  }, []);

  // --------------------------------------------------------------------------
  // Return
  // --------------------------------------------------------------------------

  return {
    isComplete,
    isLoading,
    error,
    steps,
    completedCount,
    totalCount,
    tier,
    markComplete,
    refresh: loadOnboardingState,
  };
}
