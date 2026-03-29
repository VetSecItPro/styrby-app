/**
 * Tests for useIsMobile hook
 *
 * WHY: Verifies that the hook correctly reads the window.innerWidth against
 * the 768px mobile breakpoint and responds to matchMedia change events.
 * jsdom's window.innerWidth defaults to 0, which is below the breakpoint,
 * so tests that need desktop-sized must set it explicitly.
 *
 * @module hooks/__tests__/use-mobile.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useIsMobile } from '../use-mobile';

/** The mobile breakpoint in pixels (must match the hook implementation). */
const MOBILE_BREAKPOINT = 768;

/**
 * Creates a mock MediaQueryList that can fire change events.
 *
 * @param matches - Initial match state for the media query
 * @returns A mock implementing the MediaQueryList interface
 */
function createMockMql(matches: boolean) {
  const listeners: Array<(e: MediaQueryListEvent) => void> = [];

  const mql = {
    matches,
    media: `(max-width: ${MOBILE_BREAKPOINT - 1}px)`,
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
    /** Fire a simulated change event on all registered listeners. */
    _fireChange: (newWidth: number) => {
      const event = { matches: newWidth < MOBILE_BREAKPOINT } as MediaQueryListEvent;
      listeners.forEach((l) => l(event));
    },
  };

  return mql;
}

describe('useIsMobile', () => {
  let mockMql: ReturnType<typeof createMockMql>;

  beforeEach(() => {
    mockMql = createMockMql(false);
    vi.spyOn(window, 'matchMedia').mockImplementation(() => mockMql as unknown as MediaQueryList);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('initial state — mobile width', () => {
    it('returns true when window.innerWidth is below the breakpoint', () => {
      Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 375 });

      const { result } = renderHook(() => useIsMobile());

      expect(result.current).toBe(true);
    });

    it('returns true when window.innerWidth equals breakpoint minus one', () => {
      Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: MOBILE_BREAKPOINT - 1 });

      const { result } = renderHook(() => useIsMobile());

      expect(result.current).toBe(true);
    });
  });

  describe('initial state — desktop width', () => {
    it('returns false when window.innerWidth equals the breakpoint exactly', () => {
      Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: MOBILE_BREAKPOINT });

      const { result } = renderHook(() => useIsMobile());

      expect(result.current).toBe(false);
    });

    it('returns false when window.innerWidth is above the breakpoint', () => {
      Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1440 });

      const { result } = renderHook(() => useIsMobile());

      expect(result.current).toBe(false);
    });
  });

  describe('responds to matchMedia change events', () => {
    it('updates to true when a change event fires with a mobile width', () => {
      Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1440 });

      const { result } = renderHook(() => useIsMobile());
      expect(result.current).toBe(false);

      // Simulate the viewport shrinking below the breakpoint
      act(() => {
        Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 375 });
        mockMql._fireChange(375);
      });

      expect(result.current).toBe(true);
    });

    it('updates to false when a change event fires with a desktop width', () => {
      Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 375 });

      const { result } = renderHook(() => useIsMobile());
      expect(result.current).toBe(true);

      // Simulate the viewport growing above the breakpoint
      act(() => {
        Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1024 });
        mockMql._fireChange(1024);
      });

      expect(result.current).toBe(false);
    });
  });

  describe('event listener lifecycle', () => {
    it('registers a change listener on the matchMedia object', () => {
      Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1440 });
      renderHook(() => useIsMobile());

      expect(mockMql.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    });

    it('removes the change listener when the component unmounts', () => {
      Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1440 });
      const { unmount } = renderHook(() => useIsMobile());

      unmount();

      expect(mockMql.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    });

    it('uses the correct media query string', () => {
      renderHook(() => useIsMobile());

      expect(window.matchMedia).toHaveBeenCalledWith(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    });
  });

  describe('return type guarantee', () => {
    it('always returns a boolean — never undefined', () => {
      Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 375 });
      const { result } = renderHook(() => useIsMobile());

      // The hook coerces the internal state (boolean | undefined) to boolean via !!
      expect(typeof result.current).toBe('boolean');
    });
  });
});
