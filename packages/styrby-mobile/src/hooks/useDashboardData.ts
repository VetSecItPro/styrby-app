/**
 * Dashboard Data Hook
 *
 * Centralizes all data fetching for the dashboard screen:
 * - Active sessions from Supabase
 * - Notifications from audit_log
 * - Per-agent cost and online status
 * - Today's total cost
 *
 * Integrates with the relay hook to react to real-time session state changes
 * and presence updates without polling.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import type { ActiveSession } from '../components/SessionCarousel';
import type { Notification, NotificationType } from '../components/NotificationStream';
import type { AgentType, RelayMessage, PresenceState } from 'styrby-shared';

// ============================================================================
// Types
// ============================================================================

/**
 * Per-agent status on the dashboard, including online state and daily cost.
 */
export interface AgentStatus {
  /** Whether the agent has an active session or the CLI reports it online */
  online: boolean;
  /** Total cost in USD for this agent today */
  cost: number;
}

/**
 * Quick stats displayed at the top of the dashboard.
 */
export interface QuickStats {
  /** Total cost in USD across all agents today */
  totalCostToday: number;
  /** Number of agents with at least one active session right now */
  activeAgentCount: number;
}

/**
 * Return type of the useDashboardData hook.
 */
export interface UseDashboardDataReturn {
  /** Active coding sessions for the current user */
  activeSessions: ActiveSession[];
  /** Recent notifications from the audit log */
  notifications: Notification[];
  /** Per-agent online and cost status */
  agentStatus: Record<AgentType, AgentStatus>;
  /** Quick stats for the top cards */
  quickStats: QuickStats;
  /** Whether the initial data load is still in progress */
  isLoading: boolean;
  /** Reload all dashboard data from Supabase */
  refresh: () => Promise<void>;
}

// ============================================================================
// Default Agent Status
// ============================================================================

/**
 * Returns a fresh default agent status map with all agents offline and zero cost.
 *
 * WHY: We need a factory function instead of a constant because each call site
 * should get its own object reference. Using a shared constant would cause
 * stale references when the state is updated via setAgentStatus.
 *
 * @returns Default agent status map
 */
function createDefaultAgentStatus(): Record<AgentType, AgentStatus> {
  return {
    claude: { online: false, cost: 0 },
    codex: { online: false, cost: 0 },
    gemini: { online: false, cost: 0 },
    opencode: { online: false, cost: 0 },
    aider: { online: false, cost: 0 },
  };
}

// ============================================================================
// Supabase Row Types
// ============================================================================

/**
 * Row shape returned by the `sessions` table query.
 * Only the columns we SELECT are listed here.
 */
interface SessionRow {
  id: string;
  agent_type: AgentType;
  title: string | null;
  status: string;
  last_activity_at: string;
  message_count: number;
  total_cost_usd: number;
}

/**
 * Row shape returned by the `audit_log` table query.
 */
interface AuditLogRow {
  id: string;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

/**
 * Row shape returned by the `cost_records` aggregation query.
 */
interface CostRecordRow {
  agent_type: AgentType;
  cost_usd: number;
}

// ============================================================================
// Mapping Helpers
// ============================================================================

/**
 * Maps a database session status string to the UI status expected by SessionCarousel.
 *
 * WHY: The database uses a richer set of statuses (starting, running, idle, paused,
 * stopped, error, expired) but the carousel only shows three: running, idle, and
 * waiting_permission. We collapse the database states into carousel-compatible ones.
 *
 * @param dbStatus - The session status value from the database
 * @returns The carousel-compatible status string
 */
function mapSessionStatus(dbStatus: string): ActiveSession['status'] {
  switch (dbStatus) {
    case 'running':
    case 'starting':
      return 'running';
    case 'idle':
    case 'paused':
      return 'idle';
    default:
      return 'idle';
  }
}

/**
 * Maps a database session row to the ActiveSession shape used by SessionCarousel.
 *
 * @param row - Raw session row from Supabase
 * @returns An ActiveSession object for the carousel
 */
function mapSessionRow(row: SessionRow): ActiveSession {
  return {
    id: row.id,
    agentType: row.agent_type,
    title: row.title || 'Untitled Session',
    status: mapSessionStatus(row.status),
    lastActivity: row.last_activity_at,
    messageCount: row.message_count,
    costUsd: Number(row.total_cost_usd) || 0,
  };
}

/**
 * Maps an audit_log action string to a NotificationType.
 *
 * WHY: The audit_log stores granular action enums (session_created, session_deleted,
 * subscription_changed, etc.) but NotificationStream expects a smaller set of
 * notification types (session_start, session_end, cost_alert, etc.).
 *
 * @param action - The audit action string from the database
 * @returns A NotificationType, or null if the action should not be shown
 */
function mapAuditActionToNotificationType(action: string): NotificationType | null {
  switch (action) {
    case 'session_created':
      return 'session_start';
    case 'session_deleted':
      return 'session_end';
    case 'subscription_changed':
      return 'cost_alert';
    case 'machine_paired':
    case 'machine_removed':
    case 'settings_updated':
      return 'info';
    case 'login':
    case 'logout':
      return 'info';
    default:
      return null;
  }
}

/**
 * Maps an audit action to a human-readable title for notifications.
 *
 * @param action - The audit action string from the database
 * @returns A short, user-facing title string
 */
function mapAuditActionToTitle(action: string): string {
  switch (action) {
    case 'session_created':
      return 'Session Started';
    case 'session_deleted':
      return 'Session Ended';
    case 'subscription_changed':
      return 'Subscription Updated';
    case 'machine_paired':
      return 'Device Paired';
    case 'machine_removed':
      return 'Device Removed';
    case 'settings_updated':
      return 'Settings Changed';
    case 'login':
      return 'Login';
    case 'logout':
      return 'Logout';
    default:
      return action.replace(/_/g, ' ');
  }
}

/**
 * Extracts a notification message from audit log metadata.
 *
 * @param action - The audit action string
 * @param metadata - JSONB metadata from the audit log row
 * @returns A descriptive message string
 */
function extractAuditMessage(action: string, metadata: Record<string, unknown> | null): string {
  if (!metadata) {
    return mapAuditActionToTitle(action);
  }

  if (action === 'session_created' && metadata.agent_type) {
    return `A ${String(metadata.agent_type)} session was started`;
  }
  if (action === 'session_deleted' && metadata.agent_type) {
    return `A ${String(metadata.agent_type)} session ended`;
  }
  if (action === 'subscription_changed' && metadata.new_tier) {
    return `Subscription changed to ${String(metadata.new_tier)}`;
  }
  if (action === 'machine_paired' && metadata.device_name) {
    return `Paired with ${String(metadata.device_name)}`;
  }

  return mapAuditActionToTitle(action);
}

/**
 * Maps an audit_log row to the Notification shape used by NotificationStream.
 *
 * @param row - Raw audit log row from Supabase
 * @returns A Notification object, or null if the action should be filtered out
 */
function mapAuditLogRow(row: AuditLogRow): Notification | null {
  const type = mapAuditActionToNotificationType(row.action);
  if (!type) return null;

  // WHY: audit_log does not store agent_type directly, but the metadata JSONB
  // may contain it. We default to 'claude' because the notification component
  // requires an agentType for the colored dot indicator.
  const agentType = (row.metadata?.agent_type as AgentType) || 'claude';

  return {
    id: row.id,
    type,
    agentType,
    title: mapAuditActionToTitle(row.action),
    message: extractAuditMessage(row.action, row.metadata),
    timestamp: row.created_at,
    read: false,
    actionable: false,
    sessionId: row.resource_type === 'session' && row.resource_id
      ? row.resource_id
      : undefined,
  };
}

// ============================================================================
// Hook
// ============================================================================

/**
 * React hook that fetches and manages all dashboard data.
 *
 * Data sources:
 * - **Active sessions**: `sessions` table, filtered to active statuses
 * - **Notifications**: `audit_log` table, last 24 hours
 * - **Agent costs**: `cost_records` table, today only
 *
 * Real-time updates come from the relay hook's `lastMessage` and
 * `connectedDevices` which are passed in by the dashboard screen.
 *
 * @param lastMessage - The most recent relay message (from useRelay)
 * @param connectedDevices - Currently connected relay devices (from useRelay)
 * @returns Dashboard data, loading state, and refresh function
 *
 * @example
 * const relay = useRelay();
 * const dashboard = useDashboardData(relay.lastMessage, relay.connectedDevices);
 *
 * return (
 *   <SessionCarousel sessions={dashboard.activeSessions} />
 * );
 */
export function useDashboardData(
  lastMessage: RelayMessage | null,
  connectedDevices: PresenceState[]
): UseDashboardDataReturn {
  const [activeSessions, setActiveSessions] = useState<ActiveSession[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [agentStatus, setAgentStatus] = useState<Record<AgentType, AgentStatus>>(
    createDefaultAgentStatus
  );
  const [isLoading, setIsLoading] = useState(true);

  /**
   * WHY: Track the last processed message ID to avoid re-processing the same
   * relay message when the component re-renders for unrelated reasons.
   */
  const lastProcessedMessageIdRef = useRef<string | null>(null);

  // --------------------------------------------------------------------------
  // Data Fetching: Active Sessions
  // --------------------------------------------------------------------------

  /**
   * Fetches active sessions from Supabase for the currently authenticated user.
   * Only returns sessions with status in (starting, running, idle, paused),
   * ordered by most recently updated first.
   *
   * WHY: We use getUser() instead of getSession() to verify the JWT with
   * Supabase Auth server, which is more secure for data-fetching operations.
   *
   * @returns Array of ActiveSession objects for the carousel
   */
  const fetchActiveSessions = useCallback(async (): Promise<ActiveSession[]> => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return [];

    const { data, error } = await supabase
      .from('sessions')
      .select('id, agent_type, title, status, last_activity_at, message_count, total_cost_usd')
      .eq('user_id', user.id)
      .in('status', ['starting', 'running', 'idle', 'paused'])
      .is('deleted_at', null)
      .order('last_activity_at', { ascending: false })
      .limit(10);

    if (error) {
      if (__DEV__) console.error('[Dashboard] Failed to fetch sessions:', error.message);
      return [];
    }

    return (data || []).map((row) => mapSessionRow(row as SessionRow));
  }, []);

  // --------------------------------------------------------------------------
  // Data Fetching: Notifications from Audit Log
  // --------------------------------------------------------------------------

  /**
   * Fetches recent audit log entries and maps them to notifications.
   * Only fetches events from the last 24 hours to keep the feed relevant.
   *
   * @returns Array of Notification objects for the notification stream
   */
  const fetchNotifications = useCallback(async (): Promise<Notification[]> => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return [];

    const twentyFourHoursAgo = new Date();
    twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);

    const { data, error } = await supabase
      .from('audit_log')
      .select('id, action, resource_type, resource_id, metadata, created_at')
      .eq('user_id', user.id)
      .gte('created_at', twentyFourHoursAgo.toISOString())
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) {
      if (__DEV__) console.error('[Dashboard] Failed to fetch audit log:', error.message);
      return [];
    }

    return (data || [])
      .map((row) => mapAuditLogRow(row as AuditLogRow))
      .filter((n): n is Notification => n !== null);
  }, []);

  // --------------------------------------------------------------------------
  // Data Fetching: Per-Agent Cost Today
  // --------------------------------------------------------------------------

  /**
   * Fetches today's cost per agent from the cost_records table.
   * Returns a map of agent type to total cost in USD.
   *
   * @returns Record mapping each agent type to its cost today
   */
  const fetchAgentCostsToday = useCallback(async (): Promise<Record<AgentType, number>> => {
    const { data: { user } } = await supabase.auth.getUser();
    const costs: Record<AgentType, number> = {
      claude: 0,
      codex: 0,
      gemini: 0,
      opencode: 0,
      aider: 0,
    };
    if (!user) return costs;

    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    const { data, error } = await supabase
      .from('cost_records')
      .select('agent_type, cost_usd')
      .eq('user_id', user.id)
      .eq('record_date', todayStr);

    if (error) {
      if (__DEV__) console.error('[Dashboard] Failed to fetch agent costs:', error.message);
      return costs;
    }

    for (const row of (data || []) as CostRecordRow[]) {
      const agent = row.agent_type as AgentType;
      if (agent in costs) {
        costs[agent] += Number(row.cost_usd) || 0;
      }
    }

    return costs;
  }, []);

  // --------------------------------------------------------------------------
  // Combined Refresh
  // --------------------------------------------------------------------------

  /**
   * Fetches all dashboard data in parallel: sessions, notifications, and costs.
   * Updates all state atoms once the promises resolve.
   *
   * WHY: We fetch everything in parallel with Promise.all to minimize total
   * wait time. Each query is independent and can run concurrently.
   */
  const refresh = useCallback(async () => {
    try {
      const [sessions, notifs, costs] = await Promise.all([
        fetchActiveSessions(),
        fetchNotifications(),
        fetchAgentCostsToday(),
      ]);

      setActiveSessions(sessions);
      setNotifications(notifs);

      // Determine which agents are online by checking active sessions
      const onlineAgents = new Set<AgentType>(
        sessions
          .filter((s) => s.status === 'running')
          .map((s) => s.agentType)
      );

      // Also check relay presence for CLI-reported active agents
      for (const device of connectedDevices) {
        if (device.device_type === 'cli' && device.active_agent) {
          onlineAgents.add(device.active_agent);
        }
      }

      const newAgentStatus = createDefaultAgentStatus();
      for (const agent of Object.keys(newAgentStatus) as AgentType[]) {
        newAgentStatus[agent] = {
          online: onlineAgents.has(agent),
          cost: costs[agent] || 0,
        };
      }
      setAgentStatus(newAgentStatus);
    } catch (error) {
      if (__DEV__) console.error('[Dashboard] Refresh failed:', error);
    }
  }, [fetchActiveSessions, fetchNotifications, fetchAgentCostsToday, connectedDevices]);

  // --------------------------------------------------------------------------
  // Initial Load
  // --------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setIsLoading(true);
      await refresh();
      if (!cancelled) {
        setIsLoading(false);
      }
    };

    load();

    return () => {
      cancelled = true;
    };
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps -- only run on mount

  // --------------------------------------------------------------------------
  // Real-Time: Update agent status when relay presence changes
  // --------------------------------------------------------------------------

  /**
   * WHY: connectedDevices from the relay hook changes whenever a CLI device
   * joins or leaves the channel. We update agent online status accordingly
   * without re-fetching from the database.
   */
  useEffect(() => {
    setAgentStatus((prev) => {
      const updated = { ...prev };

      // First, reset all online flags
      for (const agent of Object.keys(updated) as AgentType[]) {
        updated[agent] = { ...updated[agent], online: false };
      }

      // Set online for agents that have active sessions
      for (const session of activeSessions) {
        if (session.status === 'running') {
          const agent = session.agentType;
          if (agent in updated) {
            updated[agent] = { ...updated[agent], online: true };
          }
        }
      }

      // Set online for agents that the CLI reports as active via presence
      for (const device of connectedDevices) {
        if (device.device_type === 'cli' && device.active_agent) {
          const agent = device.active_agent;
          if (agent in updated) {
            updated[agent] = { ...updated[agent], online: true };
          }
        }
      }

      return updated;
    });
  }, [connectedDevices, activeSessions]);

  // --------------------------------------------------------------------------
  // Real-Time: React to relay messages
  // --------------------------------------------------------------------------

  /**
   * Processes incoming relay messages to update dashboard state in real time.
   *
   * WHY: Instead of polling Supabase on a timer, we react to relay messages
   * which arrive instantly. This keeps the dashboard current without adding
   * database load from repeated polling queries.
   *
   * Handled message types:
   * - session_state: Updates an existing session's status or triggers a refresh
   *   if the session is new (not in our current list).
   * - cost_update: Updates the per-agent cost inline without a DB round-trip.
   * - permission_request: Marks a session as waiting_permission with the
   *   pending permission details so the carousel can show the approval UI.
   */
  useEffect(() => {
    if (!lastMessage) return;
    if (lastMessage.id === lastProcessedMessageIdRef.current) return;
    lastProcessedMessageIdRef.current = lastMessage.id;

    switch (lastMessage.type) {
      case 'session_state': {
        const { session_id, agent, state } = lastMessage.payload;

        setActiveSessions((prev) => {
          const existingIndex = prev.findIndex((s) => s.id === session_id);

          if (existingIndex === -1) {
            // WHY: A session_state message arrived for a session not in our list.
            // This means either a new session was created or an old session became
            // active again. Trigger a full refresh to pick it up from the database.
            refresh();
            return prev;
          }

          const updated = [...prev];
          const session = { ...updated[existingIndex] };

          // Map relay state to carousel status
          switch (state) {
            case 'thinking':
            case 'executing':
              session.status = 'running';
              break;
            case 'idle':
              session.status = 'idle';
              break;
            case 'waiting_permission':
              session.status = 'waiting_permission';
              break;
            case 'error':
              // WHY: On error, we remove the session from the active list since
              // it's no longer usable. A full refresh will update the list from DB.
              refresh();
              return prev;
          }

          session.agentType = agent;
          session.lastActivity = new Date().toISOString();
          updated[existingIndex] = session;
          return updated;
        });
        break;
      }

      case 'cost_update': {
        const { agent, session_total_usd, session_id } = lastMessage.payload;

        // Update per-agent cost for today
        setAgentStatus((prev) => {
          if (!(agent in prev)) return prev;
          const updated = { ...prev };
          // WHY: cost_update gives us the session total, but we need the daily
          // total across all sessions. We add the incremental cost_usd to the
          // existing daily total rather than replacing it with session_total_usd.
          updated[agent] = {
            ...updated[agent],
            cost: updated[agent].cost + (lastMessage.payload.cost_usd || 0),
          };
          return updated;
        });

        // Update the matching session's cost in the carousel
        setActiveSessions((prev) =>
          prev.map((s) =>
            s.id === session_id
              ? { ...s, costUsd: Number(session_total_usd) || s.costUsd }
              : s
          )
        );
        break;
      }

      case 'permission_request': {
        const { request_id, session_id, tool_name, description } = lastMessage.payload;

        setActiveSessions((prev) =>
          prev.map((s) =>
            s.id === session_id
              ? {
                  ...s,
                  status: 'waiting_permission' as const,
                  pendingPermission: {
                    requestId: request_id,
                    type: tool_name,
                    description,
                  },
                }
              : s
          )
        );
        break;
      }

      default:
        // Other message types (chat, agent_response, ack, command) are
        // handled by other screens (chat, etc.) and not relevant here.
        break;
    }
  }, [lastMessage, refresh]);

  // --------------------------------------------------------------------------
  // Computed: Quick Stats
  // --------------------------------------------------------------------------

  const quickStats: QuickStats = {
    totalCostToday: Object.values(agentStatus).reduce((sum, a) => sum + a.cost, 0),
    activeAgentCount: Object.values(agentStatus).filter((a) => a.online).length,
  };

  // --------------------------------------------------------------------------
  // Return
  // --------------------------------------------------------------------------

  return {
    activeSessions,
    notifications,
    agentStatus,
    quickStats,
    isLoading,
    refresh,
  };
}
