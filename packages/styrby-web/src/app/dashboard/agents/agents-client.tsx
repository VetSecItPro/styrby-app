'use client';

import { useState, useMemo } from 'react';
import { Settings, Plus, Wifi, WifiOff, Clock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import Link from 'next/link';

/**
 * Agent type definition matching the Supabase agent_type column.
 */
type AgentType = 'claude' | 'codex' | 'gemini' | 'opencode' | 'aider' | 'goose' | 'amp' | 'crush' | 'kilo' | 'kiro' | 'droid';

/**
 * Formats a timestamp to a human-readable "time ago" string.
 *
 * WHY: Defined at module level (not inside the component) so it is not
 * re-created on every render. Accepts `now` as a parameter so the component
 * can control the reference time from stable state.
 *
 * @param dateStr - ISO 8601 timestamp string, or undefined if never seen
 * @param now - Current time in milliseconds (from Date.now())
 * @returns Human-readable relative time string
 */
function timeAgo(dateStr: string | undefined, now: number): string {
  if (!dateStr) return 'Never';
  const diff = now - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Agent display configuration - brand colors and labels.
 */
const AGENT_META: Record<AgentType, { label: string; color: string }> = {
  claude: { label: 'Claude Code', color: '#F97316' },
  codex: { label: 'Codex', color: '#22C55E' },
  gemini: { label: 'Gemini CLI', color: '#3B82F6' },
  opencode: { label: 'OpenCode', color: '#8B5CF6' },
  aider: { label: 'Aider', color: '#EC4899' },
  goose: { label: 'Goose', color: '#14B8A6' },
  amp: { label: 'Amp', color: '#F59E0B' },
  crush: { label: 'Crush', color: '#F43F5E' },
  kilo: { label: 'Kilo', color: '#0EA5E9' },
  kiro: { label: 'Kiro', color: '#F97316' },
  droid: { label: 'Droid', color: '#64748B' },
};

interface Machine {
  id: string;
  name: string;
  platform: string | null;
  platform_version: string | null;
  hostname: string | null;
  is_online: boolean;
  last_seen_at: string;
}

interface AgentConfig {
  id: string;
  agent_type: string;
  auto_approve_low_risk: boolean;
  blocked_tools: string[];
}

interface CostRecord {
  agent_type: string;
  cost_usd: number;
}

interface Session {
  id: string;
  agent_type: string;
  title: string | null;
  status: string;
  created_at: string;
}

interface AgentsClientProps {
  machines: Machine[];
  agentConfigs: AgentConfig[];
  todayCosts: CostRecord[];
  activeSessions: Session[];
}

/**
 * Client component for the agents page.
 *
 * WHY derive agent data from machines: Rather than hardcoding agent types,
 * we build the agent list from the user's actual machines. This means agents
 * only appear if the user has at least one machine running that agent type.
 * We also show "unconfigured" agents at the bottom for discovery.
 *
 * @param machines - User's registered machines from Supabase
 * @param agentConfigs - Per-agent settings
 * @param todayCosts - Today's cost records for cost-per-agent display
 * @param activeSessions - Currently active sessions for status indicator
 */
export function AgentsClient({ machines, agentConfigs: _agentConfigs, todayCosts, activeSessions }: AgentsClientProps) {
  // Aggregate cost per agent type — memoized to avoid creating a new object on every render
  // WHY: Without useMemo, costByAgent and activeByAgent would be new references each render,
  // which would defeat the downstream useMemo on agentCards.
  const costByAgent = useMemo(() => todayCosts.reduce<Record<string, number>>((acc, r) => {
    acc[r.agent_type] = (acc[r.agent_type] || 0) + Number(r.cost_usd);
    return acc;
  }, {}), [todayCosts]);

  // Count active sessions per agent type
  const activeByAgent = useMemo(() => activeSessions.reduce<Record<string, number>>((acc, s) => {
    acc[s.agent_type] = (acc[s.agent_type] || 0) + 1;
    return acc;
  }, {}), [activeSessions]);

  // Build agent cards data — memoized so it only recomputes when props change.
  // WHY: agentCards derives from machines, costByAgent, and activeByAgent. Without
  // memoization it recomputes on every render even when none of those changed.
  const agentCards = useMemo(() => (Object.keys(AGENT_META) as AgentType[]).map((type) => {
    const meta = AGENT_META[type];
    // WHY: Machines don't have agent_type — agents run in sessions, not machines.
    // Show all machines for each agent type (a machine can run any agent).
    const agentMachines = machines;
    const onlineMachines = agentMachines.filter((m) => m.is_online);
    const isOnline = onlineMachines.length > 0;
    const activeSess = activeByAgent[type] || 0;
    const cost = costByAgent[type] || 0;
    const lastSeen = agentMachines[0]?.last_seen_at;

    return {
      type,
      ...meta,
      isOnline,
      machineCount: agentMachines.length,
      onlineCount: onlineMachines.length,
      activeSessions: activeSess,
      costToday: cost,
      lastSeen,
      machineName: agentMachines[0]?.name || 'No machine connected',
    };
  }), [machines, costByAgent, activeByAgent]);

  // Capture mount time once. timeAgo() is defined at module level and accepts
  // `now` as a parameter — see the function definition above the component.
  const [now] = useState(() => Date.now());

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">Your Agents</h1>
        <Button asChild className="gap-2 bg-amber-500 text-background hover:bg-amber-600">
          <Link href="/dashboard/devices/pair">
            <Plus className="h-4 w-4" />
            Connect Agent
          </Link>
        </Button>
      </div>

      {/* Empty state — no machines connected yet */}
      {machines.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-border/40 bg-card/60 px-6 py-16 text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-amber-500/10 border border-amber-500/20">
            <Plus className="h-7 w-7 text-amber-500" />
          </div>
          <h2 className="text-lg font-semibold text-foreground">No agents connected yet</h2>
          <p className="mt-2 max-w-sm text-sm text-muted-foreground">
            Connect your first AI coding agent to start tracking sessions, costs, and permissions from your dashboard.
          </p>
          <Button asChild className="mt-6 gap-2 bg-amber-500 text-background hover:bg-amber-600">
            <Link href="/dashboard/devices/pair">
              <Plus className="h-4 w-4" />
              Connect an Agent
            </Link>
          </Button>
        </div>
      )}

      {/* Agent cards */}
      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
        {agentCards.map((agent) => (
          <Card
            key={agent.type}
            className="border-border/40 bg-card/60 transition-all duration-200 hover:shadow-lg"
            style={{ borderLeftWidth: '3px', borderLeftColor: agent.color }}
          >
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <div className="flex items-center gap-3">
                <CardTitle className="text-lg font-semibold text-foreground">{agent.label}</CardTitle>
                <Badge
                  variant="secondary"
                  className={cn(
                    'text-xs border-transparent',
                    agent.isOnline
                      ? 'bg-codex/20 text-codex'
                      : 'bg-secondary text-muted-foreground'
                  )}
                >
                  <span
                    className={cn(
                      'mr-1.5 inline-block h-1.5 w-1.5 rounded-full',
                      agent.isOnline ? 'animate-live-pulse bg-codex' : 'bg-muted-foreground'
                    )}
                  />
                  {agent.isOnline ? 'Online' : 'Offline'}
                </Badge>
              </div>
              <Button
                variant="ghost"
                size="icon"
                asChild
                className="text-muted-foreground hover:text-foreground"
              >
                <Link href="/dashboard/settings">
                  <Settings className="h-4 w-4" />
                </Link>
              </Button>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Machine */}
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                {agent.isOnline ? (
                  <Wifi className="h-4 w-4 text-codex" />
                ) : (
                  <WifiOff className="h-4 w-4" />
                )}
                {agent.machineName}
              </div>

              {/* Current session */}
              <div className="rounded-lg bg-secondary/40 p-3">
                <p className="text-xs text-muted-foreground">Active Sessions</p>
                <p className="mt-1 text-sm text-foreground">
                  {agent.activeSessions > 0
                    ? `${agent.activeSessions} session${agent.activeSessions !== 1 ? 's' : ''} running`
                    : 'No active sessions'}
                </p>
              </div>

              {/* Stats */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <p className="text-xs text-muted-foreground">Machines</p>
                  <p className="font-mono text-lg font-bold text-foreground">
                    {agent.onlineCount}/{agent.machineCount}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Cost Today</p>
                  <p className="font-mono text-lg font-bold text-amber-400">
                    ${agent.costToday.toFixed(2)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Sessions</p>
                  <p className="font-mono text-lg font-bold text-foreground">{agent.activeSessions}</p>
                </div>
              </div>

              {/* Last heartbeat */}
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Clock className="h-3 w-3" />
                Last seen: {timeAgo(agent.lastSeen, now)}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Connected Machines */}
      {machines.length > 0 && (
        <Card className="border-border/40 bg-card/60">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base font-semibold text-foreground">Connected Machines</CardTitle>
            <Button
              variant="outline"
              size="sm"
              asChild
              className="gap-2 border-border/60 text-muted-foreground bg-transparent"
            >
              <Link href="/dashboard/devices/pair">
                <Plus className="h-4 w-4" />
                Register Machine
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border/40">
                    <th className="pb-3 text-left text-xs font-medium text-muted-foreground">Machine</th>
                    <th className="pb-3 text-left text-xs font-medium text-muted-foreground">OS</th>
                    <th className="pb-3 text-left text-xs font-medium text-muted-foreground">Last Seen</th>
                    <th className="pb-3 text-left text-xs font-medium text-muted-foreground">Agent</th>
                    <th className="pb-3 text-left text-xs font-medium text-muted-foreground">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {machines.map((machine) => {
                    return (
                      <tr key={machine.id} className="border-b border-border/20">
                        <td className="py-3 text-sm font-medium text-foreground">{machine.name}</td>
                        <td className="py-3 text-sm text-muted-foreground">{machine.platform || 'Unknown'}{machine.hostname ? ` (${machine.hostname})` : ''}</td>
                        <td className="py-3 text-sm text-muted-foreground">{timeAgo(machine.last_seen_at, now)}</td>
                        <td className="py-3 text-sm text-muted-foreground">-</td>
                        <td className="py-3">
                          <Badge
                            variant="secondary"
                            className={cn(
                              'text-xs border-transparent',
                              machine.is_online
                                ? 'bg-codex/20 text-codex'
                                : 'bg-secondary text-muted-foreground'
                            )}
                          >
                            {machine.is_online ? 'Online' : 'Offline'}
                          </Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
