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

import { View, Text, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, Stack, router } from 'expo-router';
import { useEffect, useState, useCallback } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../src/lib/supabase';
import { SessionSummary } from '../../src/components/SessionSummary';
import { SessionReplay, type ReplayMessageData } from '../../src/components/SessionReplay';
import { formatCost } from '../../src/hooks/useCosts';

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
          const { data: messages } = await supabase
            .from('session_messages')
            .select('id, role, content_encrypted, created_at, cost_usd, duration_ms')
            .eq('session_id', id)
            .order('created_at', { ascending: true });

          if (messages && messages.length > 0) {
            // Convert to ReplayMessageData format
            const replayData: ReplayMessageData[] = messages.map((msg) => ({
              id: msg.id,
              role: msg.role === 'tool' ? 'system' : (msg.role as 'user' | 'assistant' | 'system'),
              agentType: sessionData.agent_type as 'claude' | 'codex' | 'gemini' | 'opencode' | 'aider',
              content: msg.content_encrypted || '[Encrypted message]',
              createdAt: msg.created_at,
              costUsd: msg.cost_usd ?? undefined,
              durationMs: msg.duration_ms ?? undefined,
            }));
            setReplayMessages(replayData);
          }
        }
      } catch (err) {
        setError('Failed to load session');
        console.error('Session load error:', err);
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

        {/* Actions section */}
        <View className="mx-4 mb-8 space-y-3">
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
