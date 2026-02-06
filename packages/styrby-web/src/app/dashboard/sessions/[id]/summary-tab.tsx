'use client';

/**
 * Session Summary Tab Component
 *
 * Displays an AI-generated summary of a completed coding session.
 * Shows different states based on:
 * - Session status (active vs completed)
 * - Summary availability
 * - User's subscription tier (Pro+ only)
 *
 * @component
 */

import { useState } from 'react';
import Link from 'next/link';

/* ──────────────────────────── Types ──────────────────────────── */

/**
 * Props for the SummaryTab component.
 */
interface SummaryTabProps {
  /** The session's current summary (null if not generated yet) */
  summary: string | null;

  /** When the summary was generated (null if not yet) */
  summaryGeneratedAt: string | null;

  /** The session's current status */
  sessionStatus: string;

  /** The user's subscription tier */
  userTier: 'free' | 'pro' | 'power';

  /** The session ID (for regeneration requests) */
  sessionId: string;
}

/* ──────────────────────────── Icons ──────────────────────────── */

/**
 * Sparkles icon for AI-generated content indicator.
 */
function SparklesIcon({ className }: { className?: string }) {
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
        d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z"
      />
    </svg>
  );
}

/**
 * Lock icon for tier-gated content.
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

/**
 * Chevron icon for collapsible sections.
 */
function ChevronIcon({
  className,
  expanded,
}: {
  className?: string;
  expanded: boolean;
}) {
  return (
    <svg
      className={`${className} transition-transform duration-200 ${
        expanded ? 'rotate-180' : ''
      }`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M19 9l-7 7-7-7"
      />
    </svg>
  );
}

/**
 * Clock icon for loading/generating state.
 */
function ClockIcon({ className }: { className?: string }) {
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
        d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  );
}

/* ──────────────────────────── Component ──────────────────────── */

/**
 * Renders the session summary in a collapsible card.
 *
 * WHY collapsible: Summaries can be several paragraphs long. Making it
 * collapsible keeps the session detail page clean while still providing
 * quick access to the summary when needed.
 *
 * WHY tier gating: AI summary generation costs money (OpenAI API).
 * Free tier users see an upgrade prompt to encourage conversion.
 *
 * @param props - Component configuration
 */
export function SummaryTab({
  summary,
  summaryGeneratedAt,
  sessionStatus,
  userTier,
  sessionId: _sessionId,
}: SummaryTabProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  // Determine if the session is in a completed state
  const isSessionCompleted = ['stopped', 'expired', 'error'].includes(sessionStatus);
  const isSessionActive = ['starting', 'running', 'idle', 'paused'].includes(sessionStatus);

  // Check if user has access to summaries
  const hasSummaryAccess = userTier === 'pro' || userTier === 'power';

  // ──────────────────────────────────────────
  // Render: Free tier upgrade prompt
  // ──────────────────────────────────────────
  if (!hasSummaryAccess) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden">
        <div className="p-6 text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-orange-500/10 mb-4">
            <LockIcon className="h-6 w-6 text-orange-400" />
          </div>

          <h3 className="text-lg font-semibold text-zinc-100 mb-2">
            AI Session Summaries
          </h3>

          <p className="text-sm text-zinc-400 mb-4 max-w-md mx-auto">
            Get AI-generated summaries of your coding sessions. Quickly understand
            what was accomplished without reading through the entire chat history.
          </p>

          <Link
            href="/pricing"
            className="inline-flex items-center gap-2 rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 transition-colors"
          >
            <SparklesIcon className="h-4 w-4" />
            Upgrade to Pro
          </Link>

          <p className="text-xs text-zinc-500 mt-3">
            Available on Pro and Power plans
          </p>
        </div>
      </div>
    );
  }

  // ──────────────────────────────────────────
  // Render: Active session (no summary yet)
  // ──────────────────────────────────────────
  if (isSessionActive) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden">
        <div className="p-6 text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-blue-500/10 mb-4">
            <SparklesIcon className="h-6 w-6 text-blue-400" />
          </div>

          <h3 className="text-lg font-semibold text-zinc-100 mb-2">
            Summary Available After Session
          </h3>

          <p className="text-sm text-zinc-400 max-w-md mx-auto">
            An AI summary will be automatically generated when this session ends.
            The summary captures key goals, actions taken, and outcomes.
          </p>
        </div>
      </div>
    );
  }

  // ──────────────────────────────────────────
  // Render: Generating state
  // ──────────────────────────────────────────
  if (isSessionCompleted && !summary && !summaryGeneratedAt) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden">
        <div className="p-6 text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-purple-500/10 mb-4">
            <ClockIcon className="h-6 w-6 text-purple-400 animate-pulse" />
          </div>

          <h3 className="text-lg font-semibold text-zinc-100 mb-2">
            Generating Summary...
          </h3>

          <p className="text-sm text-zinc-400 max-w-md mx-auto">
            Our AI is analyzing your session to create a concise summary.
            This usually takes 10-30 seconds.
          </p>
        </div>
      </div>
    );
  }

  // ──────────────────────────────────────────
  // Render: No summary available (old session)
  // ──────────────────────────────────────────
  if (isSessionCompleted && !summary) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden">
        <div className="p-6 text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-zinc-700/50 mb-4">
            <SparklesIcon className="h-6 w-6 text-zinc-500" />
          </div>

          <h3 className="text-lg font-semibold text-zinc-100 mb-2">
            No Summary Available
          </h3>

          <p className="text-sm text-zinc-400 max-w-md mx-auto">
            This session was created before AI summaries were enabled.
            Summaries are automatically generated for new sessions when they complete.
          </p>
        </div>
      </div>
    );
  }

  // ──────────────────────────────────────────
  // Render: Summary available
  // ──────────────────────────────────────────
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden">
      {/* Collapsible header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between p-4 hover:bg-zinc-800/30 transition-colors"
        aria-expanded={isExpanded}
        aria-controls="summary-content"
      >
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-full bg-purple-500/10">
            <SparklesIcon className="h-4 w-4 text-purple-400" />
          </div>
          <div className="text-left">
            <h3 className="text-sm font-semibold text-zinc-100">AI Summary</h3>
            {summaryGeneratedAt && (
              <p className="text-xs text-zinc-500">
                Generated{' '}
                {new Date(summaryGeneratedAt).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </p>
            )}
          </div>
        </div>

        <ChevronIcon className="h-5 w-5 text-zinc-400" expanded={isExpanded} />
      </button>

      {/* Collapsible content */}
      <div
        id="summary-content"
        className={`overflow-hidden transition-all duration-200 ease-in-out ${
          isExpanded ? 'max-h-[1000px] opacity-100' : 'max-h-0 opacity-0'
        }`}
      >
        <div className="px-4 pb-4 border-t border-zinc-800/50">
          <div className="pt-4 prose prose-sm prose-invert max-w-none">
            {/* WHY whitespace-pre-wrap: Preserve paragraph breaks from the AI output */}
            <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">
              {summary}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
