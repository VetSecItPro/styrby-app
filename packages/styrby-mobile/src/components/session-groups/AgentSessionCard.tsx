/**
 * AgentSessionCard
 *
 * A single agent session card displayed inside the SessionGroupStrip.
 * Shows the agent badge, status indicator, truncated project path,
 * token count, and cost. Highlights the active (focused) card with a
 * border accent.
 *
 * Tapping the card calls onPress, which triggers the focus action in
 * the parent strip (POST /api/sessions/groups/[groupId]/focus).
 *
 * WHY a standalone component (not inline in SessionGroupStrip):
 *   Component-first architecture (CLAUDE.md). The card is independently
 *   testable, the strip stays focused on layout + scroll logic, and
 *   future changes to the card design (adding checkboxes, swipe actions)
 *   don't touch the strip.
 *
 * @module components/session-groups/AgentSessionCard
 */

import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import type { GroupSession } from '../../hooks/useSessionGroup';

// ============================================================================
// Types
// ============================================================================

export interface AgentSessionCardProps {
  /** The session data to render */
  session: GroupSession;
  /**
   * Whether this card represents the currently focused session.
   * If true, a colored left-border accent is shown.
   */
  isActive: boolean;
  /** Called when the user taps the card */
  onPress: (sessionId: string) => void;
  /** Visual color associated with this agent (used for badge + accent) */
  agentColor: string;
  /** Short single-letter icon shown in the agent badge */
  agentIcon: string;
  /** Human-readable agent label (e.g. "Claude", "Codex") */
  agentLabel: string;
}

// ============================================================================
// Status config
// ============================================================================

/**
 * Maps session status to a display colour for the dot indicator.
 */
const STATUS_DOT_COLORS: Record<string, string> = {
  starting: '#22c55e',
  running: '#22c55e',
  idle: '#eab308',
  paused: '#eab308',
  stopped: '#71717a',
  error: '#ef4444',
  expired: '#71717a',
};

/**
 * Maps session status to a human-readable label for the badge.
 */
const STATUS_LABELS: Record<string, string> = {
  starting: 'Starting',
  running: 'Running',
  idle: 'Idle',
  paused: 'Paused',
  stopped: 'Done',
  error: 'Error',
  expired: 'Expired',
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Format a USD cost value for compact display.
 * e.g. 0.0031 → "$0.003"  |  1.25 → "$1.25"
 *
 * @param usd - Cost in US dollars, or null if not yet computed
 * @returns Formatted string or "--" if null
 */
function formatCompactCost(usd: number | null): string {
  if (usd === null || usd === undefined) return '--';
  if (usd < 0.001) return '<$0.001';
  return `$${usd.toFixed(3)}`;
}

/**
 * Format a token count for compact display.
 * e.g. 12345 → "12.3k"  |  800 → "800"
 *
 * @param tokens - Token count, or null if not yet computed
 * @returns Formatted string or "--" if null
 */
function formatTokens(tokens: number | null): string {
  if (tokens === null || tokens === undefined) return '--';
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

/**
 * Truncate a file path to the last two path segments for compact display.
 * e.g. "/Users/dev/projects/my-app" → "projects/my-app"
 *
 * @param path - Absolute or relative file path
 * @returns Last two segments or the original string if short
 */
function truncatePath(path: string | null): string {
  if (!path) return 'unknown project';
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join('/')}`;
}

// ============================================================================
// Component
// ============================================================================

/**
 * Single agent card in the SessionGroupStrip.
 *
 * @param props - AgentSessionCardProps
 */
export function AgentSessionCard({
  session,
  isActive,
  onPress,
  agentColor,
  agentIcon,
  agentLabel,
}: AgentSessionCardProps) {
  const statusDotColor = STATUS_DOT_COLORS[session.status] ?? '#71717a';
  const statusLabel = STATUS_LABELS[session.status] ?? session.status;

  return (
    <Pressable
      onPress={() => onPress(session.id)}
      style={({ pressed }) => [
        styles.card,
        isActive && styles.cardActive,
        isActive && { borderColor: agentColor },
        pressed && styles.cardPressed,
      ]}
      accessibilityRole="button"
      accessibilityLabel={`${agentLabel} session, ${statusLabel}. Tap to focus.`}
      accessibilityState={{ selected: isActive }}
    >
      {/* Agent badge */}
      <View style={[styles.agentBadge, { backgroundColor: agentColor + '22' }]}>
        <Text style={[styles.agentBadgeText, { color: agentColor }]}>{agentIcon}</Text>
      </View>

      {/* Content */}
      <View style={styles.content}>
        {/* Top row: agent label + status dot */}
        <View style={styles.topRow}>
          <Text style={styles.agentLabel} numberOfLines={1}>
            {agentLabel}
          </Text>
          <View style={styles.statusRow}>
            <View style={[styles.statusDot, { backgroundColor: statusDotColor }]} />
            <Text style={styles.statusText}>{statusLabel}</Text>
          </View>
        </View>

        {/* Project path */}
        <Text style={styles.projectPath} numberOfLines={1}>
          {truncatePath(session.project_path)}
        </Text>

        {/* Bottom row: token count + cost */}
        <View style={styles.bottomRow}>
          <Text style={styles.metaText}>{formatTokens(session.total_tokens)} tok</Text>
          <Text style={styles.metaSeparator}>·</Text>
          <Text style={styles.metaText}>{formatCompactCost(session.cost_usd)}</Text>
        </View>
      </View>

      {/* Active indicator dot (right side) */}
      {isActive && <View style={[styles.activePip, { backgroundColor: agentColor }]} />}
    </Pressable>
  );
}

// ============================================================================
// Styles
// ============================================================================

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: '#18181b',
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: '#27272a',
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginRight: 10,
    width: 180,
    minHeight: 90,
    position: 'relative',
  },
  cardActive: {
    borderWidth: 2,
    backgroundColor: '#1c1917',
  },
  cardPressed: {
    opacity: 0.75,
  },
  agentBadge: {
    width: 32,
    height: 32,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 10,
    marginTop: 1,
    flexShrink: 0,
  },
  agentBadgeText: {
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  content: {
    flex: 1,
    gap: 3,
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 4,
  },
  agentLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#f4f4f5',
    flex: 1,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    flexShrink: 0,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusText: {
    fontSize: 10,
    color: '#a1a1aa',
  },
  projectPath: {
    fontSize: 11,
    color: '#71717a',
    marginTop: 1,
  },
  bottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 2,
  },
  metaText: {
    fontSize: 11,
    color: '#52525b',
  },
  metaSeparator: {
    fontSize: 11,
    color: '#3f3f46',
  },
  activePip: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});
