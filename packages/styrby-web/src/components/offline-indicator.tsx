'use client';

import { useOnlineStatusWithQueue } from '@/hooks/useOnlineStatus';

/**
 * Displays a fixed-position indicator when the user is offline.
 *
 * WHY: Users need clear feedback when they lose connectivity so they
 * understand why real-time updates stopped and that their actions
 * will be queued. This indicator appears in the bottom-right corner
 * and shows how many operations are pending sync.
 *
 * @returns Offline indicator component (null when online with no pending)
 *
 * @example
 * // In root layout:
 * <body>
 *   {children}
 *   <OfflineIndicator />
 * </body>
 */
export function OfflineIndicator() {
  const { isOnline, pendingCount } = useOnlineStatusWithQueue();

  // Don't show if online and nothing pending
  if (isOnline && pendingCount === 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-lg px-4 py-2 shadow-lg transition-all duration-300"
      style={{
        backgroundColor: isOnline ? '#22c55e' : '#eab308',
        color: isOnline ? '#ffffff' : '#000000',
      }}
      role="status"
      aria-live="polite"
    >
      {/* Icon */}
      {isOnline ? (
        // Syncing icon (when online with pending items)
        <svg
          className="h-4 w-4 animate-spin"
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
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          />
        </svg>
      ) : (
        // Offline icon (wifi with slash)
        <svg
          className="h-4 w-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.14 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0"
          />
          <line
            x1="1"
            y1="1"
            x2="23"
            y2="23"
            strokeLinecap="round"
          />
        </svg>
      )}

      {/* Text */}
      <span className="text-sm font-medium">
        {isOnline ? (
          // Online with pending items - syncing
          pendingCount === 1
            ? 'Syncing 1 change...'
            : `Syncing ${pendingCount} changes...`
        ) : (
          // Offline
          <>
            You&apos;re offline
            {pendingCount > 0 && (
              <span className="ml-1 opacity-75">
                ({pendingCount} pending)
              </span>
            )}
          </>
        )}
      </span>
    </div>
  );
}
