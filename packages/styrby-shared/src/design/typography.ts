/**
 * Styrby Design System - Typography
 *
 * Consistent typography scale for web and mobile.
 * Based on a modular scale for harmonious sizing.
 */

// ============================================================================
// Font Families
// ============================================================================

export const fontFamily = {
  /** Primary font - system font stack */
  sans: [
    '-apple-system',
    'BlinkMacSystemFont',
    'Segoe UI',
    'Roboto',
    'Helvetica Neue',
    'Arial',
    'sans-serif',
  ],
  /** Monospace font - for code */
  mono: [
    'SF Mono',
    'Menlo',
    'Monaco',
    'Consolas',
    'Liberation Mono',
    'Courier New',
    'monospace',
  ],
} as const;

// ============================================================================
// Font Sizes (rem based, 16px base)
// ============================================================================

export const fontSize = {
  /** Extra small - 12px */
  xs: '0.75rem',
  /** Small - 14px */
  sm: '0.875rem',
  /** Base - 16px */
  base: '1rem',
  /** Large - 18px */
  lg: '1.125rem',
  /** Extra large - 20px */
  xl: '1.25rem',
  /** 2XL - 24px */
  '2xl': '1.5rem',
  /** 3XL - 30px */
  '3xl': '1.875rem',
  /** 4XL - 36px */
  '4xl': '2.25rem',
  /** 5XL - 48px */
  '5xl': '3rem',
} as const;

// ============================================================================
// Font Weights
// ============================================================================

export const fontWeight = {
  /** Normal - 400 */
  normal: '400',
  /** Medium - 500 */
  medium: '500',
  /** Semibold - 600 */
  semibold: '600',
  /** Bold - 700 */
  bold: '700',
} as const;

// ============================================================================
// Line Heights
// ============================================================================

export const lineHeight = {
  /** None - 1 */
  none: '1',
  /** Tight - 1.25 */
  tight: '1.25',
  /** Snug - 1.375 */
  snug: '1.375',
  /** Normal - 1.5 */
  normal: '1.5',
  /** Relaxed - 1.625 */
  relaxed: '1.625',
  /** Loose - 2 */
  loose: '2',
} as const;

// ============================================================================
// Letter Spacing
// ============================================================================

export const letterSpacing = {
  /** Tighter - -0.05em */
  tighter: '-0.05em',
  /** Tight - -0.025em */
  tight: '-0.025em',
  /** Normal - 0 */
  normal: '0',
  /** Wide - 0.025em */
  wide: '0.025em',
  /** Wider - 0.05em */
  wider: '0.05em',
  /** Widest - 0.1em */
  widest: '0.1em',
} as const;

// ============================================================================
// Text Styles (Presets)
// ============================================================================

/**
 * Predefined text styles combining size, weight, and line height.
 * Use these for consistent typography across the app.
 */
export const textStyle = {
  /** Page title - 36px bold */
  h1: {
    fontSize: fontSize['4xl'],
    fontWeight: fontWeight.bold,
    lineHeight: lineHeight.tight,
    letterSpacing: letterSpacing.tight,
  },
  /** Section title - 30px bold */
  h2: {
    fontSize: fontSize['3xl'],
    fontWeight: fontWeight.bold,
    lineHeight: lineHeight.tight,
    letterSpacing: letterSpacing.tight,
  },
  /** Subsection title - 24px semibold */
  h3: {
    fontSize: fontSize['2xl'],
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.snug,
  },
  /** Card title - 20px semibold */
  h4: {
    fontSize: fontSize.xl,
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.snug,
  },
  /** Body large - 18px normal */
  bodyLarge: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.normal,
    lineHeight: lineHeight.relaxed,
  },
  /** Body - 16px normal */
  body: {
    fontSize: fontSize.base,
    fontWeight: fontWeight.normal,
    lineHeight: lineHeight.normal,
  },
  /** Body small - 14px normal */
  bodySmall: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.normal,
    lineHeight: lineHeight.normal,
  },
  /** Caption - 12px normal */
  caption: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.normal,
    lineHeight: lineHeight.normal,
  },
  /** Label - 14px medium */
  label: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.tight,
  },
  /** Button - 14px semibold */
  button: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.tight,
  },
  /** Code - 14px mono */
  code: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.normal,
    lineHeight: lineHeight.relaxed,
    fontFamily: fontFamily.mono.join(', '),
  },
} as const;

// ============================================================================
// Mobile Font Sizes (React Native)
// ============================================================================

/**
 * Font sizes for React Native (in pixels, not rem).
 * React Native doesn't support rem, so we use numeric values.
 */
export const mobileFontSize = {
  xs: 12,
  sm: 14,
  base: 16,
  lg: 18,
  xl: 20,
  '2xl': 24,
  '3xl': 30,
  '4xl': 36,
  '5xl': 48,
} as const;

/**
 * Mobile text styles with numeric values for React Native.
 */
export const mobileTextStyle = {
  h1: {
    fontSize: mobileFontSize['4xl'],
    fontWeight: fontWeight.bold as '700',
    lineHeight: mobileFontSize['4xl'] * 1.25,
  },
  h2: {
    fontSize: mobileFontSize['3xl'],
    fontWeight: fontWeight.bold as '700',
    lineHeight: mobileFontSize['3xl'] * 1.25,
  },
  h3: {
    fontSize: mobileFontSize['2xl'],
    fontWeight: fontWeight.semibold as '600',
    lineHeight: mobileFontSize['2xl'] * 1.375,
  },
  h4: {
    fontSize: mobileFontSize.xl,
    fontWeight: fontWeight.semibold as '600',
    lineHeight: mobileFontSize.xl * 1.375,
  },
  bodyLarge: {
    fontSize: mobileFontSize.lg,
    fontWeight: fontWeight.normal as '400',
    lineHeight: mobileFontSize.lg * 1.625,
  },
  body: {
    fontSize: mobileFontSize.base,
    fontWeight: fontWeight.normal as '400',
    lineHeight: mobileFontSize.base * 1.5,
  },
  bodySmall: {
    fontSize: mobileFontSize.sm,
    fontWeight: fontWeight.normal as '400',
    lineHeight: mobileFontSize.sm * 1.5,
  },
  caption: {
    fontSize: mobileFontSize.xs,
    fontWeight: fontWeight.normal as '400',
    lineHeight: mobileFontSize.xs * 1.5,
  },
  label: {
    fontSize: mobileFontSize.sm,
    fontWeight: fontWeight.medium as '500',
    lineHeight: mobileFontSize.sm * 1.25,
  },
  button: {
    fontSize: mobileFontSize.sm,
    fontWeight: fontWeight.semibold as '600',
    lineHeight: mobileFontSize.sm * 1.25,
  },
} as const;
