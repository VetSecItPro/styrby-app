'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * localStorage key used to persist the user's dismissal of the install prompt.
 * WHY: We respect the user's choice to dismiss the prompt. Without persistence,
 * the prompt would reappear on every page load, creating a frustrating experience.
 */
const DISMISS_KEY = 'pwa-install-dismissed';

/**
 * Extended BeforeInstallPromptEvent interface.
 * WHY: The BeforeInstallPromptEvent is not yet part of the standard TypeScript
 * DOM types. Browsers that support PWA installation (Chromium-based) fire this
 * event when the app meets installability criteria. We need the prompt() method
 * and userChoice promise to trigger and track the native install dialog.
 */
interface BeforeInstallPromptEvent extends Event {
  /** Shows the native install dialog to the user */
  prompt(): Promise<void>;
  /** Resolves with the user's choice after the dialog closes */
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * Return type for the usePWAInstall hook.
 */
interface PWAInstallState {
  /** True when the browser has fired beforeinstallprompt and the prompt is available */
  canInstall: boolean;
  /** True when the app is running in standalone mode (already installed) */
  isInstalled: boolean;
  /** True when the user has previously dismissed the install prompt */
  isDismissed: boolean;
  /** Triggers the native install prompt. Returns true if the user accepted. */
  install: () => Promise<boolean>;
  /** Marks the prompt as dismissed and persists to localStorage */
  dismiss: () => void;
}

/**
 * Hook that manages the PWA install experience.
 *
 * Listens for the browser's `beforeinstallprompt` event, tracks whether the
 * app is already installed (via display-mode: standalone media query), and
 * provides methods to trigger the native install dialog or dismiss the prompt.
 *
 * @returns An object with install state and actions
 *
 * @example
 * const { canInstall, isInstalled, isDismissed, install, dismiss } = usePWAInstall();
 *
 * if (canInstall && !isDismissed && !isInstalled) {
 *   return <button onClick={install}>Install App</button>;
 * }
 */
export function usePWAInstall(): PWAInstallState {
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [canInstall, setCanInstall] = useState(false);
  const [isInstalled, setIsInstalled] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Check if the user previously dismissed the prompt
    try {
      setIsDismissed(localStorage.getItem(DISMISS_KEY) === 'true');
    } catch {
      // WHY: localStorage can throw in private browsing mode on some browsers.
      // We silently fall back to not-dismissed so the prompt can still appear.
    }

    // Check if already running as installed PWA
    const mediaQuery = window.matchMedia('(display-mode: standalone)');
    setIsInstalled(mediaQuery.matches);

    /**
     * Handles display mode changes (e.g., user installs the app while the
     * page is open, or opens it from the installed version).
     *
     * @param event - The MediaQueryListEvent indicating display mode changed
     */
    function handleDisplayModeChange(event: MediaQueryListEvent): void {
      setIsInstalled(event.matches);
    }

    mediaQuery.addEventListener('change', handleDisplayModeChange);

    /**
     * Captures the beforeinstallprompt event fired by Chromium-based browsers
     * when the PWA meets installability criteria. We prevent the default
     * browser mini-infobar and store the event for later use.
     *
     * @param event - The browser's install prompt event
     */
    function handleBeforeInstallPrompt(event: Event): void {
      // WHY: Prevent the default browser mini-infobar from appearing.
      // We provide our own styled install prompt instead.
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
      setCanInstall(true);
    }

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);

    /**
     * Handles the appinstalled event, which fires after the user successfully
     * installs the PWA. We clear the deferred prompt since it is no longer needed.
     */
    function handleAppInstalled(): void {
      setDeferredPrompt(null);
      setCanInstall(false);
      setIsInstalled(true);
    }

    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      mediaQuery.removeEventListener('change', handleDisplayModeChange);
      window.removeEventListener(
        'beforeinstallprompt',
        handleBeforeInstallPrompt
      );
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  /**
   * Triggers the native install dialog using the stored beforeinstallprompt event.
   *
   * @returns True if the user accepted the install, false if they dismissed it
   */
  const install = useCallback(async (): Promise<boolean> => {
    if (!deferredPrompt) return false;

    // WHY: Clear deferredPrompt BEFORE calling prompt(). The prompt() method
    // can only be called once per beforeinstallprompt event. Clearing first
    // prevents a second call if the user clicks rapidly, and ensures state
    // is consistent regardless of whether the user accepts or dismisses.
    const prompt = deferredPrompt;
    setDeferredPrompt(null);
    setCanInstall(false);

    await prompt.prompt();
    const { outcome } = await prompt.userChoice;

    if (outcome === 'accepted') {
      setIsInstalled(true);
      return true;
    }

    return false;
  }, [deferredPrompt]);

  /**
   * Marks the install prompt as dismissed and persists the choice to localStorage.
   */
  const dismiss = useCallback((): void => {
    setIsDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, 'true');
    } catch {
      // WHY: localStorage can throw in private browsing mode.
      // The in-memory state still prevents the prompt from showing this session.
    }
  }, []);

  return {
    canInstall,
    isInstalled,
    isDismissed,
    install,
    dismiss,
  };
}
