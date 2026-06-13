/**
 * Shared types for the web cloud-tasks panel.
 *
 * Extracted from cloud-tasks.tsx (Cluster A2 split).
 *
 * @module components/cloud-tasks/types
 */

/** Props for the CloudTasksPanel component. */
export interface CloudTasksPanelProps {
  /**
   * The authenticated user's Supabase ID.
   * Used to scope the query and real-time subscription.
   */
  userId: string;
}
