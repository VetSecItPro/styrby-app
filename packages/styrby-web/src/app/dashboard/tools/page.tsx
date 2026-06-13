/**
 * MCP Tools Registry Page
 *
 * Shows the user the catalog of MCP (Model Context Protocol) tools that
 * Styrby's CLI MCP server exposes to MCP-aware coding agents (Claude Code,
 * Codex, Cursor, etc.).
 *
 * ## Why a registry page
 *
 * MCP is opaque to non-technical users. They wire up Styrby in their
 * agent's config and have no visibility into what tools the agent can
 * call. This page makes that surface explicit:
 *   - Which tools exist today (GA)
 *   - Which are coming (planned)
 *   - What each one does in plain language
 *   - The exact .mcp.json snippet to wire it up
 *
 * Phase 4 will expand this into a full MCP marketplace where users can
 * install and authorize third-party MCP servers (modelcontextprotocol/registry).
 *
 * @module app/dashboard/tools/page
 */

import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { ToolsRegistry } from './tools-registry';
import { computeMcpReadiness } from './mcp-readiness';

export const metadata: Metadata = {
  title: 'MCP Tools | Styrby',
  description:
    'Catalog of Model Context Protocol tools Styrby exposes to MCP-aware coding agents. Wire Styrby into Claude Code, Codex, Cursor, and more.',
};

/**
 * MCP Tools page (server component).
 *
 * Computes the user's MCP connection readiness from their account state
 * (machines, push devices, team membership) so the registry can show whether
 * the wired-up snippet will actually work, then delegates rendering to the
 * client {@link ToolsRegistry}.
 */
export default async function ToolsPage() {
  const supabase = await createClient();

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    redirect('/login');
  }

  // Readiness inputs. The machines RLS policy scopes rows to the current user
  // automatically; team_members + device_tokens are filtered by user_id.
  const [machinesResult, devicesResult, teamResult] = await Promise.all([
    supabase.from('machines').select('id, is_online'),
    supabase.from('device_tokens').select('id').eq('user_id', user.id).eq('is_active', true),
    supabase.from('team_members').select('team_id').eq('user_id', user.id).limit(1).maybeSingle(),
  ]);

  const machines = machinesResult.data ?? [];
  const readiness = computeMcpReadiness({
    machineCount: machines.length,
    hasOnlineMachine: machines.some((m) => m.is_online === true),
    deviceTokenCount: devicesResult.data?.length ?? 0,
    hasTeam: Boolean(teamResult.data?.team_id),
  });

  return <ToolsRegistry readiness={readiness} />;
}
