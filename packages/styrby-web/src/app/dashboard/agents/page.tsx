import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { AgentsClient } from './agents-client';

/**
 * Agents page - shows all connected AI agents with their status, machines,
 * and session statistics.
 *
 * WHY server component wrapper: Fetches machines and agent_configs from
 * Supabase for SSR, then passes to the client component for interactive UI
 * (settings buttons, connect agent flow).
 */
export default async function AgentsPage() {
  const supabase = await createClient();

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    redirect('/login');
  }

  // Fetch user's machines with their agent types
  const { data: machines } = await supabase
    .from('machines')
    .select('id, name, agent_type, is_online, last_seen_at, os_info')
    .order('last_seen_at', { ascending: false });

  // Fetch agent configurations
  const { data: agentConfigs } = await supabase
    .from('agent_configs')
    .select('*')
    .eq('user_id', user.id);

  // Fetch today's cost per agent
  const today = new Date().toISOString().split('T')[0];
  const { data: todayCosts } = await supabase
    .from('cost_records')
    .select('agent_type, cost_usd')
    .gte('record_date', today);

  // Fetch active sessions
  const { data: activeSessions } = await supabase
    .from('sessions')
    .select('id, agent_type, title, status, created_at')
    .eq('status', 'active');

  return (
    <AgentsClient
      machines={machines || []}
      agentConfigs={agentConfigs || []}
      todayCosts={todayCosts || []}
      activeSessions={activeSessions || []}
    />
  );
}
