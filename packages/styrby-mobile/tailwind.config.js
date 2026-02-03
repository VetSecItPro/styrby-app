/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{js,jsx,ts,tsx}', './src/**/*.{js,jsx,ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        // Background colors (dark theme)
        background: {
          DEFAULT: '#09090b', // zinc-950
          secondary: '#18181b', // zinc-900
          tertiary: '#27272a', // zinc-800
        },
        // Agent colors
        agent: {
          claude: '#f97316', // orange-500
          codex: '#22c55e', // green-500
          gemini: '#3b82f6', // blue-500
        },
        // Error source colors
        error: {
          styrby: '#f97316', // orange
          agent: '#ef4444', // red
          build: '#3b82f6', // blue
          network: '#eab308', // yellow
        },
        // Brand
        brand: {
          DEFAULT: '#f97316', // orange-500
          light: '#fb923c', // orange-400
          dark: '#ea580c', // orange-600
        },
      },
    },
  },
  plugins: [],
};
