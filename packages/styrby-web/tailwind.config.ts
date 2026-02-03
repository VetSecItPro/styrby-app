import type { Config } from 'tailwindcss';
import forms from '@tailwindcss/forms';

const config: Config = {
  darkMode: 'class',
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Styrby brand colors
        styrby: {
          50: '#fff7ed',
          100: '#ffedd5',
          200: '#fed7aa',
          300: '#fdba74',
          400: '#fb923c',
          500: '#f97316', // Primary orange
          600: '#ea580c',
          700: '#c2410c',
          800: '#9a3412',
          900: '#7c2d12',
          950: '#431407',
        },
        // Agent colors (for multi-agent dashboard)
        claude: {
          DEFAULT: '#f97316', // Orange
          light: '#fed7aa',
          dark: '#c2410c',
        },
        codex: {
          DEFAULT: '#22c55e', // Green
          light: '#bbf7d0',
          dark: '#15803d',
        },
        gemini: {
          DEFAULT: '#3b82f6', // Blue
          light: '#bfdbfe',
          dark: '#1d4ed8',
        },
        // Error source colors
        error: {
          styrby: '#f97316', // Orange - our fault
          agent: '#ef4444', // Red - agent error
          build: '#3b82f6', // Blue - build/compile
          network: '#eab308', // Yellow - connectivity
        },
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [forms],
};

export default config;
