/**
 * TaskRow — a single cloud-task row with expandable result/error.
 *
 * Extracted from cloud-tasks.tsx (Cluster A2 split). Owns only its own
 * expand/collapse state; all data + the cancel handler come from the parent.
 *
 * @module components/cloud-tasks/TaskRow
 */

import { useState } from 'react';
import type { CloudTask } from '@styrby/shared';
import { AgentBadge } from './AgentBadge';
import { StatusBadge } from './StatusBadge';
import { formatRelativeTime } from './task-format';

/** Props for a single task row. */
export interface TaskRowProps {
  task: CloudTask;
  onCancel?: (id: string) => void;
}

/**
 * Individual cloud task row.
 *
 * @param props - Row props.
 */
export function TaskRow({ task, onCancel }: TaskRowProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const isActive = task.status === 'queued' || task.status === 'running';
  const hasContent = task.result || task.errorMessage;

  return (
    <div className="border border-zinc-800 rounded-lg overflow-hidden">
      {/* Main row */}
      <button
        onClick={() => {
          if (hasContent) setIsExpanded((e) => !e);
        }}
        className={`w-full flex items-start gap-3 p-4 text-left ${hasContent ? 'cursor-pointer hover:bg-zinc-900' : 'cursor-default'}`}
        aria-expanded={hasContent ? isExpanded : undefined}
        aria-label={`Cloud task: ${task.prompt.slice(0, 60)}`}
      >
        {/* Agent badge */}
        <div className="flex-shrink-0 mt-0.5">
          <AgentBadge agentType={task.agentType} />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <p className="text-sm text-zinc-200 leading-5 line-clamp-2">{task.prompt}</p>

          <div className="flex flex-wrap items-center gap-3 mt-2">
            <StatusBadge status={task.status} />

            {task.metadata?.gitBranch && (
              <span className="text-xs text-zinc-400 font-mono">{task.metadata.gitBranch}</span>
            )}

            {task.costUsd !== undefined && task.status === 'completed' && (
              <span className="text-xs font-semibold text-green-400">
                ${task.costUsd.toFixed(4)}
              </span>
            )}

            <span className="text-xs text-zinc-400 ml-auto">
              {formatRelativeTime(task.startedAt)}
            </span>
          </div>

          {/* Running progress bar */}
          {task.status === 'running' && (
            <div className="mt-2 h-1 bg-zinc-800 rounded-full overflow-hidden">
              <div className="h-full bg-blue-500 rounded-full animate-pulse" style={{ width: '60%' }} />
            </div>
          )}
        </div>

        {/* Cancel button for active tasks */}
        {isActive && onCancel && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onCancel(task.id);
            }}
            className="flex-shrink-0 px-2.5 py-1 text-xs font-medium text-red-400 bg-red-500/10 rounded hover:bg-red-500/20 transition-colors"
            aria-label={`Cancel task ${task.id}`}
          >
            Cancel
          </button>
        )}

        {/* Expand indicator */}
        {hasContent && (
          <svg
            className={`flex-shrink-0 w-4 h-4 text-zinc-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        )}
      </button>

      {/* Expandable result / error */}
      {isExpanded && hasContent && (
        <div className="border-t border-zinc-800 p-4 bg-zinc-950">
          {task.result && (
            <pre className="text-sm text-zinc-300 whitespace-pre-wrap font-mono leading-5 max-h-48 overflow-y-auto">
              {task.result}
            </pre>
          )}
          {task.errorMessage && (
            <pre className="text-sm text-red-400 whitespace-pre-wrap font-mono leading-5 max-h-48 overflow-y-auto">
              {task.errorMessage}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
