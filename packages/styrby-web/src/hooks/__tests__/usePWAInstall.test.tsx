/**
 * Tests for usePWAInstall hook
 *
 * WHY: PWA installation is a key engagement pathway. These tests verify that
 * the hook correctly handles the beforeinstallprompt lifecycle, persists
 * dismissal to localStorage, tracks the standalone display-mode, and returns
 * accurate state for all combinations of install/dismiss/installed flags.
 *
 * NOTE: jsdom's localStorage stub does not implement .clear() or .removeItem().
 * We mock the entire localStorage object so tests can control its state.
 *
 * @module hooks/__tests__/usePWAInstall.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePWAInstall } from '../usePWAInstall';

/** Matches the hook's internal DISMISS_KEY constant. */
const DISMISS_KEY = 'pwa-install-dismissed';

// ─── localStorage mock ────────────────────────────────────────────────────────

/**
 * In-memory localStorage mock.
 * WHY: jsdom's localStorage stub only implements getItem/setItem, not
 * removeItem or clear. We replace the global with our own implementation
 * so tests can fully control storage state.
 */
function createLocalStorageMock() {
  const store: Map<string, string> = new Map();

  return {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { store.set(key, value); }),
    removeItem: vi.fn((key: string) => { store.delete(key); }),
    clear: vi.fn(() => { store.clear(); }),
    get length() { return store.size; },
    key: vi.fn((index: number) => Array.from(store.keys())[index] ?? null),
    _store: store,
  };
}

let localStorageMock: ReturnType<typeof createLocalStorageMock>;

// ─── MediaQueryList mock ─────────────────────────────────────────────────────

/**
 * Creates a mock MediaQueryList for the display-mode: standalone query.
 *
 * @param matches - Initial match state
 * @returns A mock implementing MediaQueryList with a _fireChange helper
 */
function createStandaloneMql(matches: boolean) {
  const listeners: Array<(e: MediaQueryListEvent) => void> = [];

  return {
    matches,
    media: '(display-mode: standalone)',
    addEventListener: vi.fn(
      (_type: string, listener: (e: MediaQueryListEvent) => void) => {
        listeners.push(listener);
      },
    ),
    removeEventListener: vi.fn(
      (_type: string, listener: (e: MediaQueryListEvent) => void) => {
        const idx = listeners.indexOf(listener);
        if (idx !== -1) listeners.splice(idx, 1);
      },
    ),
    _fireChange: (newMatches: boolean) => {
      const event = { matches: newMatches } as MediaQueryListEvent;
      listeners.forEach((l) => l(event));
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Creates a mock BeforeInstallPromptEvent.
 *
 * @param outcome - Whether the user 'accepted' or 'dismissed' the install dialog
 * @returns A mock event with prompt() and userChoice
 */
function createInstallPromptEvent(outcome: 'accepted' | 'dismissed'): Event & {
  prompt: ReturnType<typeof vi.fn>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
} {
  const event = new Event('beforeinstallprompt') as Event & {
    prompt: ReturnType<typeof vi.fn>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
  };
  event.preventDefault = vi.fn();
  event.prompt = vi.fn().mockResolvedValue(undefined);
  event.userChoice = Promise.resolve({ outcome });
  return event;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('usePWAInstall', () => {
  let mql: ReturnType<typeof createStandaloneMql>;

  beforeEach(() => {
    // Install fresh localStorage mock
    localStorageMock = createLocalStorageMock();
    Object.defineProperty(window, 'localStorage', {
      value: localStorageMock,
      writable: true,
      configurable: true,
    });

    // Install fresh matchMedia mock
    mql = createStandaloneMql(false);
    vi.spyOn(window, 'matchMedia').mockImplementation(
      () => mql as unknown as MediaQueryList,
    );

    vi.clearAllMocks();

    // Re-install mocks after clearAllMocks so they still work
    localStorageMock.getItem.mockImplementation((key: string) =>
      localStorageMock._store.get(key) ?? null,
    );
    localStorageMock.setItem.mockImplementation((key: string, value: string) => {
      localStorageMock._store.set(key, value);
    });
    localStorageMock.removeItem.mockImplementation((key: string) => {
      localStorageMock._store.delete(key);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorageMock._store.clear();
  });

  describe('initial state', () => {
    it('canInstall is false before the browser fires beforeinstallprompt', () => {
      const { result } = renderHook(() => usePWAInstall());

      expect(result.current.canInstall).toBe(false);
    });

    it('isInstalled is false when not in standalone mode', () => {
      mql = createStandaloneMql(false);
      vi.spyOn(window, 'matchMedia').mockImplementation(
        () => mql as unknown as MediaQueryList,
      );

      const { result } = renderHook(() => usePWAInstall());

      expect(result.current.isInstalled).toBe(false);
    });

    it('isInstalled is true when running in standalone mode', () => {
      mql = createStandaloneMql(true);
      vi.spyOn(window, 'matchMedia').mockImplementation(
        () => mql as unknown as MediaQueryList,
      );

      const { result } = renderHook(() => usePWAInstall());

      expect(result.current.isInstalled).toBe(true);
    });

    it('isDismissed is false when localStorage has no dismiss key', () => {
      const { result } = renderHook(() => usePWAInstall());

      expect(result.current.isDismissed).toBe(false);
    });

    it('isDismissed is true when localStorage has the dismiss key set to "true"', () => {
      localStorageMock._store.set(DISMISS_KEY, 'true');

      const { result } = renderHook(() => usePWAInstall());

      expect(result.current.isDismissed).toBe(true);
    });

    it('isDismissed is false when localStorage has any value other than "true"', () => {
      localStorageMock._store.set(DISMISS_KEY, 'false');

      const { result } = renderHook(() => usePWAInstall());

      expect(result.current.isDismissed).toBe(false);
    });

    it('exposes install and dismiss as functions', () => {
      const { result } = renderHook(() => usePWAInstall());

      expect(typeof result.current.install).toBe('function');
      expect(typeof result.current.dismiss).toBe('function');
    });
  });

  describe('beforeinstallprompt event', () => {
    it('sets canInstall=true when beforeinstallprompt fires', () => {
      const { result } = renderHook(() => usePWAInstall());

      act(() => {
        window.dispatchEvent(createInstallPromptEvent('accepted'));
      });

      expect(result.current.canInstall).toBe(true);
    });

    it('prevents the default browser mini-infobar', () => {
      const event = createInstallPromptEvent('accepted');
      renderHook(() => usePWAInstall());

      act(() => {
        window.dispatchEvent(event);
      });

      expect(event.preventDefault).toHaveBeenCalled();
    });
  });

  describe('install()', () => {
    it('returns false and is a no-op when no prompt is available', async () => {
      const { result } = renderHook(() => usePWAInstall());

      let outcome: boolean | undefined;
      await act(async () => {
        outcome = await result.current.install();
      });

      expect(outcome).toBe(false);
    });

    it('returns true when the user accepts the install dialog', async () => {
      const event = createInstallPromptEvent('accepted');
      const { result } = renderHook(() => usePWAInstall());

      act(() => { window.dispatchEvent(event); });

      let outcome: boolean | undefined;
      await act(async () => {
        outcome = await result.current.install();
      });

      expect(outcome).toBe(true);
    });

    it('returns false when the user dismisses the install dialog', async () => {
      const event = createInstallPromptEvent('dismissed');
      const { result } = renderHook(() => usePWAInstall());

      act(() => { window.dispatchEvent(event); });

      let outcome: boolean | undefined;
      await act(async () => {
        outcome = await result.current.install();
      });

      expect(outcome).toBe(false);
    });

    it('sets isInstalled=true when the user accepts', async () => {
      const event = createInstallPromptEvent('accepted');
      const { result } = renderHook(() => usePWAInstall());

      act(() => { window.dispatchEvent(event); });

      await act(async () => {
        await result.current.install();
      });

      expect(result.current.isInstalled).toBe(true);
    });

    it('clears canInstall after install() is called (prompt consumed)', async () => {
      const event = createInstallPromptEvent('accepted');
      const { result } = renderHook(() => usePWAInstall());

      act(() => { window.dispatchEvent(event); });
      expect(result.current.canInstall).toBe(true);

      await act(async () => {
        await result.current.install();
      });

      expect(result.current.canInstall).toBe(false);
    });

    it('calls prompt() exactly once on the deferred event', async () => {
      const event = createInstallPromptEvent('accepted');
      const { result } = renderHook(() => usePWAInstall());

      act(() => { window.dispatchEvent(event); });

      await act(async () => {
        await result.current.install();
      });

      expect(event.prompt).toHaveBeenCalledTimes(1);
    });
  });

  describe('dismiss()', () => {
    it('sets isDismissed=true in component state', () => {
      const { result } = renderHook(() => usePWAInstall());

      act(() => { result.current.dismiss(); });

      expect(result.current.isDismissed).toBe(true);
    });

    it('persists dismissal to localStorage via setItem', () => {
      const { result } = renderHook(() => usePWAInstall());

      act(() => { result.current.dismiss(); });

      expect(localStorageMock.setItem).toHaveBeenCalledWith(DISMISS_KEY, 'true');
    });

    it('is idempotent — calling dismiss() multiple times is safe', () => {
      const { result } = renderHook(() => usePWAInstall());

      act(() => {
        result.current.dismiss();
        result.current.dismiss();
      });

      expect(result.current.isDismissed).toBe(true);
    });
  });

  describe('appinstalled event', () => {
    it('sets isInstalled=true and canInstall=false when appinstalled fires', () => {
      const installPrompt = createInstallPromptEvent('accepted');
      const { result } = renderHook(() => usePWAInstall());

      // Prime the canInstall state
      act(() => { window.dispatchEvent(installPrompt); });
      expect(result.current.canInstall).toBe(true);

      act(() => { window.dispatchEvent(new Event('appinstalled')); });

      expect(result.current.isInstalled).toBe(true);
      expect(result.current.canInstall).toBe(false);
    });
  });

  describe('display-mode change (standalone media query)', () => {
    it('sets isInstalled=true when the display mode changes to standalone', () => {
      const { result } = renderHook(() => usePWAInstall());

      act(() => { mql._fireChange(true); });

      expect(result.current.isInstalled).toBe(true);
    });

    it('sets isInstalled=false when the display mode changes away from standalone', () => {
      mql = createStandaloneMql(true);
      vi.spyOn(window, 'matchMedia').mockImplementation(
        () => mql as unknown as MediaQueryList,
      );

      const { result } = renderHook(() => usePWAInstall());
      expect(result.current.isInstalled).toBe(true);

      act(() => { mql._fireChange(false); });

      expect(result.current.isInstalled).toBe(false);
    });
  });

  describe('event listener cleanup', () => {
    it('removes all event listeners on unmount', () => {
      const removeWindowSpy = vi.spyOn(window, 'removeEventListener');

      const { unmount } = renderHook(() => usePWAInstall());
      unmount();

      expect(removeWindowSpy).toHaveBeenCalledWith(
        'beforeinstallprompt',
        expect.any(Function),
      );
      expect(removeWindowSpy).toHaveBeenCalledWith(
        'appinstalled',
        expect.any(Function),
      );
    });

    it('removes the display-mode media query listener on unmount', () => {
      const { unmount } = renderHook(() => usePWAInstall());
      unmount();

      expect(mql.removeEventListener).toHaveBeenCalledWith(
        'change',
        expect.any(Function),
      );
    });
  });

  describe('localStorage error handling', () => {
    it('does not throw when localStorage.getItem throws (e.g., private browsing)', () => {
      localStorageMock.getItem.mockImplementation(() => {
        throw new Error('SecurityError: localStorage is not available');
      });

      // isDismissed should fall back to false
      expect(() => renderHook(() => usePWAInstall())).not.toThrow();
    });

    it('does not throw when localStorage.setItem throws during dismiss()', () => {
      localStorageMock.setItem.mockImplementation(() => {
        throw new Error('SecurityError: localStorage is not available');
      });

      const { result } = renderHook(() => usePWAInstall());

      expect(() => act(() => { result.current.dismiss(); })).not.toThrow();
      // In-memory state still updated even when localStorage fails
      expect(result.current.isDismissed).toBe(true);
    });
  });
});
