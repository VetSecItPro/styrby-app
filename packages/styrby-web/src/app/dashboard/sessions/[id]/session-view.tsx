'use client';

/**
 * Session View Component
 *
 * Client component that manages the session view mode (live chat vs replay).
 * Allows users to switch between interacting with active sessions and
 * replaying completed sessions.
 */

import { useState, useCallback } from 'react';
import { ChatThread } from './chat-thread';
import { ChatInput } from './chat-input';
import { SummaryTab } from './summary-tab';
import { ReplayPlayer } from '@/components/session-replay';
import type { ReplayMessage } from '@/components/session-replay';
import { cn } from '@/lib/utils';

/* ──────────────────────────── Types ──────────────────────────── */

/**
 * Session data passed from the server component.
 */
interface Session {
  id: string;
  title: string | null;
  status: string;
  agent_type: string;
  created_at: string;
  ended_at: string | null;
  total_cost_usd: number | string;
  project_path: string | null;
  error_message: string | null;
  summary: string | null;
  summary_generated_at: string | null;
}

/**
 * Props for the SessionView component.
 */
interface SessionViewProps {
  /** The session data */
  session: Session;
  /** Initial messages for the session */
  messages: ReplayMessage[];
  /** Current user's ID */
  userId: string;
  /** User's subscription tier */
  userTier: 'free' | 'pro' | 'power';
}

/**
 * View mode for the session display.
 */
type ViewMode = 'chat' | 'replay';

/* ──────────────────────────── Icons ──────────────────────────── */

/**
 * Play/Replay icon.
 */
function ReplayIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24">
      <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z" />
    </svg>
  );
}

/**
 * Chat/Message icon.
 */
function ChatIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
      />
    </svg>
  );
}

/**
 * Lock icon for tier-gated features.
 */
function LockIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
      />
    </svg>
  );
}

/* ──────────────────────────── Component ──────────────────────── */

/**
 * Renders the session view with mode switching between chat and replay.
 *
 * WHY: Users need both real-time interaction for active sessions and
 * replay functionality for completed sessions. This component provides
 * a unified interface that adapts based on session state and user tier.
 *
 * @param props - SessionView configuration
 */
export function SessionView({
  session,
  messages,
  userId,
  userTier,
}: SessionViewProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('chat');

  const isSessionActive = ['starting', 'running', 'idle', 'paused'].includes(
    session.status
  );

  // Replay is available for Pro+ users on completed sessions
  const canAccessReplay = userTier !== 'free';
  const showReplayOption = !isSessionActive && messages.length > 0;

  /**
   * Handle switching to chat view.
   */
  const handleChatView = useCallback(() => {
    setViewMode('chat');
  }, []);

  /**
   * Handle switching to replay view.
   */
  const handleReplayView = useCallback(() => {
    if (canAccessReplay) {
      setViewMode('replay');
    }
  }, [canAccessReplay]);

  /**
   * Handle replay completion.
   */
  const handleReplayComplete = useCallback(() => {
    // Could add analytics or notification here
  }, []);

  return (
    <div className="flex h-full flex-col">
      {/* View mode toggle (only shown for completed sessions with messages) */}
      {showReplayOption && (
        <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/30 px-6 py-2">
          {/* Chat view button */}
          <button
            onClick={handleChatView}
            className={cn(
              'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
              viewMode === 'chat'
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
            )}
            aria-pressed={viewMode === 'chat'}
          >
            <ChatIcon className="h-4 w-4" />
            Chat
          </button>

          {/* Replay view button */}
          <button
            onClick={handleReplayView}
            disabled={!canAccessReplay}
            className={cn(
              'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
              viewMode === 'replay'
                ? 'bg-orange-500/20 text-orange-400'
                : canAccessReplay
                  ? 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
                  : 'text-zinc-600 cursor-not-allowed'
            )}
            aria-pressed={viewMode === 'replay'}
            aria-disabled={!canAccessReplay}
          >
            {canAccessReplay ? (
              <ReplayIcon className="h-4 w-4" />
            ) : (
              <LockIcon className="h-4 w-4" />
            )}
            Replay
            {!canAccessReplay && (
              <span className="ml-1 text-xs text-zinc-500">Pro</span>
            )}
          </button>

          {/* Upgrade prompt for free users */}
          {!canAccessReplay && (
            <div className="ml-auto">
              <a
                href="/pricing"
                className="text-xs text-orange-500 hover:text-orange-400 transition-colors"
              >
                Upgrade to unlock replay
              </a>
            </div>
          )}
        </div>
      )}

      {/* Main content area */}
      {viewMode === 'replay' && canAccessReplay ? (
        // Replay mode
        <ReplayPlayer
          sessionId={session.id}
          messages={messages}
          onReplayComplete={handleReplayComplete}
          onExitReplay={handleChatView}
        />
      ) : (
        // Chat mode (default)
        <>
          {/* Chat thread with real-time updates */}
          <ChatThread
            sessionId={session.id}
            userId={userId}
            initialMessages={messages}
            isSessionActive={isSessionActive}
          />

          {/* Input (only shown for active sessions) */}
          {isSessionActive && <ChatInput sessionId={session.id} />}

          {/* Ended session footer with summary */}
          {!isSessionActive && (
            <div className="border-t border-zinc-800 bg-zinc-900/50">
              {/* Summary section */}
              <div className="px-6 py-4">
                <SummaryTab
                  summary={session.summary}
                  summaryGeneratedAt={session.summary_generated_at}
                  sessionStatus={session.status}
                  userTier={userTier}
                  sessionId={session.id}
                />
              </div>

              {/* Session end info */}
              <div className="px-6 py-3 border-t border-zinc-800/50 text-center text-sm text-zinc-500">
                Session ended{' '}
                {session.ended_at
                  ? new Date(session.ended_at).toLocaleString()
                  : 'at unknown time'}
                {session.error_message && (
                  <span className="ml-2 text-red-400">
                    Error: {session.error_message}
                  </span>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
