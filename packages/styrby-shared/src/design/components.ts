/**
 * Styrby Design System - Component Specifications
 *
 * Defines consistent styling for core UI components.
 * These specs should be implemented in both web and mobile.
 */

import { brand, background, border, status, agent, riskLevel } from './colors.js';

// ============================================================================
// Spacing Scale
// ============================================================================

export const spacing = {
  /** 0px */
  0: 0,
  /** 4px */
  1: 4,
  /** 8px */
  2: 8,
  /** 12px */
  3: 12,
  /** 16px */
  4: 16,
  /** 20px */
  5: 20,
  /** 24px */
  6: 24,
  /** 32px */
  8: 32,
  /** 40px */
  10: 40,
  /** 48px */
  12: 48,
  /** 64px */
  16: 64,
} as const;

// ============================================================================
// Border Radius
// ============================================================================

export const borderRadius = {
  /** No radius */
  none: 0,
  /** Small - 4px */
  sm: 4,
  /** Medium - 8px */
  md: 8,
  /** Large - 12px */
  lg: 12,
  /** Extra large - 16px */
  xl: 16,
  /** 2XL - 24px */
  '2xl': 24,
  /** Full (pill shape) */
  full: 9999,
} as const;

// ============================================================================
// Shadows
// ============================================================================

export const shadow = {
  /** No shadow */
  none: 'none',
  /** Small shadow - for cards */
  sm: '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
  /** Default shadow */
  DEFAULT: '0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px -1px rgba(0, 0, 0, 0.1)',
  /** Medium shadow - for dropdowns */
  md: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1)',
  /** Large shadow - for modals */
  lg: '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -4px rgba(0, 0, 0, 0.1)',
  /** Extra large shadow */
  xl: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)',
} as const;

// ============================================================================
// Button Component
// ============================================================================

export const button = {
  /** Button sizes */
  size: {
    sm: {
      height: 32,
      paddingX: spacing[3],
      fontSize: 14,
      iconSize: 16,
    },
    md: {
      height: 40,
      paddingX: spacing[4],
      fontSize: 14,
      iconSize: 18,
    },
    lg: {
      height: 48,
      paddingX: spacing[6],
      fontSize: 16,
      iconSize: 20,
    },
  },
  /** Button variants */
  variant: {
    primary: {
      background: brand.DEFAULT,
      backgroundHover: brand.dark,
      text: '#ffffff',
      border: 'transparent',
    },
    secondary: {
      background: background.secondary,
      backgroundHover: background.tertiary,
      text: '#ffffff',
      border: border.DEFAULT,
    },
    ghost: {
      background: 'transparent',
      backgroundHover: background.hover,
      text: '#ffffff',
      border: 'transparent',
    },
    danger: {
      background: status.error.DEFAULT,
      backgroundHover: '#dc2626',
      text: '#ffffff',
      border: 'transparent',
    },
  },
  /** Common button properties */
  common: {
    borderRadius: borderRadius.lg,
    fontWeight: '600',
    transition: 'all 150ms ease',
  },
} as const;

// ============================================================================
// Card Component
// ============================================================================

export const card = {
  /** Card variants */
  variant: {
    default: {
      background: background.secondary,
      border: border.DEFAULT,
      borderRadius: borderRadius.xl,
    },
    elevated: {
      background: background.elevated,
      border: 'transparent',
      borderRadius: borderRadius.xl,
      shadow: shadow.md,
    },
    outline: {
      background: 'transparent',
      border: border.DEFAULT,
      borderRadius: borderRadius.xl,
    },
  },
  /** Card padding */
  padding: {
    sm: spacing[3],
    md: spacing[4],
    lg: spacing[6],
  },
} as const;

// ============================================================================
// Badge Component
// ============================================================================

export const badge = {
  /** Badge sizes */
  size: {
    sm: {
      height: 20,
      paddingX: spacing[2],
      fontSize: 11,
    },
    md: {
      height: 24,
      paddingX: spacing[3],
      fontSize: 12,
    },
  },
  /** Badge variants based on agent */
  agent: {
    claude: {
      background: agent.claude.subtle,
      text: agent.claude.DEFAULT,
      border: agent.claude.border,
    },
    codex: {
      background: agent.codex.subtle,
      text: agent.codex.DEFAULT,
      border: agent.codex.border,
    },
    gemini: {
      background: agent.gemini.subtle,
      text: agent.gemini.DEFAULT,
      border: agent.gemini.border,
    },
  },
  /** Badge variants based on status */
  status: {
    success: {
      background: status.success.subtle,
      text: status.success.DEFAULT,
      border: status.success.border,
    },
    warning: {
      background: status.warning.subtle,
      text: status.warning.DEFAULT,
      border: status.warning.border,
    },
    error: {
      background: status.error.subtle,
      text: status.error.DEFAULT,
      border: status.error.border,
    },
    info: {
      background: status.info.subtle,
      text: status.info.DEFAULT,
      border: status.info.border,
    },
  },
  /** Common badge properties */
  common: {
    borderRadius: borderRadius.md,
    fontWeight: '500',
  },
} as const;

// ============================================================================
// Status Indicator Component
// ============================================================================

export const statusIndicator = {
  /** Indicator sizes */
  size: {
    sm: 8,
    md: 10,
    lg: 12,
  },
  /** Indicator states */
  state: {
    online: {
      color: status.success.DEFAULT,
      pulse: true,
    },
    offline: {
      color: '#52525b', // zinc-600
      pulse: false,
    },
    busy: {
      color: status.warning.DEFAULT,
      pulse: true,
    },
    error: {
      color: status.error.DEFAULT,
      pulse: false,
    },
  },
} as const;

// ============================================================================
// Risk Level Badge
// ============================================================================

export const riskBadge = {
  low: {
    background: riskLevel.low.subtle,
    text: riskLevel.low.text,
    icon: 'shield-checkmark',
  },
  medium: {
    background: riskLevel.medium.subtle,
    text: riskLevel.medium.text,
    icon: 'warning',
  },
  high: {
    background: riskLevel.high.subtle,
    text: riskLevel.high.text,
    icon: 'alert-circle',
  },
  critical: {
    background: riskLevel.critical.subtle,
    text: riskLevel.critical.text,
    icon: 'skull',
  },
} as const;

// ============================================================================
// Input Component
// ============================================================================

export const input = {
  /** Input sizes */
  size: {
    sm: {
      height: 32,
      paddingX: spacing[3],
      fontSize: 14,
    },
    md: {
      height: 40,
      paddingX: spacing[4],
      fontSize: 14,
    },
    lg: {
      height: 48,
      paddingX: spacing[4],
      fontSize: 16,
    },
  },
  /** Input states */
  state: {
    default: {
      background: background.secondary,
      border: border.DEFAULT,
      text: '#ffffff',
      placeholder: '#71717a', // zinc-500
    },
    focus: {
      border: brand.DEFAULT,
      ring: `0 0 0 2px ${brand.subtle}`,
    },
    error: {
      border: status.error.DEFAULT,
      ring: `0 0 0 2px ${status.error.subtle}`,
    },
    disabled: {
      background: background.tertiary,
      text: '#52525b', // zinc-600
      cursor: 'not-allowed',
    },
  },
  /** Common input properties */
  common: {
    borderRadius: borderRadius.lg,
    transition: 'all 150ms ease',
  },
} as const;

// ============================================================================
// Animation Durations
// ============================================================================

export const animation = {
  /** Fast - 150ms */
  fast: 150,
  /** Normal - 200ms */
  normal: 200,
  /** Slow - 300ms */
  slow: 300,
  /** Very slow - 500ms */
  verySlow: 500,
} as const;
