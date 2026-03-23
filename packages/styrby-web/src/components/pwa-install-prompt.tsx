'use client';

import Image from 'next/image';
import { usePWAInstall } from '@/hooks/usePWAInstall';

/**
 * PWA Install Prompt Banner
 *
 * Displays a fixed banner at the bottom of the dashboard when the app is
 * installable but not yet installed. Provides "Install" and "Not now" actions.
 *
 * WHY: Native app-like install prompts significantly increase PWA adoption.
 * The default browser mini-infobar is easily missed and not branded. This
 * custom banner communicates the value proposition (offline access) and gives
 * users clear control over dismissal.
 *
 * Only renders when all three conditions are met:
 * 1. The browser supports installation (canInstall is true)
 * 2. The user has not previously dismissed the prompt
 * 3. The app is not already running in standalone mode
 *
 * @returns The install banner JSX, or null if conditions are not met
 *
 * @example
 * // In the dashboard layout:
 * <PWAInstallPrompt />
 */
export function PWAInstallPrompt() {
  const { canInstall, isInstalled, isDismissed, install, dismiss } =
    usePWAInstall();

  if (!canInstall || isDismissed || isInstalled) {
    return null;
  }

  return (
    <div
      role="banner"
      aria-label="Install Styrby application"
      className="fixed bottom-0 left-0 right-0 z-50 border-t border-zinc-800 bg-zinc-950/95 backdrop-blur-sm px-4 py-3 sm:px-6"
    >
      <div className="mx-auto flex max-w-4xl items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Image
            src="/logo.png"
            alt="Styrby logo"
            width={32}
            height={32}
            className="rounded-lg"
          />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-zinc-100">
              Install Styrby
            </p>
            <p className="text-xs text-zinc-400">
              Access your dashboard offline
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={dismiss}
            className="rounded-md px-3 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
          >
            Not now
          </button>
          <button
            type="button"
            onClick={install}
            className="rounded-md bg-amber-500 px-3 py-1.5 text-xs font-semibold text-zinc-950 transition-colors hover:bg-amber-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
          >
            Install
          </button>
        </div>
      </div>
    </div>
  );
}
