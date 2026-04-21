'use client';

import { ThemeToggle } from '@/components/theme-toggle';

/**
 * Appearance section: theme toggle.
 *
 * WHY its own section component even though it's tiny: the orchestrator stays
 * declarative ("render these sections in order") and future appearance
 * controls (font size, high-contrast mode, reduced motion) drop in here
 * without touching SettingsClient.
 */
export function SettingsAppearance() {
  return (
    <section className="mb-8">
      <h2 className="text-lg font-semibold text-zinc-100 dark:text-zinc-100 mb-4">
        Appearance
      </h2>
      <div className="rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
        <div className="px-4 py-4 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Theme</p>
            <p className="text-sm text-zinc-500 dark:text-zinc-500">
              Choose your preferred color scheme
            </p>
          </div>
          <ThemeToggle />
        </div>
      </div>
    </section>
  );
}
