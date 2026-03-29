'use client';

/**
 * SessionExportButton
 *
 * Client component that serialises a session (metadata + encrypted messages +
 * cost data + context breakdown) into a JSON blob and triggers a browser
 * download.
 *
 * WHY: Export is a client-side concern - we already have all the session data
 * in the page, so we can avoid an extra round-trip by assembling and downloading
 * the file entirely in the browser. This also means exports work offline once
 * the page is loaded (PWA use case).
 *
 * File format: `styrby-session-{id}-{YYYY-MM-DD}.json`
 *
 * @module app/dashboard/sessions/[id]/session-export-button
 */

import { useCallback, useState } from 'react';
import type { SessionExport, SessionExportMetadata, SessionExportMessage, SessionExportCost, ContextBreakdown } from '@styrby/shared';

// ============================================================================
// Types
// ============================================================================

/**
 * Minimal session shape required to produce an export.
 * Matches the columns selected in the parent server component.
 */
interface ExportableSession {
  id: string;
  title: string | null;
  summary: string | null;
  agent_type: string;
  model?: string | null;
  status: string;
  project_path: string | null;
  git_branch?: string | null;
  git_remote_url?: string | null;
  tags?: string[];
  started_at?: string;
  created_at: string;
  ended_at: string | null;
  message_count?: number;
  context_window_used?: number | null;
  context_window_limit?: number | null;
  total_cost_usd: number | string;
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_cache_tokens?: number;
}

/**
 * Minimal message shape from session_messages table.
 */
interface ExportableMessage {
  id: string;
  sequence_number: number;
  message_type: string;
  content_encrypted: string | null;
  encryption_nonce: string | null;
  risk_level?: string | null;
  tool_name?: string | null;
  duration_ms?: number | null;
  input_tokens?: number;
  output_tokens?: number;
  cache_tokens?: number;
  created_at: string;
}

/**
 * Props for SessionExportButton.
 */
interface SessionExportButtonProps {
  /** Session data to include in the export */
  session: ExportableSession;
  /** Messages to include (already fetched by the server component) */
  messages: ExportableMessage[];
  /**
   * Optional context breakdown to embed.
   * Pass null/undefined when not available.
   */
  contextBreakdown?: ContextBreakdown | null;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Format a date as YYYY-MM-DD for the filename.
 *
 * @param iso - ISO 8601 date string
 * @returns Date portion only, e.g. "2026-03-27"
 */
function toDateString(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Assemble a SessionExport object from raw Supabase rows.
 *
 * @param session - Session row from Supabase
 * @param messages - Message rows from session_messages
 * @param contextBreakdown - Optional context breakdown snapshot
 * @returns A well-typed, portable SessionExport
 */
function buildExport(
  session: ExportableSession,
  messages: ExportableMessage[],
  contextBreakdown: ContextBreakdown | null | undefined,
): SessionExport {
  const metadata: SessionExportMetadata = {
    id: session.id,
    title: session.title,
    summary: session.summary,
    agentType: session.agent_type,
    model: session.model ?? null,
    status: session.status,
    projectPath: session.project_path,
    gitBranch: session.git_branch ?? null,
    gitRemoteUrl: session.git_remote_url ?? null,
    tags: session.tags ?? [],
    startedAt: session.started_at ?? session.created_at,
    endedAt: session.ended_at,
    messageCount: session.message_count ?? messages.length,
    contextWindowUsed: session.context_window_used ?? null,
    contextWindowLimit: session.context_window_limit ?? null,
  };

  const exportMessages: SessionExportMessage[] = messages.map((m) => ({
    id: m.id,
    sequenceNumber: m.sequence_number,
    messageType: m.message_type,
    contentEncrypted: m.content_encrypted,
    encryptionNonce: m.encryption_nonce,
    riskLevel: m.risk_level ?? null,
    toolName: m.tool_name ?? null,
    durationMs: m.duration_ms ?? null,
    inputTokens: m.input_tokens ?? 0,
    outputTokens: m.output_tokens ?? 0,
    cacheTokens: m.cache_tokens ?? 0,
    createdAt: m.created_at,
  }));

  const cost: SessionExportCost = {
    totalCostUsd: Number(session.total_cost_usd),
    totalInputTokens: session.total_input_tokens ?? 0,
    totalOutputTokens: session.total_output_tokens ?? 0,
    totalCacheTokens: session.total_cache_tokens ?? 0,
    model: session.model ?? null,
    agentType: session.agent_type,
  };

  return {
    exportVersion: 1,
    exportedAt: new Date().toISOString(),
    generatedBy: 'styrby-web',
    session: metadata,
    messages: exportMessages,
    cost,
    contextBreakdown: contextBreakdown ?? null,
  };
}

/**
 * Trigger a browser file download for the given JSON content.
 *
 * Creates a temporary Blob URL, clicks it, then revokes the URL immediately
 * after to free memory.
 *
 * @param json - Stringified JSON content
 * @param filename - Suggested download filename
 */
function downloadJson(json: string, filename: string): void {
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // WHY: Revoke immediately to avoid memory leaks. The browser retains the
  // underlying data until the link is clicked; after that the URL is unused.
  URL.revokeObjectURL(url);
}

// ============================================================================
// Component
// ============================================================================

/**
 * Download button that exports a session as a portable JSON file.
 *
 * On click it assembles the export payload, serialises it, and triggers a
 * browser download - no network request needed.
 *
 * @param session - Session metadata
 * @param messages - Session messages (encrypted)
 * @param contextBreakdown - Optional context breakdown
 *
 * @example
 * <SessionExportButton session={session} messages={messages} />
 */
export function SessionExportButton({
  session,
  messages,
  contextBreakdown,
}: SessionExportButtonProps) {
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = useCallback(() => {
    setIsExporting(true);
    try {
      const exportData = buildExport(session, messages, contextBreakdown);
      const json = JSON.stringify(exportData, null, 2);
      const dateStr = toDateString(session.started_at ?? session.created_at);
      const filename = `styrby-session-${session.id.slice(0, 8)}-${dateStr}.json`;
      downloadJson(json, filename);
    } finally {
      // Reset after a short delay so the user sees the "Exporting…" state
      setTimeout(() => setIsExporting(false), 600);
    }
  }, [session, messages, contextBreakdown]);

  return (
    <button
      type="button"
      onClick={handleExport}
      disabled={isExporting}
      className="flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-600 hover:bg-zinc-700 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
      aria-label="Export session as JSON"
      title="Download session as JSON"
    >
      {isExporting ? (
        <>
          <svg
            className="h-3.5 w-3.5 animate-spin"
            fill="none"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
          Exporting…
        </>
      ) : (
        <>
          <svg
            className="h-3.5 w-3.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
            />
          </svg>
          Export JSON
        </>
      )}
    </button>
  );
}

export default SessionExportButton;
