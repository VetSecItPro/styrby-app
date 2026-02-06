/**
 * Styrby Design System - Colors
 *
 * Shared color palette for web (Tailwind) and mobile (NativeWind).
 * Dark-first design with agent and error color coding.
 */

// ============================================================================
// Base Colors (Zinc scale for dark theme)
// ============================================================================

export const zinc = {
  50: '#fafafa',
  100: '#f4f4f5',
  200: '#e4e4e7',
  300: '#d4d4d8',
  400: '#a1a1aa',
  500: '#71717a',
  600: '#52525b',
  700: '#3f3f46',
  800: '#27272a',
  900: '#18181b',
  950: '#09090b',
} as const;

// ============================================================================
// Background Colors
// ============================================================================

export const background = {
  /** Primary background - zinc-950 */
  DEFAULT: zinc[950],
  /** Secondary background - zinc-900 */
  secondary: zinc[900],
  /** Tertiary background - zinc-800 */
  tertiary: zinc[800],
  /** Elevated surfaces - zinc-800 */
  elevated: zinc[800],
  /** Hover state */
  hover: zinc[800],
  /** Active/pressed state */
  active: zinc[700],
} as const;

// ============================================================================
// Text Colors
// ============================================================================

export const text = {
  /** Primary text - white */
  DEFAULT: '#ffffff',
  /** Secondary text - zinc-400 */
  secondary: zinc[400],
  /** Muted text - zinc-500 */
  muted: zinc[500],
  /** Disabled text - zinc-600 */
  disabled: zinc[600],
  /** Inverted text (for light surfaces) */
  inverted: zinc[950],
} as const;

// ============================================================================
// Brand Colors
// ============================================================================

export const brand = {
  /** Primary brand - orange-500 */
  DEFAULT: '#f97316',
  /** Light variant - orange-400 */
  light: '#fb923c',
  /** Dark variant - orange-600 */
  dark: '#ea580c',
  /** Subtle background */
  subtle: 'rgba(249, 115, 22, 0.1)',
  /** Border color */
  border: 'rgba(249, 115, 22, 0.3)',
} as const;

// ============================================================================
// Agent Colors
// ============================================================================

/**
 * Each AI agent has a distinct color for visual identification.
 */
export const agent = {
  /** Claude Code - orange (Anthropic brand color) */
  claude: {
    DEFAULT: '#f97316',
    light: '#fb923c',
    dark: '#ea580c',
    subtle: 'rgba(249, 115, 22, 0.1)',
    border: 'rgba(249, 115, 22, 0.3)',
  },
  /** Codex - green (OpenAI-inspired) */
  codex: {
    DEFAULT: '#22c55e',
    light: '#4ade80',
    dark: '#16a34a',
    subtle: 'rgba(34, 197, 94, 0.1)',
    border: 'rgba(34, 197, 94, 0.3)',
  },
  /** Gemini - blue (Google-inspired) */
  gemini: {
    DEFAULT: '#3b82f6',
    light: '#60a5fa',
    dark: '#2563eb',
    subtle: 'rgba(59, 130, 246, 0.1)',
    border: 'rgba(59, 130, 246, 0.3)',
  },
  /** OpenCode - violet (open source) */
  opencode: {
    DEFAULT: '#8b5cf6',
    light: '#a78bfa',
    dark: '#7c3aed',
    subtle: 'rgba(139, 92, 246, 0.1)',
    border: 'rgba(139, 92, 246, 0.3)',
  },
  /** Aider - pink (pair programming) */
  aider: {
    DEFAULT: '#ec4899',
    light: '#f472b6',
    dark: '#db2777',
    subtle: 'rgba(236, 72, 153, 0.1)',
    border: 'rgba(236, 72, 153, 0.3)',
  },
} as const;

// ============================================================================
// Error Source Colors
// ============================================================================

/**
 * Color coding for smart error attribution.
 * Helps users quickly identify where an error originated.
 */
export const errorSource = {
  /** Styrby infrastructure errors - orange */
  styrby: {
    DEFAULT: '#f97316',
    subtle: 'rgba(249, 115, 22, 0.1)',
    border: 'rgba(249, 115, 22, 0.3)',
  },
  /** Agent errors (AI model issues) - red */
  agent: {
    DEFAULT: '#ef4444',
    subtle: 'rgba(239, 68, 68, 0.1)',
    border: 'rgba(239, 68, 68, 0.3)',
  },
  /** Build tool errors (npm, tsc, etc) - blue */
  build: {
    DEFAULT: '#3b82f6',
    subtle: 'rgba(59, 130, 246, 0.1)',
    border: 'rgba(59, 130, 246, 0.3)',
  },
  /** Network errors - yellow */
  network: {
    DEFAULT: '#eab308',
    subtle: 'rgba(234, 179, 8, 0.1)',
    border: 'rgba(234, 179, 8, 0.3)',
  },
  /** Permission errors - purple */
  permission: {
    DEFAULT: '#8b5cf6',
    subtle: 'rgba(139, 92, 246, 0.1)',
    border: 'rgba(139, 92, 246, 0.3)',
  },
} as const;

// ============================================================================
// Status Colors
// ============================================================================

export const status = {
  /** Success - green */
  success: {
    DEFAULT: '#22c55e',
    subtle: 'rgba(34, 197, 94, 0.1)',
    border: 'rgba(34, 197, 94, 0.3)',
  },
  /** Warning - yellow */
  warning: {
    DEFAULT: '#eab308',
    subtle: 'rgba(234, 179, 8, 0.1)',
    border: 'rgba(234, 179, 8, 0.3)',
  },
  /** Error - red */
  error: {
    DEFAULT: '#ef4444',
    subtle: 'rgba(239, 68, 68, 0.1)',
    border: 'rgba(239, 68, 68, 0.3)',
  },
  /** Info - blue */
  info: {
    DEFAULT: '#3b82f6',
    subtle: 'rgba(59, 130, 246, 0.1)',
    border: 'rgba(59, 130, 246, 0.3)',
  },
} as const;

// ============================================================================
// Border Colors
// ============================================================================

export const border = {
  /** Default border - zinc-800 */
  DEFAULT: zinc[800],
  /** Subtle border - zinc-800/50 */
  subtle: 'rgba(39, 39, 42, 0.5)',
  /** Strong border - zinc-700 */
  strong: zinc[700],
  /** Focus ring */
  focus: brand.DEFAULT,
} as const;

// ============================================================================
// Risk Level Colors (for permission requests)
// ============================================================================

export const riskLevel = {
  /** Low risk - green */
  low: {
    DEFAULT: '#22c55e',
    subtle: 'rgba(34, 197, 94, 0.1)',
    text: '#4ade80',
  },
  /** Medium risk - yellow */
  medium: {
    DEFAULT: '#eab308',
    subtle: 'rgba(234, 179, 8, 0.1)',
    text: '#facc15',
  },
  /** High risk - orange */
  high: {
    DEFAULT: '#f97316',
    subtle: 'rgba(249, 115, 22, 0.1)',
    text: '#fb923c',
  },
  /** Critical risk - red */
  critical: {
    DEFAULT: '#ef4444',
    subtle: 'rgba(239, 68, 68, 0.1)',
    text: '#f87171',
  },
} as const;

// ============================================================================
// Tailwind Color Config Export
// ============================================================================

/**
 * Export colors formatted for Tailwind CSS config.
 * Use this in tailwind.config.js extend.colors
 */
export const tailwindColors = {
  background,
  brand,
  agent: {
    claude: agent.claude.DEFAULT,
    'claude-light': agent.claude.light,
    'claude-dark': agent.claude.dark,
    codex: agent.codex.DEFAULT,
    'codex-light': agent.codex.light,
    'codex-dark': agent.codex.dark,
    gemini: agent.gemini.DEFAULT,
    'gemini-light': agent.gemini.light,
    'gemini-dark': agent.gemini.dark,
    opencode: agent.opencode.DEFAULT,
    'opencode-light': agent.opencode.light,
    'opencode-dark': agent.opencode.dark,
    aider: agent.aider.DEFAULT,
    'aider-light': agent.aider.light,
    'aider-dark': agent.aider.dark,
  },
  error: {
    styrby: errorSource.styrby.DEFAULT,
    agent: errorSource.agent.DEFAULT,
    build: errorSource.build.DEFAULT,
    network: errorSource.network.DEFAULT,
    permission: errorSource.permission.DEFAULT,
  },
  status: {
    success: status.success.DEFAULT,
    warning: status.warning.DEFAULT,
    error: status.error.DEFAULT,
    info: status.info.DEFAULT,
  },
  risk: {
    low: riskLevel.low.DEFAULT,
    medium: riskLevel.medium.DEFAULT,
    high: riskLevel.high.DEFAULT,
    critical: riskLevel.critical.DEFAULT,
  },
} as const;
