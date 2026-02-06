'use client';

import { useState } from 'react';
import { Settings, Plus, Wifi, WifiOff, Clock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import Link from 'next/link';

/**
 * Agent type definition matching the Supabase agent_type column.
 */
type AgentType = 'claude' | 'codex' | 'gemini' | 'opencode' | 'aider';

/**
 * Agent display configuration - brand colors and labels.
 */
const AGENT_META: Record<AgentType, { label: string; color: string }> = {
  claude: { label: 'Claude Code', color: '#F97316' },
  codex: { label: 'Codex', color: '#22C55E' },
  gemini: { label: 'Gemini CLI', color: '#3B82F6' },
  opencode: { label: 'OpenCode', color: '#06B6D4' },
  aider: { label: 'Aider', color: '#8B5CF6' },
};

interface Machine {
  id: string;
  name: string;
  agent_type: string;
  is_online: boolean;
  last_seen_at: string;
  os_info: string | null;
}

interface AgentConfig {
  id: string;
  agent_type: string;
  auto_approve_reads: boolean;
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
  // Aggregate cost per agent type
  const costByAgent = todayCosts.reduce<Record<string, number>>((acc, r) => {
    acc[r.agent_type] = (acc[r.agent_type] || 0) + Number(r.cost_usd);
    return acc;
  }, {});

  // Count active sessions per agent type
  const activeByAgent = activeSessions.reduce<Record<string, number>>((acc, s) => {
    acc[s.agent_type] = (acc[s.agent_type] || 0) + 1;
    return acc;
  }, {});

  // Build agent cards data
  const agentCards = (Object.keys(AGENT_META) as AgentType[]).map((type) => {
    const meta = AGENT_META[type];
    const agentMachines = machines.filter((m) => m.agent_type === type);
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
  });

  /**
   * Formats a timestamp to a human-readable "time ago" string.
   */
  const [now] = useState(() => Date.now());

  function timeAgo(dateStr: string | undefined): string {
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
              <div className="grid grid-cols-3 gap-3">
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
                Last seen: {timeAgo(agent.lastSeen)}
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
                    const agentType = machine.agent_type as AgentType;
                    const meta = AGENT_META[agentType];
                    return (
                      <tr key={machine.id} className="border-b border-border/20">
                        <td className="py-3 text-sm font-medium text-foreground">{machine.name}</td>
                        <td className="py-3 text-sm text-muted-foreground">{machine.os_info || 'Unknown'}</td>
                        <td className="py-3 text-sm text-muted-foreground">{timeAgo(machine.last_seen_at)}</td>
                        <td className="py-3 text-sm text-muted-foreground">{meta?.label || machine.agent_type}</td>
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
