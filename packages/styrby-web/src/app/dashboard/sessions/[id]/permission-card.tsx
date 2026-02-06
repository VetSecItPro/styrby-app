'use client';

/**
 * Permission card component - displays permission requests with approve/deny.
 *
 * Renders a styled card for permission_request messages that allows
 * the user to approve or deny the requested action. Risk level
 * determines the card's visual styling.
 */

import { useState } from 'react';
import { cn } from '@/lib/utils';

/* ──────────────────────────── Types ──────────────────────────── */

/**
 * Message data for the permission card.
 */
interface PermissionMessage {
  /** Unique message identifier */
  id: string;
  /** Encrypted content describing the permission request */
  content_encrypted: string | null;
  /** Risk level determines visual styling */
  risk_level: 'low' | 'medium' | 'high' | null;
  /** Whether permission has been granted (null = pending) */
  permission_granted: boolean | null;
  /** Tool being requested */
  tool_name: string | null;
  /** Additional metadata (may contain args, request_id) */
  metadata: Record<string, unknown> | null;
}

/**
 * Props for the PermissionCard component.
 */
interface PermissionCardProps {
  /** The permission request message */
  message: PermissionMessage;
  /** Session ID for sending the response */
  sessionId: string;
  /** Whether the card should show action buttons */
  isActive: boolean;
}

/**
 * Status of the permission response action.
 */
type ResponseStatus = 'pending' | 'loading' | 'approved' | 'denied' | 'error';

/* ──────────────────────────── Icons ──────────────────────────── */

function AlertTriangleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
      />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

function LoaderIcon({ className }: { className?: string }) {
  return (
    <svg className={cn('animate-spin', className)} fill="none" viewBox="0 0 24 24">
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
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

/* ──────────────────────────── Component ──────────────────────── */

/**
 * Renders a permission request card with approve/deny actions.
 *
 * WHY: Permission requests are high-stakes actions that need user approval.
 * The visual styling uses color to indicate risk level:
 * - Low (green): Safe operations like reading files
 * - Medium (yellow): Modifications that are reversible
 * - High (red): Dangerous operations like deleting files
 *
 * @param props - PermissionCard configuration
 */
export function PermissionCard({ message, sessionId, isActive }: PermissionCardProps) {
  // Track initial state from message
  const initialStatus: ResponseStatus = message.permission_granted === true
    ? 'approved'
    : message.permission_granted === false
      ? 'denied'
      : 'pending';

  const [status, setStatus] = useState<ResponseStatus>(initialStatus);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const metadata = message.metadata || {};
  const tool = message.tool_name || (metadata.tool as string) || 'Unknown tool';
  const args = (metadata.args as Record<string, unknown>) || {};
  const riskLevel = message.risk_level || 'medium';
  const requestId = (metadata.request_id as string) || message.id;

  /**
   * Sends the permission response to the API.
   *
   * @param approved - Whether the user approved the action
   */
  const handleResponse = async (approved: boolean) => {
    setStatus('loading');
    setErrorMessage(null);

    try {
      const response = await fetch('/api/relay/permission-response', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          requestId,
          approved,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to send response');
      }

      setStatus(approved ? 'approved' : 'denied');
    } catch (error) {
      console.error('Failed to send permission response:', error);
      setStatus('error');
      setErrorMessage(
        error instanceof Error ? error.message : 'Failed to send response'
      );
    }
  };

  /**
   * Returns styling classes based on risk level.
   */
  const getRiskStyles = () => {
    switch (riskLevel) {
      case 'low':
        return 'border-green-500 bg-green-500/10';
      case 'medium':
        return 'border-yellow-500 bg-yellow-500/10';
      case 'high':
        return 'border-red-500 bg-red-500/10';
      default:
        return 'border-yellow-500 bg-yellow-500/10';
    }
  };

  /**
   * Returns icon color based on risk level.
   */
  const getIconColor = () => {
    switch (riskLevel) {
      case 'low':
        return 'text-green-500';
      case 'medium':
        return 'text-yellow-500';
      case 'high':
        return 'text-red-500';
      default:
        return 'text-yellow-500';
    }
  };

  /**
   * Returns human-readable risk label.
   */
  const getRiskLabel = () => {
    switch (riskLevel) {
      case 'low':
        return 'Low Risk';
      case 'medium':
        return 'Medium Risk';
      case 'high':
        return 'High Risk';
      default:
        return 'Unknown Risk';
    }
  };

  // Decrypt content (placeholder for E2E encryption)
  const content = message.content_encrypted || 'Permission request';

  return (
    <div
      className={cn(
        'rounded-lg border-2 p-4',
        getRiskStyles(),
        status === 'approved' && 'opacity-75',
        status === 'denied' && 'opacity-75'
      )}
      role="alert"
      aria-label={`Permission request: ${content}`}
    >
      <div className="flex items-start gap-3">
        {/* Risk indicator icon */}
        <AlertTriangleIcon className={cn('h-5 w-5 mt-0.5 flex-shrink-0', getIconColor())} />

        <div className="flex-1 min-w-0">
          {/* Header */}
          <div className="flex items-center gap-2 mb-1">
            <span className="font-medium text-zinc-100">Permission Request</span>
            <span className={cn('text-xs px-1.5 py-0.5 rounded', getIconColor(), 'bg-current/10')}>
              {getRiskLabel()}
            </span>
          </div>

          {/* Description */}
          <p className="text-sm text-zinc-300 mt-1">{content}</p>

          {/* Tool details */}
          <div className="mt-3 rounded-lg bg-zinc-900 border border-zinc-700 p-3">
            <div className="text-xs text-zinc-400 mb-2">
              <span className="font-medium">Tool:</span> {tool}
            </div>
            {Object.keys(args).length > 0 && (
              <pre className="text-xs text-zinc-300 overflow-x-auto font-mono">
                {JSON.stringify(args, null, 2)}
              </pre>
            )}
          </div>

          {/* Action buttons */}
          {isActive && status === 'pending' && (
            <div className="flex gap-3 mt-4">
              <button
                onClick={() => handleResponse(true)}
                className="flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 transition-colors focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 focus:ring-offset-zinc-900"
                aria-label="Approve this permission request"
              >
                <CheckIcon className="h-4 w-4" />
                Approve
              </button>
              <button
                onClick={() => handleResponse(false)}
                className="flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 transition-colors focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 focus:ring-offset-zinc-900"
                aria-label="Deny this permission request"
              >
                <XIcon className="h-4 w-4" />
                Deny
              </button>
            </div>
          )}

          {/* Loading state */}
          {status === 'loading' && (
            <div className="flex items-center gap-2 mt-4 text-sm text-zinc-400">
              <LoaderIcon className="h-4 w-4" />
              Sending response...
            </div>
          )}

          {/* Approved state */}
          {status === 'approved' && (
            <div className="flex items-center gap-2 mt-4 text-sm text-green-500">
              <CheckIcon className="h-4 w-4" />
              Approved
            </div>
          )}

          {/* Denied state */}
          {status === 'denied' && (
            <div className="flex items-center gap-2 mt-4 text-sm text-red-500">
              <XIcon className="h-4 w-4" />
              Denied
            </div>
          )}

          {/* Error state */}
          {status === 'error' && (
            <div className="mt-4">
              <p className="text-sm text-red-400">{errorMessage}</p>
              <button
                onClick={() => setStatus('pending')}
                className="mt-2 text-sm text-orange-500 hover:text-orange-400 transition-colors"
              >
                Try again
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
