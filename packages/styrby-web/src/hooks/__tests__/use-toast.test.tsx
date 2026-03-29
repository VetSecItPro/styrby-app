/**
 * Tests for useToast hook and toast reducer
 *
 * WHY: The toast system is module-level singleton state. Tests must carefully
 * manage state between runs to avoid cross-test bleed. The reducer is a pure
 * function and is tested in isolation; the hook is tested with renderHook.
 *
 * @module hooks/__tests__/use-toast.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useToast, toast, reducer } from '../use-toast';
import type { ToastProps } from '@/components/ui/toast';

/** Minimum props required to create a toast */
type MinimalToast = Pick<ToastProps, 'title'> & {
  title?: React.ReactNode;
  description?: React.ReactNode;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Builds a minimal ToasterToast object for use in reducer tests.
 *
 * @param overrides - Optional field overrides
 * @returns A toast object suitable for passing to the reducer
 */
function makeToast(overrides: Partial<{ id: string; title: string; open: boolean }> = {}) {
  return {
    id: overrides.id ?? '1',
    title: overrides.title ?? 'Test toast',
    open: overrides.open ?? true,
  };
}

// ─── Reducer unit tests ──────────────────────────────────────────────────────

describe('reducer', () => {
  describe('ADD_TOAST', () => {
    it('adds a toast to an empty state', () => {
      const t = makeToast({ id: '1', title: 'Hello' });
      const nextState = reducer({ toasts: [] }, { type: 'ADD_TOAST', toast: t });

      expect(nextState.toasts).toHaveLength(1);
      expect(nextState.toasts[0].id).toBe('1');
      expect(nextState.toasts[0].title).toBe('Hello');
    });

    it('prepends the new toast (most recent first)', () => {
      const existing = makeToast({ id: '1', title: 'Old' });
      const incoming = makeToast({ id: '2', title: 'New' });

      const state = reducer({ toasts: [existing] }, { type: 'ADD_TOAST', toast: incoming });

      // Prepend means new toast is at index 0
      // But TOAST_LIMIT = 1, so existing gets dropped
      expect(state.toasts[0].id).toBe('2');
    });

    it('enforces TOAST_LIMIT of 1 — oldest toast is dropped when limit exceeded', () => {
      const first = makeToast({ id: '1', title: 'First' });
      const second = makeToast({ id: '2', title: 'Second' });

      // State with one toast already
      const state = reducer({ toasts: [first] }, { type: 'ADD_TOAST', toast: second });

      expect(state.toasts).toHaveLength(1);
      expect(state.toasts[0].id).toBe('2');
    });
  });

  describe('UPDATE_TOAST', () => {
    it('updates a toast by id', () => {
      const t = makeToast({ id: '1', title: 'Original' });
      const state = reducer(
        { toasts: [t] },
        { type: 'UPDATE_TOAST', toast: { id: '1', title: 'Updated' } },
      );

      expect(state.toasts[0].title).toBe('Updated');
    });

    it('leaves unrelated toasts unchanged', () => {
      const t1 = makeToast({ id: '1', title: 'First' });
      const t2 = makeToast({ id: '2', title: 'Second' });

      const state = reducer(
        { toasts: [t1, t2] },
        { type: 'UPDATE_TOAST', toast: { id: '1', title: 'Modified' } },
      );

      expect(state.toasts.find((t) => t.id === '2')?.title).toBe('Second');
    });

    it('is a no-op when the id does not match any toast', () => {
      const t = makeToast({ id: '1', title: 'Hello' });
      const state = reducer(
        { toasts: [t] },
        { type: 'UPDATE_TOAST', toast: { id: 'nonexistent', title: 'Ghost' } },
      );

      expect(state.toasts[0].title).toBe('Hello');
    });
  });

  describe('DISMISS_TOAST', () => {
    it('sets open=false on the specified toast', () => {
      const t = makeToast({ id: '1', open: true });
      const state = reducer({ toasts: [t] }, { type: 'DISMISS_TOAST', toastId: '1' });

      expect(state.toasts[0].open).toBe(false);
    });

    it('sets open=false on ALL toasts when toastId is undefined', () => {
      const t1 = makeToast({ id: '1', open: true });
      const t2 = makeToast({ id: '2', open: true });

      const state = reducer({ toasts: [t1, t2] }, { type: 'DISMISS_TOAST', toastId: undefined });

      expect(state.toasts.every((t) => t.open === false)).toBe(true);
    });

    it('does not remove the toast from the array (only closes it)', () => {
      const t = makeToast({ id: '1' });
      const state = reducer({ toasts: [t] }, { type: 'DISMISS_TOAST', toastId: '1' });

      expect(state.toasts).toHaveLength(1);
    });
  });

  describe('REMOVE_TOAST', () => {
    it('removes the toast with the given id', () => {
      const t = makeToast({ id: '1' });
      const state = reducer({ toasts: [t] }, { type: 'REMOVE_TOAST', toastId: '1' });

      expect(state.toasts).toHaveLength(0);
    });

    it('removes ALL toasts when toastId is undefined', () => {
      const t1 = makeToast({ id: '1' });
      const t2 = makeToast({ id: '2' });

      const state = reducer({ toasts: [t1, t2] }, { type: 'REMOVE_TOAST', toastId: undefined });

      expect(state.toasts).toHaveLength(0);
    });

    it('leaves other toasts intact when removing by specific id', () => {
      const t1 = makeToast({ id: '1' });
      const t2 = makeToast({ id: '2' });

      const state = reducer({ toasts: [t1, t2] }, { type: 'REMOVE_TOAST', toastId: '1' });

      expect(state.toasts).toHaveLength(1);
      expect(state.toasts[0].id).toBe('2');
    });
  });
});

// ─── useToast hook tests ─────────────────────────────────────────────────────

describe('useToast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Dismiss all toasts between tests to clear module-level singleton state
    const { result } = renderHook(() => useToast());
    act(() => {
      result.current.dismiss();
    });
    vi.runAllTimers();
    vi.useRealTimers();
  });

  describe('initial state', () => {
    it('returns an empty toasts array initially', () => {
      const { result } = renderHook(() => useToast());

      expect(result.current.toasts).toEqual([]);
    });

    it('exposes toast and dismiss functions', () => {
      const { result } = renderHook(() => useToast());

      expect(typeof result.current.toast).toBe('function');
      expect(typeof result.current.dismiss).toBe('function');
    });
  });

  describe('adding a toast via the hook', () => {
    it('adds a toast and makes it visible in the toasts array', () => {
      const { result } = renderHook(() => useToast());

      act(() => {
        result.current.toast({ title: 'Hello World' } as MinimalToast);
      });

      expect(result.current.toasts).toHaveLength(1);
      expect(result.current.toasts[0].title).toBe('Hello World');
    });

    it('sets open=true on the new toast', () => {
      const { result } = renderHook(() => useToast());

      act(() => {
        result.current.toast({ title: 'Test' } as MinimalToast);
      });

      expect(result.current.toasts[0].open).toBe(true);
    });

    it('assigns a unique id to the toast', () => {
      const { result } = renderHook(() => useToast());

      act(() => {
        result.current.toast({ title: 'First' } as MinimalToast);
      });

      const id = result.current.toasts[0].id;
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });
  });

  describe('dismissing via the hook', () => {
    it('sets open=false on a specific toast', () => {
      const { result } = renderHook(() => useToast());

      act(() => {
        result.current.toast({ title: 'Dismiss me' } as MinimalToast);
      });

      const { id } = result.current.toasts[0];

      act(() => {
        result.current.dismiss(id);
      });

      expect(result.current.toasts[0].open).toBe(false);
    });

    it('dismisses all toasts when called without an id', () => {
      const { result } = renderHook(() => useToast());

      act(() => {
        result.current.toast({ title: 'Toast 1' } as MinimalToast);
      });

      act(() => {
        result.current.dismiss();
      });

      expect(result.current.toasts.every((t) => t.open === false)).toBe(true);
    });
  });

  describe('standalone toast() function', () => {
    it('returns an object with id, dismiss, and update', () => {
      let ref: ReturnType<typeof toast> | undefined;

      act(() => {
        ref = toast({ title: 'Standalone' } as MinimalToast);
      });

      expect(typeof ref?.id).toBe('string');
      expect(typeof ref?.dismiss).toBe('function');
      expect(typeof ref?.update).toBe('function');
    });

    it('dismiss() on the returned handle closes the toast', () => {
      const { result } = renderHook(() => useToast());
      let handle: ReturnType<typeof toast> | undefined;

      act(() => {
        handle = result.current.toast({ title: 'Handle dismiss' } as MinimalToast);
      });

      act(() => {
        handle?.dismiss();
      });

      expect(result.current.toasts[0]?.open).toBe(false);
    });

    it('onOpenChange=false triggers dismiss', () => {
      const { result } = renderHook(() => useToast());

      act(() => {
        result.current.toast({ title: 'AutoDismiss' } as MinimalToast);
      });

      const onOpenChange = result.current.toasts[0].onOpenChange;

      act(() => {
        onOpenChange?.(false);
      });

      expect(result.current.toasts[0].open).toBe(false);
    });
  });
});
