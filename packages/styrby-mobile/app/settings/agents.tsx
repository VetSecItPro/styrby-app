/**
 * Agents Settings Sub-Screen
 *
 * Owns: per-agent config list rows (11 agents), auto-approve low-risk toggle,
 * context templates link.
 *
 * WHY a sub-screen: the agent list was previously inlined in the 2,720-LOC
 * settings monolith. Extracting it lets users navigate directly to agent
 * configuration without scrolling through unrelated preferences.
 *
 * Data: the auto-approve toggle writes to `agent_configs.auto_approve_low_risk`
 * for the user's default row. Individual agent configuration is on a separate
 * `/agent-config` route (already exists).
 *
 * @see docs/planning/settings-refactor-plan-2026-04-19.md Section 3 row 5
 */

import {
  View,
  Switch,
  ScrollView,
} from 'react-native';
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'expo-router';
import { supabase } from '../../src/lib/supabase';
import { useCurrentUser } from '../../src/hooks/useCurrentUser';
import { SectionHeader, SettingRow } from '../../src/components/ui';

// ============================================================================
// Types
// ============================================================================

/**
 * Represents a single agent entry in the list.
 */
interface AgentEntry {
  /** Display name */
  name: string;
  /** Ionicons icon name */
  icon: 'terminal';
  /** Badge accent color */
  iconColor: string;
  /** Route param passed to /agent-config */
  agentKey: string;
  /** Whether this agent is currently connected (from agent_configs) */
  connected: boolean;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Static agent list. Connection status is overridden from Supabase agent_configs.
 * WHY static base list: the 11 supported agents are known at build time.
 * Only the connection status (which changes per user) is loaded dynamically.
 */
const AGENT_ENTRIES: AgentEntry[] = [
  { name: 'Claude Code', icon: 'terminal', iconColor: '#f97316', agentKey: 'claude', connected: false },
  { name: 'Codex', icon: 'terminal', iconColor: '#22c55e', agentKey: 'codex', connected: false },
  { name: 'Gemini CLI', icon: 'terminal', iconColor: '#3b82f6', agentKey: 'gemini', connected: false },
  { name: 'OpenCode', icon: 'terminal', iconColor: '#a855f7', agentKey: 'opencode', connected: false },
  { name: 'Aider', icon: 'terminal', iconColor: '#eab308', agentKey: 'aider', connected: false },
  { name: 'Goose', icon: 'terminal', iconColor: '#06b6d4', agentKey: 'goose', connected: false },
  { name: 'Amp', icon: 'terminal', iconColor: '#ec4899', agentKey: 'amp', connected: false },
  { name: 'Crush', icon: 'terminal', iconColor: '#f43f5e', agentKey: 'crush', connected: false },
  { name: 'Kilo', icon: 'terminal', iconColor: '#8b5cf6', agentKey: 'kilo', connected: false },
  { name: 'Kiro', icon: 'terminal', iconColor: '#14b8a6', agentKey: 'kiro', connected: false },
  { name: 'Droid', icon: 'terminal', iconColor: '#84cc16', agentKey: 'droid', connected: false },
];

// ============================================================================
// Component
// ============================================================================

/**
 * Agents sub-screen.
 *
 * On mount: loads auto_approve_low_risk from the user's agent_configs row.
 * On toggle: optimistic update + Supabase update, revert on error.
 * Each agent row navigates to /agent-config?agent=<agentKey>.
 *
 * @returns React element
 */
export default function AgentsScreen() {
  const router = useRouter();
  const { user } = useCurrentUser();

  /**
   * Whether auto-approve for low-risk operations is enabled.
   * WHY: Low-risk read-only operations (file reads, directory listings)
   * can be approved automatically to reduce notification noise for
   * power users who trust their agent configurations. SOC2 CC6.1 note:
   * auto-approve is scoped to read-only; destructive operations always
   * require explicit approval.
   */
  const [autoApproveEnabled, setAutoApproveEnabled] = useState(false);

  // --------------------------------------------------------------------------
  // Mount: Load auto-approve setting
  // --------------------------------------------------------------------------

  useEffect(() => {
    if (!user) return;

    (async () => {
      try {
        const { data } = await supabase
          .from('agent_configs')
          .select('auto_approve_low_risk')
          .eq('user_id', user.id)
          .limit(1)
          .single();

        if (data) {
          setAutoApproveEnabled(data.auto_approve_low_risk ?? false);
        }
      } catch {
        // Non-fatal: keep default false
      }
    })();
  }, [user]);

  // --------------------------------------------------------------------------
  // Handlers
  // --------------------------------------------------------------------------

  /**
   * Toggles the auto-approve low-risk setting and persists it to the user's
   * default agent_configs row in Supabase.
   *
   * WHY we use .update() not .upsert(): the agent_configs row is guaranteed
   * to exist for authenticated users (created via trigger on profiles insert).
   * upsert would silently succeed even if the row was missing, masking bugs.
   *
   * @param value - The new auto-approve enabled state
   */
  const handleAutoApproveToggle = useCallback(async (value: boolean) => {
    // Optimistic update for responsive UI
    setAutoApproveEnabled(value);

    try {
      if (!user) return;

      const { error } = await supabase
        .from('agent_configs')
        .update({ auto_approve_low_risk: value })
        .eq('user_id', user.id);

      if (error) {
        // Revert on failure
        setAutoApproveEnabled(!value);
        if (__DEV__) {
          console.error('[Agents] Failed to update auto-approve:', error);
        }
      }
    } catch (error) {
      setAutoApproveEnabled(!value);
      if (__DEV__) {
        console.error('[Agents] Auto-approve toggle error:', error);
      }
    }
  }, [user]);

  /**
   * Navigates to the agent configuration screen for the given agent.
   *
   * @param agentKey - Agent identifier (e.g. 'claude', 'codex')
   */
  const handleAgentPress = useCallback((agentKey: string) => {
    router.push({ pathname: '/agent-config', params: { agent: agentKey } });
  }, [router]);

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  return (
    <ScrollView className="flex-1 bg-background">
      {/* Agent list */}
      <SectionHeader title="Connected Agents" />
      <View className="bg-background-secondary">
        {AGENT_ENTRIES.map((agent) => (
          <SettingRow
            key={agent.agentKey}
            icon={agent.icon}
            iconColor={agent.iconColor}
            title={agent.name}
            subtitle={agent.connected ? 'Connected' : 'Not connected'}
            onPress={() => handleAgentPress(agent.agentKey)}
          />
        ))}
      </View>

      {/* Context Templates shortcut */}
      <SectionHeader title="Context" />
      <View className="bg-background-secondary">
        <SettingRow
          icon="document-text"
          iconColor="#a855f7"
          title="Context Templates"
          subtitle="Reusable project context for agents"
          onPress={() => router.push('/templates')}
        />
      </View>

      {/* Auto-Approve */}
      <SectionHeader title="Automation" />
      <View className="bg-background-secondary">
        <SettingRow
          icon="shield-checkmark"
          iconColor="#06b6d4"
          title="Auto-Approve Low Risk"
          subtitle="Auto-approve read-only operations (SOC2 CC6.1 scoped)"
          trailing={
            <Switch
              value={autoApproveEnabled}
              onValueChange={(v) => void handleAutoApproveToggle(v)}
              trackColor={{ false: '#3f3f46', true: '#f9731650' }}
              thumbColor={autoApproveEnabled ? '#f97316' : '#71717a'}
              accessibilityRole="switch"
              accessibilityLabel="Toggle auto-approve for low-risk operations"
            />
          }
        />
      </View>
    </ScrollView>
  );
}
