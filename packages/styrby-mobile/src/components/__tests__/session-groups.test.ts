/**
 * File-content tests for session-groups components (Phase 3.1)
 *
 * Validates structural and security properties of SessionGroupStrip and
 * AgentSessionCard without requiring a React Native runtime.
 *
 * WHY file-content tests (not render tests):
 *   React Native components depend on the Expo/RN runtime unavailable in Node.
 *   File-content tests verify the key contracts: accessibility labels, prop
 *   types, component architecture rules (≤400 LOC, barrel exports, etc.),
 *   and styling conventions (no em-dashes, no sparkle icons per CLAUDE.md).
 *
 * @module components/__tests__/session-groups
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

const COMPONENTS_DIR = resolve(__dirname, '../session-groups');

function read(name: string): string {
  return readFileSync(resolve(COMPONENTS_DIR, name), 'utf-8');
}

// ============================================================================
// AgentSessionCard
// ============================================================================

describe('AgentSessionCard', () => {
  const src = read('AgentSessionCard.tsx');

  it('exports AgentSessionCard as named export', () => {
    expect(src).toContain('export function AgentSessionCard');
  });

  it('exports AgentSessionCardProps interface', () => {
    expect(src).toContain('export interface AgentSessionCardProps');
  });

  it('has JSDoc on the component function', () => {
    expect(src).toContain('* @param props');
  });

  it('includes accessibility role="button"', () => {
    expect(src).toContain('accessibilityRole="button"');
  });

  it('includes accessibilityLabel with agent and status', () => {
    expect(src).toContain('accessibilityLabel');
    expect(src).toContain('agentLabel');
    expect(src).toContain('statusLabel');
  });

  it('includes accessibilityState.selected for active card', () => {
    expect(src).toContain('accessibilityState={{ selected: isActive }}');
  });

  it('handles null total_tokens gracefully (shows --)', () => {
    expect(src).toContain("return '--'");
  });

  it('handles null cost_usd gracefully (shows --)', () => {
    // Both formatCompactCost and formatTokens return '--' for null
    const nullHandlers = src.match(/return '--'/g);
    expect(nullHandlers!.length).toBeGreaterThanOrEqual(2);
  });

  it('does not use em-dashes in UI copy', () => {
    // CLAUDE.md prohibition: never use — in UI text
    expect(src).not.toMatch(/[^-]—[^-]/);
  });

  it('does not import Sparkles icon', () => {
    // CLAUDE.md prohibition
    expect(src.toLowerCase()).not.toContain('sparkles');
  });

  it('does not exceed 400 LOC', () => {
    const lines = src.split('\n').length;
    expect(lines).toBeLessThanOrEqual(400);
  });

  it('shows the active pip only when isActive is true', () => {
    expect(src).toContain('isActive && <View');
    expect(src).toContain('activePip');
  });

  it('calls onPress with session.id when tapped', () => {
    expect(src).toContain('onPress(session.id)');
  });

  it('applies agent color to badge background', () => {
    expect(src).toContain('agentColor');
    expect(src).toContain('agentBadge');
  });
});

// ============================================================================
// SessionGroupStrip
// ============================================================================

describe('SessionGroupStrip', () => {
  const src = read('SessionGroupStrip.tsx');

  it('exports SessionGroupStrip as named export', () => {
    expect(src).toContain('export function SessionGroupStrip');
  });

  it('exports SessionGroupStripProps interface', () => {
    expect(src).toContain('export interface SessionGroupStripProps');
  });

  it('has JSDoc on the component function', () => {
    expect(src).toContain('@param props');
  });

  it('uses FlatList for the card list (virtualized)', () => {
    expect(src).toContain('FlatList');
  });

  it('uses snapToInterval for card-by-card swipe', () => {
    expect(src).toContain('snapToInterval');
  });

  it('includes RefreshControl for pull-to-refresh', () => {
    expect(src).toContain('RefreshControl');
  });

  it('renders a loading skeleton when loading=true and sessions=[]', () => {
    expect(src).toContain('SessionGroupSkeleton');
  });

  it('renders a NoSessionsPlaceholder for empty sessions', () => {
    expect(src).toContain('ListEmptyComponent');
    expect(src).toContain('NoSessionsPlaceholder');
  });

  it('renders an error banner when error is set', () => {
    expect(src).toContain('errorBanner');
    expect(src).toContain('onDismissError');
  });

  it('displays group name in the header', () => {
    expect(src).toContain('group.name');
  });

  it('displays session count badge', () => {
    expect(src).toContain('sessions.length');
    expect(src).toContain('countBadge');
  });

  it('passes isActive correctly (based on active_agent_session_id)', () => {
    expect(src).toContain('group.active_agent_session_id');
    expect(src).toContain('isActive');
  });

  it('calls onFocus with sessionId on card tap', () => {
    expect(src).toContain('onFocus');
  });

  it('uses keyExtractor with session.id', () => {
    expect(src).toContain('item.id');
  });

  it('provides getItemLayout for snap-to-interval math', () => {
    expect(src).toContain('getItemLayout');
  });

  it('includes accessibility label on FlatList', () => {
    expect(src).toContain('accessibilityLabel');
  });

  it('does not use em-dashes in UI copy', () => {
    expect(src).not.toMatch(/[^-]—[^-]/);
  });

  it('does not import Sparkles icon', () => {
    expect(src.toLowerCase()).not.toContain('sparkles');
  });

  it('does not exceed 400 LOC', () => {
    const lines = src.split('\n').length;
    expect(lines).toBeLessThanOrEqual(400);
  });
});

// ============================================================================
// Barrel export (index.ts)
// ============================================================================

describe('session-groups/index.ts barrel', () => {
  const src = read('index.ts');

  it('exports SessionGroupStrip', () => {
    expect(src).toContain("export { SessionGroupStrip }");
  });

  it('exports SessionGroupStripProps type', () => {
    expect(src).toContain("export type { SessionGroupStripProps }");
  });

  it('exports AgentSessionCard', () => {
    expect(src).toContain("export { AgentSessionCard }");
  });

  it('exports AgentSessionCardProps type', () => {
    expect(src).toContain("export type { AgentSessionCardProps }");
  });
});

// ============================================================================
// useSessionGroup hook (file-content checks)
// ============================================================================

describe('useSessionGroup hook (file-content)', () => {
  // __dirname = packages/styrby-mobile/src/components/__tests__
  // ../../hooks = packages/styrby-mobile/src/hooks
  const HOOKS_DIR = resolve(__dirname, '../../hooks');
  const src = readFileSync(resolve(HOOKS_DIR, 'useSessionGroup.ts'), 'utf-8');

  it('exports UseSessionGroupReturn interface', () => {
    expect(src).toContain('export interface UseSessionGroupReturn');
  });

  it('exports GroupSession interface', () => {
    expect(src).toContain('export interface GroupSession');
  });

  it('exports SessionGroup interface', () => {
    expect(src).toContain('export interface SessionGroup');
  });

  it('subscribes to agent_session_groups postgres_changes', () => {
    expect(src).toContain('agent_session_groups');
    expect(src).toContain("event: 'UPDATE'");
  });

  it('subscribes to sessions postgres_changes', () => {
    expect(src).toContain("table: 'sessions'");
    expect(src).toContain("event: '*'");
  });

  it('unsubscribes channels on unmount', () => {
    expect(src).toContain('unsubscribe');
  });

  it('uses optimistic update with revert on error', () => {
    expect(src).toContain('Optimistic update');
    expect(src).toContain('Revert optimistic update on failure');
  });

  it('focus() calls /api/sessions/groups/[groupId]/focus with POST', () => {
    expect(src).toContain('/api/sessions/groups/');
    expect(src).toContain("method: 'POST'");
    expect(src).toContain('sessionId');
  });

  it('has JSDoc on focus function', () => {
    expect(src).toContain('* Focus a session within this group');
  });

  it('does not exceed 400 LOC', () => {
    const lines = src.split('\n').length;
    expect(lines).toBeLessThanOrEqual(400);
  });
});
