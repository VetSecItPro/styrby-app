'use client';

import { useState, useCallback } from 'react';
import { useRealtimeSubscription } from '@/hooks/useRealtimeSubscription';
import { cn } from '@/lib/utils';

/* ──────────────────────────── Types ──────────────────────────── */

/**
 * Represents a cost record from the database.
 * Used for real-time cost tracking updates.
 */
interface CostRecord {
  /** Unique cost record identifier */
  id: string;
  /** User who owns this record */
  user_id: string;
  /** Session that incurred this cost */
  session_id: string;
  /** Cost in USD for this record */
  cost_usd: number;
  /** When this record was created */
  created_at: string;
}

/**
 * Props for the CostTicker component.
 */
interface CostTickerProps {
  /**
   * The authenticated user's ID for filtering real-time updates.
   */
  userId: string;

  /**
   * Initial total cost to display (from SSR).
   */
  initialTotal: number;

  /**
   * Additional CSS classes to apply to the container.
   */
  className?: string;

  /**
   * Optional filter for the date to only count costs from a specific period.
   * If provided, only costs from this date onwards are counted in real-time updates.
   * Format: YYYY-MM-DD or ISO 8601 timestamp.
   */
  dateFilter?: string;
}

/* ──────────────────────────── Component ──────────────────────────── */

/**
 * Real-time cost ticker that displays live-updating spending totals.
 *
 * WHY: Users want immediate feedback on their spending during active sessions.
 * This component provides visual feedback when new costs are added:
 * - The total animates with a color change and scale effect
 * - A "+$X.XX" indicator appears briefly to show the added amount
 *
 * @param props - Component props including userId, initialTotal, and optional styling
 * @returns Animated cost display with real-time updates
 *
 * @example
 * <CostTicker
 *   userId={user.id}
 *   initialTotal={45.67}
 *   className="text-3xl"
 * />
 */
export function CostTicker({
  userId,
  initialTotal,
  className,
  dateFilter,
}: CostTickerProps) {
  const [total, setTotal] = useState(initialTotal);
  const [recentCost, setRecentCost] = useState<number | null>(null);
  const [isAnimating, setIsAnimating] = useState(false);

  /**
   * Handles new cost record insertions by updating the total and triggering animation.
   *
   * WHY: We show visual feedback for new costs to give users immediate awareness
   * of spending as it happens. The animation helps draw attention without being disruptive.
   */
  const handleNewCost = useCallback(
    (record: CostRecord) => {
      // If a date filter is provided, check if the record falls within the period
      if (dateFilter) {
        const recordDate = new Date(record.created_at);
        const filterDate = new Date(dateFilter);
        if (recordDate < filterDate) {
          return;
        }
      }

      const cost = Number(record.cost_usd) || 0;
      if (cost <= 0) return;

      setTotal((prev) => prev + cost);
      setRecentCost(cost);
      setIsAnimating(true);

      // Clear animation after 2 seconds
      setTimeout(() => {
        setRecentCost(null);
        setIsAnimating(false);
      }, 2000);
    },
    [dateFilter]
  );

  useRealtimeSubscription<CostRecord>({
    table: 'cost_records',
    filter: `user_id=eq.${userId}`,
    onInsert: handleNewCost,
  });

  /**
   * Formats a cost amount to USD currency string.
   *
   * WHY: Consistent currency formatting improves readability and looks professional.
   * We show up to 4 decimal places for small amounts (typical API costs are sub-cent).
   *
   * @param amount - The cost amount in USD
   * @returns Formatted currency string
   */
  const formatCost = (amount: number): string => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: amount < 0.01 ? 4 : 2,
    }).format(amount);
  };

  return (
    <div className={cn('relative inline-flex items-center gap-2', className)}>
      <span
        className={cn(
          'font-mono text-2xl font-bold transition-all duration-300',
          isAnimating && 'text-green-400 scale-105'
        )}
      >
        {formatCost(total)}
      </span>

      {recentCost !== null && (
        <span
          className={cn(
            'absolute -right-16 rounded bg-green-500/20 px-2 py-0.5 text-sm font-medium text-green-400',
            'animate-fade-in-out'
          )}
        >
          +{formatCost(recentCost)}
        </span>
      )}
    </div>
  );
}
