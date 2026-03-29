'use client';

import { useState, useCallback, useMemo } from 'react';
import { useRealtimeSubscription } from '@/hooks/useRealtimeSubscription';
import { ConnectionStatus } from '@/components/connection-status';
import { CostTicker } from '@/components/cost-ticker';
import { ActivityGraph } from '@/components/activity-graph';
import { CloudTasksPanel } from '@/components/cloud-tasks';

/* ──────────────────────────── Types ──────────────────────────── */

/**
 * Represents a session from the database.
 */
interface Session {
  /** Unique session identifier */
  id: string;
  /** User-defined session title */
  title: string | null;
  /** Which AI agent was used ('claude' | 'codex' | 'gemini') */
  agent_type: string;
  /** Current session status ('running' | 'idle' | 'ended') */
  status: string;
  /** Cumulative cost in USD */
  total_cost_usd: number;
  /** Number of messages exchanged */
  message_count: number;
  /** ISO 8601 timestamp of session creation */
  created_at: string;
}

/**
 * Represents a cost record from the database.
 */
interface CostRecord {
  /** Unique cost record identifier */
  id: string;
  /** Cost in USD for this record */
  cost_usd: number;
  /** The date portion for grouping */
  record_date: string;
  /** When this record was created */
  created_at: string;
}

/**
 * Represents a machine from the database.
 */
interface Machine {
  /** Unique machine identifier */
  id: string;
  /** Machine name */
  name: string;
  /** Whether the machine is currently online */
  is_online: boolean;
  /** ISO 8601 timestamp of last activity */
  last_seen_at: string;
}

/**
 * Props for the DashboardRealtime component.
 */
interface DashboardRealtimeProps {
  /**
   * Initial sessions fetched from the server during SSR.
   */
  initialSessions: Session[];

  /**
   * Initial today's spend from SSR.
   */
  initialTodaySpend: number;

  /**
   * Initial machines from SSR.
   */
  initialMachines: Machine[];

  /**
   * The authenticated user's ID for filtering real-time updates.
   */
  userId: string;

  /**
   * User's subscription tier. Controls visibility of tier-gated dashboard features:
   * - Activity graph: Pro+
   * - Cloud Tasks panel: Power only
   */
  userTier: 'free' | 'pro' | 'power';
}

/* ──────────────────────────── Component ──────────────────────────── */

/**
 * Client component that provides real-time updates for the dashboard.
 *
 * WHY: The dashboard is the first thing users see after login. It needs to
 * show live updates for:
 * - Active session count (sessions starting/ending)
 * - Today's spend (cost records being added)
 * - Connected machines (machines going online/offline)
 *
 * @param props - Component props including initial data and user ID
 * @returns Dashboard with real-time updates and connection status indicator
 */
export function DashboardRealtime({
  initialSessions,
  initialTodaySpend,
  initialMachines,
  userId,
  userTier,
}: DashboardRealtimeProps) {
  const [sessions, setSessions] = useState(initialSessions);
  const [todaySpend, setTodaySpend] = useState(initialTodaySpend);
  const [machines, setMachines] = useState(initialMachines);

  /* ───────────────── Session handlers ───────────────── */

  const handleSessionInsert = useCallback((newSession: Session) => {
    // Add to the list and keep only recent 5
    setSessions((prev) => [newSession, ...prev].slice(0, 5));
  }, []);

  const handleSessionUpdate = useCallback((updatedSession: Session) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === updatedSession.id ? updatedSession : s))
    );
  }, []);

  const handleSessionDelete = useCallback((deletedSession: Session) => {
    setSessions((prev) => prev.filter((s) => s.id !== deletedSession.id));
  }, []);

  /* ───────────────── Cost handlers ───────────────── */

  const handleCostInsert = useCallback((newCost: CostRecord) => {
    // Only add to today's spend if it's from today
    const today = new Date().toISOString().split('T')[0];
    if (newCost.record_date === today || newCost.created_at.startsWith(today)) {
      const cost = Number(newCost.cost_usd) || 0;
      setTodaySpend((prev) => prev + cost);
    }
  }, []);

  /* ───────────────── Machine handlers ───────────────── */

  const handleMachineInsert = useCallback((newMachine: Machine) => {
    setMachines((prev) => [newMachine, ...prev]);
  }, []);

  const handleMachineUpdate = useCallback((updatedMachine: Machine) => {
    setMachines((prev) =>
      prev.map((m) => (m.id === updatedMachine.id ? updatedMachine : m))
    );
  }, []);

  const handleMachineDelete = useCallback((deletedMachine: Machine) => {
    setMachines((prev) => prev.filter((m) => m.id !== deletedMachine.id));
  }, []);

  /* ───────────────── Subscriptions ───────────────── */

  // Subscribe to sessions
  useRealtimeSubscription<Session>({
    table: 'sessions',
    filter: `user_id=eq.${userId}`,
    onInsert: handleSessionInsert,
    onUpdate: handleSessionUpdate,
    onDelete: handleSessionDelete,
  });

  // Subscribe to cost records
  useRealtimeSubscription<CostRecord>({
    table: 'cost_records',
    filter: `user_id=eq.${userId}`,
    onInsert: handleCostInsert,
  });

  // Subscribe to machines
  useRealtimeSubscription<Machine>({
    table: 'machines',
    filter: `user_id=eq.${userId}`,
    onInsert: handleMachineInsert,
    onUpdate: handleMachineUpdate,
    onDelete: handleMachineDelete,
  });

  // Composite connection status (connected if any subscription is connected)
  // We consider "connected" if the subscriptions are set up (always true after mount)
  const isConnected = true; // Simplified - individual subscription status not exposed currently

  /* ───────────────── Computed values ───────────────── */

  const activeSessionCount = useMemo(() => {
    return sessions.filter((s) => ['running', 'idle'].includes(s.status)).length;
  }, [sessions]);

  const connectedMachineCount = useMemo(() => {
    return machines.filter((m) => m.is_online).length;
  }, [machines]);

  return (
    <>
      {/* WHY: WCAG 2.4.6 requires a descriptive heading. sr-only makes it
          visible only to screen readers without affecting the visual layout. */}
      <h1 className="sr-only">Dashboard</h1>

      {/* Connection status indicator */}
      <div className="flex items-center justify-end mb-4">
        <ConnectionStatus isConnected={isConnected} />
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {/* Today's spend - with real-time ticker */}
        <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
          <p className="text-sm text-zinc-500 mb-1">Today&apos;s Spend</p>
          <CostTicker
            userId={userId}
            initialTotal={todaySpend}
            dateFilter={new Date().toISOString().split('T')[0]}
            className="text-zinc-100"
          />
        </div>

        {/* Active sessions */}
        <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
          <p className="text-sm text-zinc-500">Active Sessions</p>
          <p className="text-2xl font-bold text-zinc-100 mt-1">
            {activeSessionCount}
          </p>
        </div>

        {/* Connected machines */}
        <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
          <p className="text-sm text-zinc-500">Connected Machines</p>
          <p className="text-2xl font-bold text-zinc-100 mt-1">
            {connectedMachineCount}
          </p>
        </div>

        {/* Total machines */}
        <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
          <p className="text-sm text-zinc-500">Total Machines</p>
          <p className="text-2xl font-bold text-zinc-100 mt-1">
            {machines.length}
          </p>
        </div>
      </div>

      {/* Activity Graph - 52-week contribution heatmap - Pro+ only
          WHY: The activity graph is listed as a Pro feature in the TIERS config.
          Free users see a locked upgrade card that teases the feature. */}
      {userTier === 'free' ? (
        <div className="mb-8 rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <svg className="h-5 w-5 text-zinc-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            <div>
              <p className="text-sm font-medium text-zinc-300">Activity Graph</p>
              <p className="text-xs text-zinc-500">52-week coding activity heatmap. Available on Pro.</p>
            </div>
          </div>
          <a
            href="/pricing"
            className="shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-orange-500/10 border border-orange-500/20 px-3 py-1.5 text-xs font-medium text-orange-400 hover:bg-orange-500/20 transition-colors"
          >
            Upgrade to Pro
          </a>
        </div>
      ) : (
        <ActivityGraph className="mb-8" />
      )}

      {/* Recent sessions */}
      <div className="rounded-xl bg-zinc-900 border border-zinc-800">
        <div className="px-4 py-3 border-b border-zinc-800">
          <h2 className="font-semibold text-zinc-100">Recent Sessions</h2>
        </div>

        {sessions && sessions.length > 0 ? (
          <ul className="divide-y divide-zinc-800">
            {sessions.map((session) => (
              <li key={session.id} className="px-4 py-3 hover:bg-zinc-800/50 transition-colors">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {/* Agent badge */}
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        session.agent_type === 'claude'
                          ? 'bg-orange-500/10 text-orange-400'
                          : session.agent_type === 'codex'
                            ? 'bg-green-500/10 text-green-400'
                            : session.agent_type === 'gemini'
                              ? 'bg-blue-500/10 text-blue-400'
                              : session.agent_type === 'opencode'
                                ? 'bg-purple-500/10 text-purple-400'
                                : session.agent_type === 'aider'
                                  ? 'bg-pink-500/10 text-pink-400'
                                  : session.agent_type === 'goose'
                                    ? 'bg-teal-500/10 text-teal-400'
                                    : session.agent_type === 'amp'
                                      ? 'bg-amber-500/10 text-amber-400'
                                      : session.agent_type === 'crush'
                                        ? 'bg-rose-500/10 text-rose-400'
                                        : session.agent_type === 'kilo'
                                          ? 'bg-sky-500/10 text-sky-400'
                                          : session.agent_type === 'kiro'
                                            ? 'bg-orange-500/10 text-orange-400'
                                            : session.agent_type === 'droid'
                                              ? 'bg-slate-500/10 text-slate-400'
                                              : 'bg-zinc-500/10 text-zinc-400'
                      }`}
                    >
                      {session.agent_type}
                    </span>

                    {/* Session title */}
                    <span className="text-zinc-100">
                      {session.title || 'Untitled session'}
                    </span>

                    {/* Status indicator */}
                    <span
                      className={`h-2 w-2 rounded-full ${
                        session.status === 'running'
                          ? 'bg-green-500 animate-pulse'
                          : session.status === 'idle'
                            ? 'bg-yellow-500'
                            : 'bg-zinc-500'
                      }`}
                    />
                  </div>

                  <div className="flex items-center gap-4 text-sm text-zinc-500">
                    <span>{session.message_count} messages</span>
                    <span>${Number(session.total_cost_usd).toFixed(4)}</span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="px-4 py-8 text-center text-zinc-500">
            <p>No sessions yet.</p>
            <p className="mt-1 text-sm">
              Install the CLI and start a session to see it here.
            </p>
          </div>
        )}
      </div>

      {/* Machines list */}
      <div className="mt-8 rounded-xl bg-zinc-900 border border-zinc-800">
        <div className="px-4 py-3 border-b border-zinc-800">
          <h2 className="font-semibold text-zinc-100">Your Machines</h2>
        </div>

        {machines && machines.length > 0 ? (
          <ul className="divide-y divide-zinc-800">
            {machines.map((machine) => (
              <li key={machine.id} className="px-4 py-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span
                      className={`h-2 w-2 rounded-full ${
                        machine.is_online ? 'bg-green-500' : 'bg-zinc-500'
                      }`}
                    />
                    <span className="text-zinc-100">{machine.name}</span>
                  </div>
                  <span className="text-sm text-zinc-500">
                    {machine.is_online
                      ? 'Online'
                      : `Last seen ${new Date(machine.last_seen_at).toLocaleDateString()}`}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="px-4 py-8 text-center text-zinc-500">
            <p>No machines registered.</p>
            <p className="mt-1 text-sm">
              Run <code className="text-orange-500">styrby auth</code> on your development machine to get started.
            </p>
          </div>
        )}
      </div>

      {/* Cloud Tasks Panel - async agent task monitoring - Power tier only
          WHY: Cloud Monitoring is listed as a Power-exclusive feature in the TIERS
          config. Pro users see a locked upgrade card; Free users also see it. */}
      {userTier === 'power' ? (
        <div className="mt-8 rounded-xl bg-zinc-900 border border-zinc-800 p-4">
          <CloudTasksPanel userId={userId} />
        </div>
      ) : (
        <div className="mt-8 rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <svg className="h-5 w-5 text-zinc-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            <div>
              <p className="text-sm font-medium text-zinc-300">Cloud Monitoring</p>
              <p className="text-xs text-zinc-500">Real-time cloud task monitoring. Available on Power.</p>
            </div>
          </div>
          <a
            href="/pricing"
            className="shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-purple-500/10 border border-purple-500/20 px-3 py-1.5 text-xs font-medium text-purple-400 hover:bg-purple-500/20 transition-colors"
          >
            Upgrade to Power
          </a>
        </div>
      )}
    </>
  );
}
