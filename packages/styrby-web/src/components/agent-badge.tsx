/**
 * Agent Badge Component
 *
 * Displays a styled badge for AI coding agents with consistent branding.
 * Supports size variants and uses colors from the shared design system.
 *
 * @module components/agent-badge
 */

import { cn } from '@/lib/utils';
import { type AgentType } from '@/lib/costs';

// ============================================================================
// Types
// ============================================================================

/**
 * Size variants for the agent badge.
 */
export type AgentBadgeSize = 'sm' | 'md' | 'lg';

/**
 * Props for the AgentBadge component.
 */
export interface AgentBadgeProps {
  /** The type of agent to display */
  agent: AgentType;
  /** Size variant for the badge (default: 'md') */
  size?: AgentBadgeSize;
  /** Whether to show the full agent name or just the initial (default: true) */
  showLabel?: boolean;
  /** Optional additional CSS classes */
  className?: string;
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Agent display configuration with colors and labels.
 *
 * Colors match the shared design system in styrby-shared/src/design/colors.ts
 */
const AGENT_CONFIG: Record<
  AgentType,
  {
    name: string;
    color: string;
    bgColor: string;
    textColor: string;
  }
> = {
  claude: {
    name: 'Claude',
    color: '#f97316', // orange-500
    bgColor: 'bg-orange-500/10',
    textColor: 'text-orange-400',
  },
  codex: {
    name: 'Codex',
    color: '#22c55e', // green-500
    bgColor: 'bg-green-500/10',
    textColor: 'text-green-400',
  },
  gemini: {
    name: 'Gemini',
    color: '#3b82f6', // blue-500
    bgColor: 'bg-blue-500/10',
    textColor: 'text-blue-400',
  },
  opencode: {
    name: 'OpenCode',
    color: '#8b5cf6', // violet-500
    bgColor: 'bg-purple-500/10',
    textColor: 'text-purple-400',
  },
  aider: {
    name: 'Aider',
    color: '#ec4899', // pink-500
    bgColor: 'bg-pink-500/10',
    textColor: 'text-pink-400',
  },
};

/**
 * Size-specific styling for the badge.
 */
const SIZE_STYLES: Record<AgentBadgeSize, { badge: string; icon: string; text: string }> = {
  sm: {
    badge: 'px-1.5 py-0.5 gap-1',
    icon: 'w-4 h-4 text-[10px]',
    text: 'text-xs',
  },
  md: {
    badge: 'px-2 py-0.5 gap-1.5',
    icon: 'w-5 h-5 text-xs',
    text: 'text-sm',
  },
  lg: {
    badge: 'px-3 py-1 gap-2',
    icon: 'w-6 h-6 text-sm',
    text: 'text-base',
  },
};

// ============================================================================
// Component
// ============================================================================

/**
 * Displays a styled badge for an AI coding agent.
 *
 * WHY: Consistent agent branding across the dashboard helps users quickly
 * identify which agent was used for sessions, costs, and analytics.
 *
 * @param props - Component props
 * @returns Styled agent badge element
 *
 * @example
 * // Basic usage
 * <AgentBadge agent="claude" />
 *
 * @example
 * // Small badge without label
 * <AgentBadge agent="codex" size="sm" showLabel={false} />
 *
 * @example
 * // Large badge with custom class
 * <AgentBadge agent="gemini" size="lg" className="my-2" />
 */
export function AgentBadge({
  agent,
  size = 'md',
  showLabel = true,
  className,
}: AgentBadgeProps) {
  const config = AGENT_CONFIG[agent] ?? AGENT_CONFIG.claude;
  const sizeStyle = SIZE_STYLES[size];

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full font-medium',
        config.bgColor,
        config.textColor,
        sizeStyle.badge,
        className
      )}
    >
      {/* Icon circle with agent initial */}
      <span
        className={cn(
          'inline-flex items-center justify-center rounded-full font-bold text-white',
          sizeStyle.icon
        )}
        style={{ backgroundColor: config.color }}
        aria-hidden="true"
      >
        {config.name[0]}
      </span>

      {/* Agent name label */}
      {showLabel && (
        <span className={cn('font-medium capitalize', sizeStyle.text)}>
          {config.name}
        </span>
      )}
    </span>
  );
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get the Tailwind CSS classes for an agent badge.
 *
 * Useful when you need to style other elements with agent colors.
 *
 * @param agent - Agent type
 * @returns Object with bgColor and textColor Tailwind classes
 *
 * @example
 * const { bgColor, textColor } = getAgentBadgeClasses('claude');
 * <div className={`${bgColor} ${textColor}`}>Claude session</div>
 */
export function getAgentBadgeClasses(agent: AgentType): {
  bgColor: string;
  textColor: string;
  color: string;
} {
  const config = AGENT_CONFIG[agent] ?? AGENT_CONFIG.claude;
  return {
    bgColor: config.bgColor,
    textColor: config.textColor,
    color: config.color,
  };
}

/**
 * Get the display name for an agent type.
 *
 * @param agent - Agent type
 * @returns Human-readable agent name
 *
 * @example
 * getAgentDisplayName('opencode') // "OpenCode"
 */
export function getAgentDisplayName(agent: AgentType): string {
  return AGENT_CONFIG[agent]?.name ?? agent;
}
