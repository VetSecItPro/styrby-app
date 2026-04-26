import type { Config } from 'tailwindcss';
import forms from '@tailwindcss/forms';
import typography from '@tailwindcss/typography';
import animate from 'tailwindcss-animate';

/**
 * Styrby Tailwind config (Wave 3 — OKLCH token system).
 *
 * Color sourcing: every color references a CSS custom property whose value
 * is bare OKLCH parts (L C H — no oklch() wrapper). Tailwind utilities wrap
 * with `oklch(var(--token) / <alpha-value>)` so opacity modifiers like
 * `bg-primary/80` continue to work. This mirrors the pattern Tailwind
 * recommends for HSL but uses OKLCH for perceptual uniformity.
 *
 * Three layers (defined in src/app/globals.css):
 *   1. Primitives — `--color-steel-*`, `--color-amber-*` (named ramps).
 *   2. Semantic — `--background`, `--foreground`, `--primary`, etc.
 *      (what components reference 95% of the time).
 *   3. Light overrides under :root.light (supplementary; dark stays default).
 *
 * NO `styrby: { 50: ..., 950: ... }` block: that was a literal copy of
 * Tailwind's default orange palette and read as template-clone "slop".
 * Brand color now comes through `primary` (semantic) which resolves to
 * `--color-amber-500` (a hue-60 OKLCH amber, distinct from Tailwind's hue-30).
 */
const config: Config = {
  darkMode: ['class'],
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      screens: {
        // 2xs handles older / smaller Android devices common in dev demographics
        '2xs': '320px',
      },
      colors: {
        /* ── Semantic tokens (what components should reference) ── */
        background: 'oklch(var(--background) / <alpha-value>)',
        foreground: 'oklch(var(--foreground) / <alpha-value>)',
        'foreground-secondary': 'oklch(var(--foreground-secondary) / <alpha-value>)',
        'foreground-tertiary': 'oklch(var(--foreground-tertiary) / <alpha-value>)',

        card: {
          DEFAULT: 'oklch(var(--card) / <alpha-value>)',
          foreground: 'oklch(var(--card-foreground) / <alpha-value>)',
        },
        popover: {
          DEFAULT: 'oklch(var(--popover) / <alpha-value>)',
          foreground: 'oklch(var(--popover-foreground) / <alpha-value>)',
        },
        primary: {
          DEFAULT: 'oklch(var(--primary) / <alpha-value>)',
          foreground: 'oklch(var(--primary-foreground) / <alpha-value>)',
          muted: 'oklch(var(--primary-muted) / <alpha-value>)',
        },
        secondary: {
          DEFAULT: 'oklch(var(--secondary) / <alpha-value>)',
          foreground: 'oklch(var(--secondary-foreground) / <alpha-value>)',
        },
        muted: {
          DEFAULT: 'oklch(var(--muted) / <alpha-value>)',
          foreground: 'oklch(var(--muted-foreground) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'oklch(var(--accent) / <alpha-value>)',
          foreground: 'oklch(var(--accent-foreground) / <alpha-value>)',
        },
        destructive: {
          DEFAULT: 'oklch(var(--destructive) / <alpha-value>)',
          foreground: 'oklch(var(--destructive-foreground) / <alpha-value>)',
        },
        success: 'oklch(var(--success) / <alpha-value>)',
        warning: 'oklch(var(--warning) / <alpha-value>)',
        border: 'oklch(var(--border) / <alpha-value>)',
        'border-strong': 'oklch(var(--border-strong) / <alpha-value>)',
        input: 'oklch(var(--input) / <alpha-value>)',
        ring: 'oklch(var(--ring) / <alpha-value>)',

        surface: {
          1: 'oklch(var(--surface-1) / <alpha-value>)',
          2: 'oklch(var(--surface-2) / <alpha-value>)',
          3: 'oklch(var(--surface-3) / <alpha-value>)',
          4: 'oklch(var(--surface-4) / <alpha-value>)',
        },

        chart: {
          '1': 'oklch(var(--chart-1) / <alpha-value>)',
          '2': 'oklch(var(--chart-2) / <alpha-value>)',
          '3': 'oklch(var(--chart-3) / <alpha-value>)',
          '4': 'oklch(var(--chart-4) / <alpha-value>)',
          '5': 'oklch(var(--chart-5) / <alpha-value>)',
        },
        sidebar: {
          DEFAULT: 'oklch(var(--sidebar-background) / <alpha-value>)',
          foreground: 'oklch(var(--sidebar-foreground) / <alpha-value>)',
          primary: 'oklch(var(--sidebar-primary) / <alpha-value>)',
          'primary-foreground': 'oklch(var(--sidebar-primary-foreground) / <alpha-value>)',
          accent: 'oklch(var(--sidebar-accent) / <alpha-value>)',
          'accent-foreground': 'oklch(var(--sidebar-accent-foreground) / <alpha-value>)',
          border: 'oklch(var(--sidebar-border) / <alpha-value>)',
          ring: 'oklch(var(--sidebar-ring) / <alpha-value>)',
        },

        /* ── Primitive ramps (rare direct access — prefer semantic) ── */
        steel: {
          50: 'oklch(var(--color-steel-50) / <alpha-value>)',
          100: 'oklch(var(--color-steel-100) / <alpha-value>)',
          200: 'oklch(var(--color-steel-200) / <alpha-value>)',
          300: 'oklch(var(--color-steel-300) / <alpha-value>)',
          400: 'oklch(var(--color-steel-400) / <alpha-value>)',
          500: 'oklch(var(--color-steel-500) / <alpha-value>)',
          600: 'oklch(var(--color-steel-600) / <alpha-value>)',
          700: 'oklch(var(--color-steel-700) / <alpha-value>)',
          800: 'oklch(var(--color-steel-800) / <alpha-value>)',
          900: 'oklch(var(--color-steel-900) / <alpha-value>)',
          950: 'oklch(var(--color-steel-950) / <alpha-value>)',
          1000: 'oklch(var(--color-steel-1000) / <alpha-value>)',
        },
        amber: {
          50: 'oklch(var(--color-amber-50) / <alpha-value>)',
          100: 'oklch(var(--color-amber-100) / <alpha-value>)',
          200: 'oklch(var(--color-amber-200) / <alpha-value>)',
          300: 'oklch(var(--color-amber-300) / <alpha-value>)',
          400: 'oklch(var(--color-amber-400) / <alpha-value>)',
          500: 'oklch(var(--color-amber-500) / <alpha-value>)',
          600: 'oklch(var(--color-amber-600) / <alpha-value>)',
          700: 'oklch(var(--color-amber-700) / <alpha-value>)',
          800: 'oklch(var(--color-amber-800) / <alpha-value>)',
          900: 'oklch(var(--color-amber-900) / <alpha-value>)',
          950: 'oklch(var(--color-amber-950) / <alpha-value>)',
        },

        /* ── Agent brand colors (third-party identities — kept as fixed hex
         *   to match upstream brand guidelines for Claude / Codex / Gemini
         *   etc; they are not part of Styrby's brand palette) ── */
        claude: {
          DEFAULT: '#f97316',
          light: '#fed7aa',
          dark: '#c2410c',
        },
        codex: {
          DEFAULT: '#22c55e',
          light: '#bbf7d0',
          dark: '#15803d',
        },
        gemini: {
          DEFAULT: '#3b82f6',
          light: '#bfdbfe',
          dark: '#1d4ed8',
        },
        opencode: '#06B6D4',
        aider: '#8B5CF6',

        /* ── Error source colors ── */
        error: {
          styrby: 'oklch(var(--primary))',
          agent: '#ef4444',
          build: '#3b82f6',
          network: '#eab308',
        },
      },
      fontFamily: {
        sans: ['var(--font-outfit)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-jetbrains)', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        /* Semantic typography scale — fluid clamp() for headings, fixed for body */
        'display-xl': [
          'clamp(3rem, 2rem + 4vw, 5rem)',
          { lineHeight: '0.95', letterSpacing: '-0.04em', fontWeight: '800' },
        ],
        display: [
          'clamp(2.25rem, 1.5rem + 3vw, 3.75rem)',
          { lineHeight: '1.0', letterSpacing: '-0.035em', fontWeight: '700' },
        ],
        h1: [
          'clamp(2rem, 1.5rem + 2vw, 3rem)',
          { lineHeight: '1.1', letterSpacing: '-0.03em', fontWeight: '700' },
        ],
        h2: [
          'clamp(1.5rem, 1.2rem + 1vw, 2rem)',
          { lineHeight: '1.2', letterSpacing: '-0.02em', fontWeight: '600' },
        ],
        h3: [
          '1.25rem',
          { lineHeight: '1.4', letterSpacing: '-0.01em', fontWeight: '600' },
        ],
        'body-lg': ['1.125rem', { lineHeight: '1.6' }],
        body: ['1rem', { lineHeight: '1.55' }],
        'body-sm': ['0.875rem', { lineHeight: '1.5' }],
        caption: ['0.8125rem', { lineHeight: '1.45' }],
        /* WHY no textTransform here: Tailwind's fontSize tuple type does not
         * accept textTransform. Apply `uppercase` as a separate utility class
         * (e.g. `text-label uppercase`) on labels. */
        label: [
          '0.6875rem',
          {
            lineHeight: '1.0',
            letterSpacing: '0.15em',
            fontWeight: '500',
          },
        ],
      },
      borderRadius: {
        /* Custom radius hierarchy — semantic intent, not just shorthand */
        sharp: '0.125rem',
        base: '0.375rem',
        card: '0.5rem',
        hero: '1rem',
        /* Tailwind's xl/2xl/full retained for compat / decorative use */
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      keyframes: {
        'fade-in-out': {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '20%': { opacity: '1', transform: 'translateY(0)' },
          '80%': { opacity: '1', transform: 'translateY(0)' },
          '100%': { opacity: '0', transform: 'translateY(-10px)' },
        },
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
      },
      animation: {
        'fade-in-out': 'fade-in-out 2s ease-in-out forwards',
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [forms, typography, animate],
};

export default config;
