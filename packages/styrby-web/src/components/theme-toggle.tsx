'use client';

import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';

/**
 * Theme toggle button group for switching between light, dark, and system themes.
 *
 * WHY: Users have different preferences for color schemes:
 * - Some prefer dark mode to reduce eye strain
 * - Some prefer light mode for better readability in bright environments
 * - Some want to follow their system preference automatically
 *
 * This component provides a visual toggle that persists the preference.
 *
 * @returns A button group with light/dark/system theme options
 *
 * @example
 * <ThemeToggle />
 */
export function ThemeToggle() {
  const [mounted, setMounted] = useState(false);
  const { theme, setTheme } = useTheme();

  // WHY: Avoid hydration mismatch by only rendering after mount.
  // next-themes reads from localStorage on the client, so the server
  // render won't know the user's preference. We show a placeholder
  // until the client has mounted to prevent a flash/mismatch.
  // Note: This is a standard SSR hydration pattern for next-themes.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Standard SSR hydration pattern for next-themes
    setMounted(true);
  }, []);

  if (!mounted) {
    // Return placeholder with same dimensions to prevent layout shift
    return <div className="h-9 w-[108px]" aria-hidden="true" />;
  }

  /**
   * Available theme options with their display properties.
   */
  const themes = [
    { value: 'light', icon: Sun, label: 'Light theme' },
    { value: 'dark', icon: Moon, label: 'Dark theme' },
    { value: 'system', icon: Monitor, label: 'System theme' },
  ] as const;

  return (
    <div
      className="flex items-center gap-1 rounded-lg border border-zinc-200 bg-zinc-100/50 p-1 dark:border-zinc-700 dark:bg-zinc-800/50"
      role="group"
      aria-label="Theme selection"
    >
      {themes.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          onClick={() => setTheme(value)}
          className={`
            flex h-7 w-7 items-center justify-center rounded-md transition-colors
            ${
              theme === value
                ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-900 dark:text-zinc-100'
                : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
            }
          `}
          aria-label={label}
          aria-pressed={theme === value}
        >
          <Icon className="h-4 w-4" />
        </button>
      ))}
    </div>
  );
}
