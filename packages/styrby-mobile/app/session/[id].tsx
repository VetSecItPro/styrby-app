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
import { SessionSummary } from '../../src/components/SessionSummary';
import { SessionReplay, type ReplayMessageData } from '../../src/components/SessionReplay';
import { SessionTagEditor } from '../../src/components/SessionTagEditor';
import { ContextBreakdown } from '../../src/components/ContextBreakdown';
import { formatCost } from '../../src/hooks/useCosts';
import type { SessionExport, SessionExportMetadata, SessionExportMessage, SessionExportCost } from 'styrby-shared';

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
 */
const AGENT_CONFIG: Record<string, { name: string; color: string }> = {
  claude: { name: 'Claude', color: '#f97316' },
  codex: { name: 'Codex', color: '#22c55e' },
  gemini: { name: 'Gemini', color: '#3b82f6' },
  opencode: { name: 'OpenCode', color: '#8b5cf6' },
  aider: { name: 'Aider', color: '#ec4899' },
  goose: { name: 'Goose', color: '#06b6d4' },
  amp: { name: 'Amp', color: '#f59e0b' },
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

            const replayData: ReplayMessageData[] = messages.map((msg) => ({
              id: msg.id,
              role: typeToRole(msg.message_type),
              agentType: sessionData.agent_type as 'claude' | 'codex' | 'gemini' | 'opencode' | 'aider' | 'goose' | 'amp',
              content: msg.content_encrypted || '[Encrypted message]',
              createdAt: msg.created_at,
              costUsd: undefined, // Costs are in cost_records, not session_messages
              durationMs: msg.duration_ms ?? undefined,
            }));
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
          {/* Title and status */}
          <Text className="text-white text-xl font-bold mb-2">
            {session.title || 'Untitled Session'}
          </Text>

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
            {/* Cost */}
            <View className="w-1/2 mb-4">
              <Text className="text-zinc-500 text-xs mb-1">Total Cost</Text>
              <Text className="text-white text-lg font-semibold">
                {formatCost(session.total_cost_usd)}
              </Text>
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
