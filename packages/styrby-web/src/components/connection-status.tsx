'use client';

import { cn } from '@/lib/utils';

/**
 * Props for the ConnectionStatus component.
 */
interface ConnectionStatusProps {
  /**
   * Whether the WebSocket connection is currently active.
   */
  isConnected: boolean;

  /**
   * Optional additional CSS classes to apply to the container.
   */
  className?: string;
}

/**
 * Displays a visual indicator of the real-time connection status.
 *
 * WHY: Users need visual feedback that their dashboard is receiving live updates.
 * This component shows a green "Live" indicator when connected, or a pulsing
 * "Connecting..." state when establishing the WebSocket connection.
 *
 * @param props - Component props
 * @returns A connection status badge with colored indicator dot
 *
 * @example
 * <ConnectionStatus isConnected={isConnected} className="absolute top-2 right-2" />
 */
export function ConnectionStatus({ isConnected, className }: ConnectionStatusProps) {
  return (
    <div className={cn('flex items-center gap-2 text-sm', className)}>
      <span
        className={cn(
          'h-2 w-2 rounded-full',
          isConnected ? 'bg-green-500' : 'bg-yellow-500 animate-pulse'
        )}
        aria-hidden="true"
      />
      <span className="text-muted-foreground text-zinc-400">
        {isConnected ? 'Live' : 'Connecting...'}
      </span>
    </div>
  );
}
