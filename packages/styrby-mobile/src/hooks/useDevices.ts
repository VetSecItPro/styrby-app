/**
 * Devices Hook
 *
 * Fetches and manages the list of paired machines (CLI devices) for the
 * authenticated user. Supports pull-to-refresh and delete (unpair) operations.
 *
 * Queries the `machines` table filtered to the current user via Supabase RLS.
 * Machine online/offline status is derived from `is_online` and `last_seen_at`.
 *
 * @module src/hooks/useDevices
 */

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';

// ============================================================================
// Types
// ============================================================================

/**
 * Represents a single paired machine (CLI device) row from Supabase.
 */
export interface MachineRow {
  /** Primary key */
  id: string;
  /** Foreign key to auth.users */
  user_id: string;
  /** Human-readable machine name (e.g., "MacBook Pro Work") */
  name: string;
  /** Platform identifier: 'darwin' | 'linux' | 'win32' | null */
  platform: string | null;
  /** Hostname of the machine (e.g., "macbook.local") */
  hostname: string | null;
  /** Styrby CLI version installed on the machine */
  cli_version: string | null;
  /** Whether the machine is currently online */
  is_online: boolean;
  /** ISO timestamp of the last CLI heartbeat */
  last_seen_at: string | null;
  /** When the machine was first paired */
  created_at: string;
}

/**
 * Return type for the useDevices hook.
 */
export interface UseDevicesReturn {
  /** Array of paired machines, sorted by last_seen_at DESC */
  machines: MachineRow[];
  /** Whether the initial data fetch is in progress */
  isLoading: boolean;
  /** Whether a pull-to-refresh is in progress */
  isRefreshing: boolean;
  /** Error message from the most recent operation, or null */
  error: string | null;
  /** ID of the machine currently being deleted (null if none) */
  deletingId: string | null;
  /** Refresh the machine list from Supabase */
  refresh: () => Promise<void>;
  /** Unpair (delete) a machine by its ID */
  deleteMachine: (machineId: string) => Promise<boolean>;
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook for fetching and managing the user's paired machines.
 *
 * Fetches from the `machines` table (RLS-protected) and provides a
 * `deleteMachine` function that hard-deletes the row and removes it
 * from local state optimistically.
 *
 * @returns Machine list, loading states, and control functions
 *
 * @example
 * const { machines, isLoading, refresh, deleteMachine } = useDevices();
 */
export function useDevices(): UseDevicesReturn {
  const [machines, setMachines] = useState<MachineRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // --------------------------------------------------------------------------
  // Core fetcher
  // --------------------------------------------------------------------------

  /**
   * Fetch all machines for the current user from Supabase.
   *
   * @returns Array of machine rows, ordered by last_seen_at DESC
   * @throws {Error} When the user is not authenticated or the query fails
   */
  const fetchMachines = useCallback(async (): Promise<MachineRow[]> => {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      throw new Error('You must be logged in to view devices.');
    }

    const { data, error: queryError } = await supabase
      .from('machines')
      .select(
        'id, user_id, name, platform, hostname, cli_version, is_online, last_seen_at, created_at',
      )
      .eq('user_id', user.id)
      .order('last_seen_at', { ascending: false, nullsFirst: false });

    if (queryError) {
      throw new Error(queryError.message);
    }

    return (data ?? []) as MachineRow[];
  }, []);

  // --------------------------------------------------------------------------
  // Initial load
  // --------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const rows = await fetchMachines();
        if (!cancelled) setMachines(rows);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load devices');
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [fetchMachines]);

  // --------------------------------------------------------------------------
  // Pull-to-refresh
  // --------------------------------------------------------------------------

  /**
   * Refresh the machine list while showing the pull-to-refresh indicator.
   */
  const refresh = useCallback(async () => {
    setIsRefreshing(true);
    setError(null);

    try {
      const rows = await fetchMachines();
      setMachines(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh devices');
    } finally {
      setIsRefreshing(false);
    }
  }, [fetchMachines]);

  // --------------------------------------------------------------------------
  // Delete (unpair)
  // --------------------------------------------------------------------------

  /**
   * Hard-delete a machine row from Supabase and remove it from local state.
   *
   * Uses optimistic removal: the machine disappears from the list immediately.
   * If the delete fails, the list is re-fetched to restore the true server state.
   *
   * WHY hard delete: Machines do not have a soft-delete column. Unpairing
   * is a clean break — the CLI must re-pair from scratch to reconnect.
   *
   * @param machineId - The Supabase row ID of the machine to unpair
   * @returns true on success, false on failure
   */
  const deleteMachine = useCallback(
    async (machineId: string): Promise<boolean> => {
      // Optimistic removal for instant feedback
      setMachines((prev) => prev.filter((m) => m.id !== machineId));
      setDeletingId(machineId);

      try {
        const { error: deleteError } = await supabase
          .from('machines')
          .delete()
          .eq('id', machineId);

        if (deleteError) {
          // Revert on failure — re-fetch to restore true state
          const rows = await fetchMachines();
          setMachines(rows);
          setError(deleteError.message);
          return false;
        }

        return true;
      } catch (err) {
        // Revert on network error
        const rows = await fetchMachines().catch(() => []);
        setMachines(rows);
        setError(err instanceof Error ? err.message : 'Failed to unpair device');
        return false;
      } finally {
        setDeletingId(null);
      }
    },
    [fetchMachines],
  );

  // --------------------------------------------------------------------------
  // Return
  // --------------------------------------------------------------------------

  return {
    machines,
    isLoading,
    isRefreshing,
    error,
    deletingId,
    refresh,
    deleteMachine,
  };
}
