/**
 * Onboarding Configuration and State Detection
 *
 * Determines which setup steps a user needs to complete based on their
 * subscription tier, then checks completion by querying existing tables.
 * No separate tracking table is needed; the onboarding state is derived
 * from real data (machines, budget_alerts, device_tokens, etc.).
 *
 * Tier-based step requirements:
 * - Free (1 step): Connect a machine
 * - Pro (3 steps): Connect a machine, set a budget alert, install mobile app
 * - Power (5 steps): Connect a machine, set a budget alert, invite a team member,
 *                     create an API key, install mobile app
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { TierId } from '@/lib/polar';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Represents a single onboarding step with its completion status.
 */
export type OnboardingStep = {
  /** Unique identifier for the step */
  id: string;
  /** Short label shown in the checklist */
  label: string;
  /** Brief description of what the step accomplishes */
  description: string;
  /** Dashboard page where the user completes this step */
  href: string;
  /** Whether the user has already completed this step */
  completed: boolean;
};

/**
 * Complete onboarding state for a user, including tier info and all steps.
 * Used by the welcome modal and sidebar banner to render the setup checklist.
 */
export type OnboardingState = {
  /** The user's current subscription tier */
  tier: 'free' | 'pro' | 'growth';
  /** Ordered list of onboarding steps for this tier */
  steps: OnboardingStep[];
  /** Number of steps the user has completed */
  completedCount: number;
  /** Total number of steps required for this tier */
  totalSteps: number;
  /** True when all steps are done (or onboarding_completed_at is set) */
  isComplete: boolean;
  /** ISO 8601 timestamp when onboarding was marked complete, or null */
  onboardingCompletedAt: string | null;
};

// ---------------------------------------------------------------------------
// Step Definitions
// ---------------------------------------------------------------------------

/**
 * All possible onboarding steps. Each tier uses a subset of these.
 */
const STEP_DEFINITIONS = {
  connectMachine: {
    id: 'connect-machine',
    label: 'Connect a machine',
    description: 'Pair your first device using the Styrby CLI.',
    href: '/dashboard/devices/pair',
  },
  setBudgetAlert: {
    id: 'set-budget-alert',
    label: 'Set a budget alert',
    description: 'Get notified before you overspend on AI usage.',
    href: '/dashboard/costs/budget-alerts',
  },
  installMobileApp: {
    id: 'install-mobile-app',
    label: 'Install the mobile app',
    description: 'Monitor sessions and approve permissions on the go.',
    href: '/dashboard/devices/pair',
  },
  inviteTeamMember: {
    id: 'invite-team-member',
    label: 'Invite a team member',
    description: 'Collaborate with your team on shared sessions.',
    href: '/dashboard/team',
  },
  createApiKey: {
    id: 'create-api-key',
    label: 'Create an API key',
    description: 'Integrate Styrby data into your own tools.',
    href: '/dashboard/settings/api',
  },
} as const;

/**
 * Which steps apply to each subscription tier.
 *
 * WHY these specific steps: Free users just need to connect and start using
 * the product. Pro users benefit from cost awareness and mobile notifications.
 * Power users have team and API features that drive stickiness.
 */
const TIER_STEPS: Record<TierId, (keyof typeof STEP_DEFINITIONS)[]> = {
  free: ['connectMachine'],
  pro: ['connectMachine', 'setBudgetAlert', 'installMobileApp'],
  // WHY (Phase 5 rename): pre-rename `'power'` tier collapsed into Growth.
  // Growth is the new team plan; team-invite step belongs there.
  growth: ['connectMachine', 'setBudgetAlert', 'inviteTeamMember', 'createApiKey', 'installMobileApp'],
};

// ---------------------------------------------------------------------------
// Server-Side State Resolution
// ---------------------------------------------------------------------------

/**
 * Fetches the complete onboarding state for a user by querying existing tables.
 * Uses Promise.all to run all queries in parallel for speed.
 *
 * @param supabase - Authenticated Supabase server client
 * @param userId - The authenticated user's ID
 * @returns Full onboarding state with per-step completion status
 *
 * @example
 * const supabase = await createClient();
 * const state = await getOnboardingState(supabase, user.id);
 * if (!state.isComplete) {
 *   // Show onboarding UI
 * }
 */
export async function getOnboardingState(
  supabase: SupabaseClient,
  userId: string
): Promise<OnboardingState> {
  // First check if onboarding is already complete (fast path)
  const { data: profile } = await supabase
    .from('profiles')
    .select('onboarding_completed_at')
    .eq('id', userId)
    .single();

  if (profile?.onboarding_completed_at) {
    // Onboarding was already marked complete. Return minimal state so the
    // modal and banner are never rendered.
    return {
      tier: 'free',
      steps: [],
      completedCount: 0,
      totalSteps: 0,
      isComplete: true,
      onboardingCompletedAt: profile.onboarding_completed_at,
    };
  }

  // Fetch tier and completion signals in parallel
  // WHY: teamMembersResult is fetched to keep the parallel Promise.all pattern
  // consistent, but team membership is checked via team_invitations separately
  // (see hasInvitedTeamMember below). Prefix with _ to document intentional skip.
  const [subscriptionResult, machinesResult, budgetAlertsResult, deviceTokensResult, _teamMembersResult, apiKeysResult] =
    await Promise.all([
      // Subscription tier
      supabase
        .from('subscriptions')
        .select('tier')
        .eq('user_id', userId)
        .eq('status', 'active')
        .single(),
      // Machines count
      supabase
        .from('machines')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId),
      // Budget alerts count
      supabase
        .from('budget_alerts')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId),
      // Device tokens count (indicates mobile app installed)
      supabase
        .from('device_tokens')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId),
      // Team members count (Power tier: user should have invited at least one other person)
      supabase
        .from('team_members')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId),
      // API keys count (Power tier)
      supabase
        .from('api_keys')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .is('revoked_at', null),
    ]);

  const tier: TierId = (subscriptionResult.data?.tier as TierId) || 'free';
  const hasMachine = (machinesResult.count ?? 0) > 0;
  const hasBudgetAlert = (budgetAlertsResult.count ?? 0) > 0;
  const hasDeviceToken = (deviceTokensResult.count ?? 0) > 0;
  const hasApiKey = (apiKeysResult.count ?? 0) > 0;

  // For team member check: user needs to have invited someone (not just be a member).
  // We check team_invitations sent by this user, or team_members count > 1 for any
  // team this user owns. A simpler heuristic: check if there are pending or accepted
  // invitations sent by this user.
  let hasInvitedTeamMember = false;
  if (tier === 'growth') {
    const { count: invitationCount } = await supabase
      .from('team_invitations')
      .select('id', { count: 'exact', head: true })
      .eq('invited_by', userId);

    hasInvitedTeamMember = (invitationCount ?? 0) > 0;
  }

  // Build completion map
  const completionMap: Record<string, boolean> = {
    connectMachine: hasMachine,
    setBudgetAlert: hasBudgetAlert,
    installMobileApp: hasDeviceToken,
    inviteTeamMember: hasInvitedTeamMember,
    createApiKey: hasApiKey,
  };

  // Build steps array for this tier
  const stepKeys = TIER_STEPS[tier];
  const steps: OnboardingStep[] = stepKeys.map((key) => ({
    ...STEP_DEFINITIONS[key],
    completed: completionMap[key] ?? false,
  }));

  const completedCount = steps.filter((s) => s.completed).length;
  const totalSteps = steps.length;
  const isComplete = completedCount === totalSteps;

  return {
    tier,
    steps,
    completedCount,
    totalSteps,
    isComplete,
    onboardingCompletedAt: null,
  };
}
