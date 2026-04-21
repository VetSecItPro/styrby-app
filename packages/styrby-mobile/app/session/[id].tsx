/**
 * Session Detail Screen
 *
 * Displays detailed information about a specific coding session including:
 * - Session metadata (agent, status, cost, duration)
 * - AI-generated summary (Pro+ only)
 * - Quick actions (view chat, copy ID)
 *
 * Accessible via deep link: styrby://session/:id
 *
 * @route /session/:id
 */

import { View, Text, ScrollView, Pressable, ActivityIndicator, Share, Alert } from 'react-native';
import { useLocalSearchParams, Stack, router } from 'expo-router';
import { useEffect, useState, useCallback } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../src/lib/supabase';
import { useBookmarks } from '../../src/hooks/useBookmarks';
import { SessionSummary } from '../../src/components/SessionSummary';
import { SessionReplay, type ReplayMessageData } from '../../src/components/SessionReplay';
import { SessionTagEditor } from '../../src/components/SessionTagEditor';
import { ContextBreakdown } from '../../src/components/ContextBreakdown';
import { SessionCheckpoints } from '../../src/components/SessionCheckpoints';
import { formatCost } from '../../src/hooks/useCosts';
import type { AgentType, SessionExport, SessionExportMetadata, SessionExportMessage, SessionExportCost, BillingModel, CostSource } from 'styrby-shared';
import { CostPill } from '../../src/components/costs/CostPill';

// ============================================================================
// Types
// ============================================================================

/**
 * Session data from the database (subset of columns we need).
 */
interface SessionData {
  id: string;
  user_id: string;
  machine_id: string;
  agent_type: string;
  status: string;
  title: string | null;
  summary: string | null;
  summary_generated_at: string | null;
  project_path: string | null;
  git_branch: string | null;
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  message_count: number;
  tags: string[];
  started_at: string;
  ended_at: string | null;
  error_message: string | null;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Visual configuration for each supported AI agent.
 * Covers all 11 AgentType values so the session detail screen renders
 * the correct brand color regardless of which agent ran the session.
 */
const AGENT_CONFIG: Record<string, { name: string; color: string }> = {
  claude: { name: 'Claude', color: '#f97316' },
  codex: { name: 'Codex', color: '#22c55e' },
  gemini: { name: 'Gemini', color: '#3b82f6' },
  opencode: { name: 'OpenCode', color: '#8b5cf6' },
  aider: { name: 'Aider', color: '#ec4899' },
  goose: { name: 'Goose', color: '#14b8a6' },
  amp: { name: 'Amp', color: '#f59e0b' },
  crush: { name: 'Crush', color: '#f43f5e' },
  kilo: { name: 'Kilo', color: '#0ea5e9' },
  kiro: { name: 'Kiro', color: '#f97316' },
  droid: { name: 'Droid', color: '#64748b' },
};

/**
 * Status labels and colors.
 */
const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  starting: { label: 'Starting', color: '#22c55e' },
  running: { label: 'Active', color: '#22c55e' },
  idle: { label: 'Idle', color: '#22c55e' },
  paused: { label: 'Paused', color: '#eab308' },
  stopped: { label: 'Completed', color: '#71717a' },
  error: { label: 'Error', color: '#ef4444' },
  expired: { label: 'Expired', color: '#71717a' },
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Formats a duration in minutes into a human-readable string.
 *
 * @param minutes - Duration in minutes
 * @returns Formatted duration string (e.g., "1h 23m" or "45m")
 */
function formatDuration(minutes: number): string {
  if (minutes < 60) {
    return `${Math.round(minutes)}m`;
  }
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

/**
 * Formats a timestamp into a readable date and time.
 *
 * @param isoTimestamp - ISO 8601 timestamp
 * @returns Formatted date string
 */
function formatTimestamp(isoTimestamp: string): string {
  return new Date(isoTimestamp).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// ============================================================================
// Component
// ============================================================================

/**
 * Session detail screen showing comprehensive session information.
 *
 * @returns React element for the session detail screen
 */
/**
 * View mode for the session display.
 */
type ViewMode = 'details' | 'replay';

export default function SessionDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [session, setSession] = useState<SessionData | null>(null);
  const [userTier, setUserTier] = useState<'free' | 'pro' | 'power'>('free');

  /**
   * Bookmark hook — provides the user's bookmarked session IDs and toggle fn.
   * WHY: We use the shared hook so bookmark state is consistent if the user
   * navigates back to the sessions list (both views share the same fetched set
   * via independent hook instances that both call /api/bookmarks on mount).
   */
  const {
    bookmarkedIds,
    togglingIds,
    toggleErrors,
    toggleBookmark,
  } = useBookmarks();
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('details');
  const [replayMessages, setReplayMessages] = useState<ReplayMessageData[]>([]);
  /**
   * Raw message rows preserved for session export.
   * WHY: The replayMessages array converts message types to roles and drops
   * encryption data. For export we need the original rows with all fields.
   */
  const [rawMessages, setRawMessages] = useState<Array<{
    id: string;
    sequence_number: number;
    message_type: string;
    content_encrypted: string | null;
    encryption_nonce: string | null;
    duration_ms: number | null;
    input_tokens: number;
    output_tokens: number;
    cache_tokens: number;
    created_at: string;
  }>>([]);
  const [isExporting, setIsExporting] = useState(false);

  /**
   * Billing model and source for the session's cost records.
   * Derived from the most common billing_model in cost_records for this session.
   * Defaults to 'api-key' / 'styrby-estimate' when data is unavailable.
   */
  const [sessionBillingModel, setSessionBillingModel] = useState<BillingModel>('api-key');
  const [sessionCostSource, setSessionCostSource] = useState<CostSource>('styrby-estimate');
  const [sessionSubscriptionFraction, setSessionSubscriptionFraction] = useState<number | null>(null);
  const [sessionCreditsConsumed, setSessionCreditsConsumed] = useState<number | null>(null);
  const [sessionCreditRateUsd, setSessionCreditRateUsd] = useState<number | null>(null);

  /**
   * Share link state for session sharing (Phase 7.10).
   * Holds the generated URL and share ID after creation.
   */
  // WHY: _shareUrl getter unused — the URL is used directly from the API
  // response data object. Kept as state so future UI (copy-link button) can
  // read it without re-fetching.
  const [_shareUrl, setShareUrl] = useState<string | null>(null);
  const [isSharing, setIsSharing] = useState(false);

  // Fetch session data on mount
  useEffect(() => {
    async function loadSession() {
      try {
        setIsLoading(true);
        setError(null);

        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
          setError('Please log in to view this session');
          return;
        }

        // Fetch session
        const { data: sessionData, error: sessionError } = await supabase
          .from('sessions')
          .select('*')
          .eq('id', id)
          .single();

        if (sessionError || !sessionData) {
          setError('Session not found');
          return;
        }

        setSession(sessionData as SessionData);

        // Fetch subscription tier
        const { data: subscription } = await supabase
          .from('subscriptions')
          .select('tier')
          .eq('user_id', user.id)
          .single();

        setUserTier((subscription?.tier as 'free' | 'pro' | 'power') || 'free');

        // Fetch billing model metadata for this session's cost records.
        // WHY: The sessions table stores total_cost_usd but not billing_model
        // (which is a cost_records column from migration 022). We query a
        // small subset of cost_records to determine the predominant billing model
        // so the cost display can branch correctly ($ / quota / credits).
        // We take the first row's billing_model since most sessions use one model.
        const { data: billingData } = await supabase
          .from('cost_records')
          .select('billing_model, source, subscription_fraction_used, credits_consumed, credit_rate_usd')
          .eq('session_id', id)
          .limit(50);

        if (billingData && billingData.length > 0) {
          // Determine predominant billing model by counting occurrences
          const modelCounts: Partial<Record<BillingModel, number>> = {};
          let dominantSource: CostSource = 'styrby-estimate';
          let totalSubFraction = 0;
          let subCount = 0;
          let totalCredits = 0;
          let totalCreditRate = 0;
          let creditCount = 0;

          for (const row of billingData) {
            const bm = (row.billing_model as BillingModel | null) ?? 'api-key';
            modelCounts[bm] = (modelCounts[bm] ?? 0) + 1;

            if (row.source === 'agent-reported') {
              dominantSource = 'agent-reported';
            }
            if (bm === 'subscription' && row.subscription_fraction_used != null) {
              totalSubFraction += Number(row.subscription_fraction_used) || 0;
              subCount++;
            }
            if (bm === 'credit') {
              totalCredits += Number(row.credits_consumed) || 0;
              totalCreditRate += Number(row.credit_rate_usd) || 0;
              creditCount++;
            }
          }

          // Pick the billing model with the most records
          const dominant = (Object.entries(modelCounts) as Array<[BillingModel, number]>)
            .sort(([, a], [, b]) => b - a)[0]?.[0] ?? 'api-key';

          setSessionBillingModel(dominant);
          setSessionCostSource(dominantSource);
          setSessionSubscriptionFraction(subCount > 0 ? totalSubFraction / subCount : null);
          setSessionCreditsConsumed(totalCredits > 0 ? totalCredits : null);
          setSessionCreditRateUsd(creditCount > 0 ? totalCreditRate / creditCount : null);
        }

        // Fetch messages for replay if session is completed
        const isSessionComplete = ['stopped', 'error', 'expired'].includes(sessionData.status);
        if (isSessionComplete && sessionData.message_count > 0) {
          // WHY: We fetch extra columns (sequence_number, encryption_nonce, token
          // counts) so the same fetch can serve both the replay viewer and the
          // session export. Fetching once avoids a double-read on open.
          const { data: messages } = await supabase
            .from('session_messages')
            .select('id, sequence_number, message_type, content_encrypted, encryption_nonce, created_at, duration_ms, input_tokens, output_tokens, cache_tokens')
            .eq('session_id', id)
            .order('sequence_number', { ascending: true });

          if (messages && messages.length > 0) {
            // Store raw rows for export
            setRawMessages(messages as typeof rawMessages);

            // Convert message_type to role for the replay viewer
            const typeToRole = (type: string): 'user' | 'assistant' | 'system' => {
              if (type === 'user-input' || type === 'user') return 'user';
              if (type === 'tool-call' || type === 'tool-result') return 'system';
              return 'assistant';
            };

            const replayData: ReplayMessageData[] = messages.map((msg) => {
              // WHY: Compute per-message cost estimate from token counts stored on the
              // message row (written by CLI at insertion time). Uses Sonnet-4 average
              // pricing consistent with the web chat thread cost pill display.
              const inputT = (msg as typeof msg & { input_tokens?: number }).input_tokens ?? 0;
              const outputT = (msg as typeof msg & { output_tokens?: number }).output_tokens ?? 0;
              const cacheT = (msg as typeof msg & { cache_tokens?: number }).cache_tokens ?? 0;
              const totalTokens = inputT + outputT + cacheT;
              const costUsd = totalTokens > 0
                ? ((inputT * 3) + (outputT * 15) + (cacheT * 0.30)) / 1_000_000
                : undefined;

              return {
                id: msg.id,
                role: typeToRole(msg.message_type),
                agentType: sessionData.agent_type as AgentType,
                content: msg.content_encrypted || '[Encrypted message]',
                createdAt: msg.created_at,
                costUsd,
                durationMs: msg.duration_ms ?? undefined,
              };
            });
            setReplayMessages(replayData);
          }
        }
      } catch (err) {
        setError('Failed to load session');
        if (__DEV__) console.error('Session load error:', err);
      } finally {
        setIsLoading(false);
      }
    }

    if (id) {
      loadSession();
    }
  }, [id]);

  /**
   * Handles entering replay mode.
   */
  const handleStartReplay = useCallback(() => {
    setViewMode('replay');
  }, []);

  /**
   * Handles exiting replay mode.
   */
  const handleExitReplay = useCallback(() => {
    setViewMode('details');
  }, []);

  /**
   * Export the session as a JSON file and share it via the native Share sheet.
   *
   * WHY: Mobile users want to archive sessions or send them to teammates.
   * The native Share sheet lets them save to Files, AirDrop, email, Slack,
   * etc. without us needing to handle every platform specifically.
   *
   * Messages are kept encrypted in the export payload because:
   * 1. The E2E key is never stored on the mobile app — decryption would
   *    require the CLI-side key material.
   * 2. Keeping content encrypted means the export file is safe to share
   *    without accidentally leaking session transcript content.
   */
  const handleExport = useCallback(async () => {
    if (!session) return;
    setIsExporting(true);
    try {
      const exportMessages: SessionExportMessage[] = rawMessages.map((m) => ({
        id: m.id,
        sequenceNumber: m.sequence_number,
        messageType: m.message_type,
        contentEncrypted: m.content_encrypted,
        encryptionNonce: m.encryption_nonce,
        riskLevel: null,
        toolName: null,
        durationMs: m.duration_ms,
        inputTokens: m.input_tokens,
        outputTokens: m.output_tokens,
        cacheTokens: m.cache_tokens,
        createdAt: m.created_at,
      }));

      const exportMetadata: SessionExportMetadata = {
        id: session.id,
        title: session.title,
        summary: session.summary,
        agentType: session.agent_type,
        model: null,
        status: session.status,
        projectPath: session.project_path,
        gitBranch: session.git_branch,
        gitRemoteUrl: null,
        tags: session.tags ?? [],
        startedAt: session.started_at,
        endedAt: session.ended_at,
        messageCount: session.message_count,
        contextWindowUsed: null,
        contextWindowLimit: null,
      };

      const exportCost: SessionExportCost = {
        totalCostUsd: Number(session.total_cost_usd),
        totalInputTokens: session.total_input_tokens,
        totalOutputTokens: session.total_output_tokens,
        totalCacheTokens: 0,
        model: null,
        agentType: session.agent_type,
      };

      const exportData: SessionExport = {
        exportVersion: 1,
        exportedAt: new Date().toISOString(),
        generatedBy: 'styrby-mobile',
        session: exportMetadata,
        messages: exportMessages,
        cost: exportCost,
        contextBreakdown: null,
      };

      const json = JSON.stringify(exportData, null, 2);
      const dateStr = session.started_at.slice(0, 10);
      const filename = `styrby-session-${session.id.slice(0, 8)}-${dateStr}.json`;

      // Use React Native's Share API to open the native share sheet.
      // WHY: expo-file-system + expo-sharing would require additional deps.
      // For text content, the built-in Share API is sufficient and works
      // across iOS and Android without extra native modules.
      const result = await Share.share({
        title: filename,
        message: json,
      });

      if (__DEV__ && result.action === Share.dismissedAction) {
        console.log('[SessionExport] User dismissed share sheet');
      }
    } catch (err) {
      Alert.alert(
        'Export Failed',
        err instanceof Error ? err.message : 'Failed to export session',
      );
      if (__DEV__) console.error('[SessionExport] Export error:', err);
    } finally {
      setIsExporting(false);
    }
  }, [session, rawMessages]);

  /**
   * Creates a shareable replay link via the Styrby API, then opens the
   * native share sheet so the user can send the link via any app.
   *
   * The decryption key is presented separately in an Alert so the user
   * understands it must be shared via a secure channel (Signal, etc.).
   *
   * WHY two-step share: If the link and key were in the same native share
   * sheet, they would inevitably end up in the same message thread —
   * defeating the security benefit of keeping them separate. The Alert
   * forces the user to consciously choose how to share the key.
   */
  const handleShare = useCallback(async () => {
    if (!session) return;
    setIsSharing(true);

    try {
      // Get the current user's session token for the API call
      const { data: { session: authSession } } = await supabase.auth.getSession();
      const token = authSession?.access_token;

      if (!token) {
        Alert.alert('Not Authenticated', 'Please log in to share sessions.');
        return;
      }

      const appUrl = process.env.EXPO_PUBLIC_APP_URL ?? 'https://app.styrby.com';
      const response = await fetch(`${appUrl}/api/sessions/${session.id}/share`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as { message?: string };
        throw new Error(data.message ?? 'Failed to create share link');
      }

      const data = await response.json() as { shareUrl: string };
      setShareUrl(data.shareUrl);

      // Step 1: Share the URL via the native share sheet
      const shareResult = await Share.share({
        title: `Session Replay: ${session.title || 'Untitled'}`,
        message: `Check out this Styrby session replay:\n${data.shareUrl}`,
        url: data.shareUrl,
      });

      if (shareResult.action === Share.sharedAction) {
        // Step 2: Remind user about the decryption key
        Alert.alert(
          'Share the Decryption Key Separately',
          'The session replay link has been shared. Remember to also send the decryption key via a secure channel (Signal, 1Password, etc.).\n\nThe key is on the CLI machine that ran this session.',
          [{ text: 'Got it', style: 'default' }]
        );
      }
    } catch (err) {
      Alert.alert(
        'Share Failed',
        err instanceof Error ? err.message : 'Failed to create share link',
      );
      if (__DEV__) console.error('[SessionShare] Share error:', err);
    } finally {
      setIsSharing(false);
    }
  }, [session]);

  // Calculate derived values
  const agentConfig = session ? AGENT_CONFIG[session.agent_type] || { name: session.agent_type, color: '#71717a' } : null;
  const statusConfig = session ? STATUS_CONFIG[session.status] || { label: session.status, color: '#71717a' } : null;
  const duration = session?.ended_at && session?.started_at
    ? (new Date(session.ended_at).getTime() - new Date(session.started_at).getTime()) / 60000
    : null;

  // ──────────────────────────────────────────
  // Render: Loading state
  // ──────────────────────────────────────────
  if (isLoading) {
    return (
      <>
        <Stack.Screen
          options={{
            title: 'Session Details',
            headerBackTitle: 'Sessions',
          }}
        />
        <View className="flex-1 bg-background items-center justify-center">
          <ActivityIndicator size="large" color="#f97316" />
          <Text className="text-zinc-500 mt-4">Loading session...</Text>
        </View>
      </>
    );
  }

  // ──────────────────────────────────────────
  // Render: Error state
  // ──────────────────────────────────────────
  if (error || !session) {
    return (
      <>
        <Stack.Screen
          options={{
            title: 'Session Details',
            headerBackTitle: 'Sessions',
          }}
        />
        <View className="flex-1 bg-background items-center justify-center px-6">
          <Ionicons name="alert-circle-outline" size={48} color="#ef4444" />
          <Text className="text-white text-lg font-semibold mt-4">
            {error || 'Session not found'}
          </Text>
          <Pressable
            onPress={() => router.back()}
            className="bg-zinc-800 px-6 py-3 rounded-xl mt-6 active:opacity-80"
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Text className="text-white font-semibold">Go Back</Text>
          </Pressable>
        </View>
      </>
    );
  }

  // Check if session is completed (can replay)
  const isSessionComplete = ['stopped', 'error', 'expired'].includes(session.status);
  const canReplay = isSessionComplete && replayMessages.length > 0;

  // ──────────────────────────────────────────
  // Render: Replay mode
  // ──────────────────────────────────────────
  if (viewMode === 'replay') {
    return (
      <>
        <Stack.Screen
          options={{
            title: 'Session Replay',
            headerBackTitle: 'Details',
            headerShown: false,
          }}
        />
        <SessionReplay
          messages={replayMessages}
          userTier={userTier}
          onExit={handleExitReplay}
        />
      </>
    );
  }

  // ──────────────────────────────────────────
  // Render: Session details
  // ──────────────────────────────────────────
  return (
    <>
      <Stack.Screen
        options={{
          title: session.title || 'Session Details',
          headerBackTitle: 'Sessions',
        }}
      />
      <ScrollView className="flex-1 bg-background">
        {/* Header section */}
        <View className="px-4 pt-4 pb-2">
          {/* Title row with bookmark button */}
          <View className="flex-row items-start justify-between mb-2">
            <Text className="text-white text-xl font-bold flex-1 mr-3">
              {session.title || 'Untitled Session'}
            </Text>

            {/* Bookmark star button
                WHY: Large touch target (44×44) ensures easy tapping.
                Placed in the header title row so it's immediately visible. */}
            <Pressable
              onPress={() => toggleBookmark(session.id)}
              disabled={togglingIds.has(session.id)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={
                bookmarkedIds.has(session.id)
                  ? 'Remove bookmark'
                  : 'Bookmark this session'
              }
              accessibilityState={{ checked: bookmarkedIds.has(session.id) }}
              style={{ opacity: togglingIds.has(session.id) ? 0.4 : 1, padding: 4 }}
            >
              <Ionicons
                name={bookmarkedIds.has(session.id) ? 'star' : 'star-outline'}
                size={24}
                color={bookmarkedIds.has(session.id) ? '#f97316' : '#52525b'}
              />
            </Pressable>
          </View>

          {/* Bookmark toggle error */}
          {toggleErrors.get(session.id) && (
            <Text className="text-red-400 text-xs mb-2">
              {toggleErrors.get(session.id)}
            </Text>
          )}

          {/* Badges row */}
          <View className="flex-row items-center flex-wrap gap-2 mb-4">
            {/* Agent badge */}
            <View
              className="px-3 py-1 rounded-full"
              style={{ backgroundColor: `${agentConfig?.color}20` }}
            >
              <Text
                className="text-sm font-medium"
                style={{ color: agentConfig?.color }}
              >
                {agentConfig?.name}
              </Text>
            </View>

            {/* Status badge */}
            <View
              className="px-3 py-1 rounded-full"
              style={{ backgroundColor: `${statusConfig?.color}20` }}
            >
              <Text
                className="text-sm font-medium"
                style={{ color: statusConfig?.color }}
              >
                {statusConfig?.label}
              </Text>
            </View>
          </View>
        </View>

        {/* Summary section */}
        <SessionSummary
          summary={session.summary}
          summaryGeneratedAt={session.summary_generated_at}
          sessionStatus={session.status}
          userTier={userTier}
        />

        {/* Tag editor — below metadata, above stats */}
        <SessionTagEditor
          sessionId={session.id}
          initialTags={session.tags ?? []}
        />

        {/* Stats section */}
        <View className="mx-4 mb-4 rounded-2xl bg-zinc-900 border border-zinc-800 p-4">
          <Text className="text-zinc-400 text-xs font-medium uppercase tracking-wide mb-3">
            Session Stats
          </Text>

          <View className="flex-row flex-wrap">
            {/* Cost — branched on billing model from migration 022 cost_records columns */}
            <View className="w-1/2 mb-4">
              <Text className="text-zinc-500 text-xs mb-1">Total Cost</Text>
              <View className="flex-row items-center flex-wrap gap-1 mt-0.5">
                <CostPill
                  billingModel={sessionBillingModel}
                  costUsd={session.total_cost_usd}
                  subscriptionFractionUsed={sessionSubscriptionFraction}
                  creditsConsumed={sessionCreditsConsumed}
                  creditRateUsd={sessionCreditRateUsd}
                  source={sessionCostSource}
                  decimals={4}
                />
              </View>
            </View>

            {/* Duration */}
            <View className="w-1/2 mb-4">
              <Text className="text-zinc-500 text-xs mb-1">Duration</Text>
              <Text className="text-white text-lg font-semibold">
                {duration ? formatDuration(duration) : '--'}
              </Text>
            </View>

            {/* Messages */}
            <View className="w-1/2 mb-4">
              <Text className="text-zinc-500 text-xs mb-1">Messages</Text>
              <Text className="text-white text-lg font-semibold">
                {session.message_count}
              </Text>
            </View>

            {/* Tokens */}
            <View className="w-1/2 mb-4">
              <Text className="text-zinc-500 text-xs mb-1">Tokens</Text>
              <Text className="text-white text-lg font-semibold">
                {(session.total_input_tokens + session.total_output_tokens).toLocaleString()}
              </Text>
            </View>
          </View>
        </View>

        {/* Metadata section */}
        <View className="mx-4 mb-4 rounded-2xl bg-zinc-900 border border-zinc-800 p-4">
          <Text className="text-zinc-400 text-xs font-medium uppercase tracking-wide mb-3">
            Details
          </Text>

          {/* Started */}
          <View className="flex-row items-center justify-between py-2 border-b border-zinc-800/50">
            <Text className="text-zinc-400 text-sm">Started</Text>
            <Text className="text-white text-sm">
              {formatTimestamp(session.started_at)}
            </Text>
          </View>

          {/* Ended */}
          {session.ended_at && (
            <View className="flex-row items-center justify-between py-2 border-b border-zinc-800/50">
              <Text className="text-zinc-400 text-sm">Ended</Text>
              <Text className="text-white text-sm">
                {formatTimestamp(session.ended_at)}
              </Text>
            </View>
          )}

          {/* Project path */}
          {session.project_path && (
            <View className="py-2 border-b border-zinc-800/50">
              <Text className="text-zinc-400 text-sm mb-1">Project</Text>
              <Text className="text-white text-sm font-mono" numberOfLines={2}>
                {session.project_path}
              </Text>
            </View>
          )}

          {/* Git branch */}
          {session.git_branch && (
            <View className="flex-row items-center justify-between py-2">
              <Text className="text-zinc-400 text-sm">Branch</Text>
              <View className="flex-row items-center">
                <Ionicons name="git-branch" size={14} color="#71717a" />
                <Text className="text-white text-sm ml-1">{session.git_branch}</Text>
              </View>
            </View>
          )}

          {/* Error message */}
          {session.error_message && (
            <View className="py-2 mt-2 border-t border-zinc-800/50">
              <Text className="text-red-400 text-sm">
                Error: {session.error_message}
              </Text>
            </View>
          )}
        </View>

        {/* Context Budget Breakdown */}
        {/* WHY: context_breakdown is populated by the CLI relay during active
            sessions. For completed sessions it will be null until the relay
            streams the data. The component renders its own empty state. */}
        <ContextBreakdown breakdown={null} />

        {/* Named Session Checkpoints
            WHY: Shown for all sessions (active and completed). During active
            sessions the user can save checkpoints; for completed sessions they
            can view the timeline markers and restore to a prior position. */}
        <SessionCheckpoints
          sessionId={session.id}
          currentMessageCount={session.message_count}
          isSessionActive={['starting', 'running', 'idle'].includes(session.status)}
          onRestore={(checkpoint) => {
            // WHY: On mobile, "restore" means showing an alert with the checkpoint
            // context so the user knows what state the agent was in at that point.
            // Full in-session rollback is a future feature requiring agent IPC.
            Alert.alert(
              `Checkpoint: ${checkpoint.name}`,
              [
                `Message: ${checkpoint.messageSequenceNumber}`,
                `Tokens: ${checkpoint.contextSnapshot.totalTokens.toLocaleString()}`,
                checkpoint.description ? `\n${checkpoint.description}` : '',
              ]
                .filter(Boolean)
                .join('\n'),
              [{ text: 'OK' }]
            );
          }}
        />

        {/* Actions section */}
        <View className="mx-4 mb-8 gap-3">
          {/* Replay button (Pro+ feature) */}
          {canReplay && (
            <Pressable
              onPress={handleStartReplay}
              className="flex-row items-center justify-center bg-orange-500/10 border border-orange-500/30 rounded-xl py-4 active:opacity-80"
              accessibilityRole="button"
              accessibilityLabel="Replay this session"
            >
              <Ionicons name="play-circle" size={20} color="#f97316" />
              <Text className="text-orange-500 font-semibold ml-2">
                {userTier === 'free' ? 'Replay (Pro)' : 'Replay Session'}
              </Text>
            </Pressable>
          )}

          {/* Share replay link button (Phase 7.10) */}
          {isSessionComplete && (
            <Pressable
              onPress={handleShare}
              disabled={isSharing}
              className="flex-row items-center justify-center bg-blue-600/10 border border-blue-500/30 rounded-xl py-4 active:opacity-80 disabled:opacity-50"
              accessibilityRole="button"
              accessibilityLabel={isSharing ? 'Creating share link...' : 'Share session replay link'}
            >
              <Ionicons
                name={isSharing ? 'hourglass-outline' : 'link-outline'}
                size={20}
                color="#3b82f6"
              />
              <Text className="text-blue-400 font-semibold ml-2">
                {isSharing ? 'Creating Link…' : 'Share Replay Link'}
              </Text>
            </Pressable>
          )}

          {/* Export button — share session JSON via native share sheet */}
          <Pressable
            onPress={handleExport}
            disabled={isExporting}
            className="flex-row items-center justify-center bg-zinc-800 border border-zinc-700 rounded-xl py-4 active:opacity-80 disabled:opacity-50"
            accessibilityRole="button"
            accessibilityLabel={isExporting ? 'Exporting session...' : 'Export session as JSON'}
          >
            <Ionicons
              name={isExporting ? 'hourglass-outline' : 'share-outline'}
              size={20}
              color="#a1a1aa"
            />
            <Text className="text-zinc-300 font-semibold ml-2">
              {isExporting ? 'Exporting…' : 'Export Session'}
            </Text>
          </Pressable>

          {/* View chat button */}
          <Pressable
            onPress={() =>
              router.push({
                pathname: '/(tabs)/chat',
                params: {
                  sessionId: session.id,
                  agent: session.agent_type,
                },
              })
            }
            className="bg-brand rounded-xl py-4 items-center active:opacity-80"
            accessibilityRole="button"
            accessibilityLabel="Open chat for this session"
          >
            <Text className="text-white font-semibold">View Chat History</Text>
          </Pressable>
        </View>
      </ScrollView>
    </>
  );
}
