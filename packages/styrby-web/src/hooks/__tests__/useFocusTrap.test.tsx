/**
 * Tests for useFocusTrap hook
 *
 * WHY: Focus trapping is required for WCAG 2.1.2 compliance on modal dialogs.
 * These tests verify that Tab/Shift+Tab navigation wraps correctly, that the
 * Escape key fires the provided callback, that focus is restored on close,
 * and that no event listeners leak after unmount.
 *
 * Implementation note: useFocusTrap uses a ref that must be attached to a real
 * DOM element before the effect runs. We use render() with a real component
 * rather than renderHook(), which gives the hook a live container to operate on.
 *
 * @module hooks/__tests__/useFocusTrap.test
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { useFocusTrap } from '../useFocusTrap';

// ─── Test component helpers ───────────────────────────────────────────────────

interface TrapProps {
  isActive: boolean;
  onEscape?: () => void;
  buttonCount?: number;
}

/**
 * A minimal component that exercises useFocusTrap with real DOM elements.
 * Renders a container div with the ref attached and N focusable buttons inside.
 */
function FocusTrapFixture({ isActive, onEscape, buttonCount = 3 }: TrapProps) {
  const ref = useFocusTrap<HTMLDivElement>(isActive, onEscape);

  return (
    <div ref={ref} data-testid="trap-container">
      {Array.from({ length: buttonCount }, (_, i) => (
        <button key={i} data-testid={`btn-${i}`}>
          Button {i + 1}
        </button>
      ))}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Dispatches a KeyboardEvent on the document.
 *
 * @param key - The key name (e.g., 'Tab', 'Escape')
 * @param shiftKey - Whether Shift is held
 * @returns The dispatched event (so callers can check defaultPrevented)
 */
function pressKey(key: string, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(event);
  return event;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('useFocusTrap', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('inactive trap (isActive=false)', () => {
    it('does not call onEscape when the trap is inactive and Escape is pressed', () => {
      const onEscape = vi.fn();
      render(<FocusTrapFixture isActive={false} onEscape={onEscape} />);

      pressKey('Escape');

      expect(onEscape).not.toHaveBeenCalled();
    });

    it('does not wrap Tab focus when the trap is inactive', () => {
      const { getByTestId } = render(<FocusTrapFixture isActive={false} />);

      const lastBtn = getByTestId('btn-2') as HTMLButtonElement;
      lastBtn.focus();

      const event = pressKey('Tab');

      // When inactive the hook does not install a keydown listener — no wrapping
      expect(event.defaultPrevented).toBe(false);
    });
  });

  describe('active trap — initial focus', () => {
    it('moves focus to the first focusable element when activated', () => {
      const { getByTestId } = render(<FocusTrapFixture isActive={true} />);

      const firstBtn = getByTestId('btn-0');
      expect(document.activeElement).toBe(firstBtn);
    });

    it('does not throw when there are no focusable elements', () => {
      // Render with zero buttons — no focusable children
      expect(() => render(<FocusTrapFixture isActive={true} buttonCount={0} />)).not.toThrow();
    });
  });

  describe('Escape key', () => {
    it('calls onEscape when Escape is pressed and the trap is active', () => {
      const onEscape = vi.fn();
      render(<FocusTrapFixture isActive={true} onEscape={onEscape} />);

      act(() => { pressKey('Escape'); });

      expect(onEscape).toHaveBeenCalledTimes(1);
    });

    it('prevents the default action on Escape keydown', () => {
      const onEscape = vi.fn();
      render(<FocusTrapFixture isActive={true} onEscape={onEscape} />);

      const event = pressKey('Escape');

      expect(event.defaultPrevented).toBe(true);
    });

    it('does not throw when no onEscape callback is provided', () => {
      render(<FocusTrapFixture isActive={true} />);

      expect(() => pressKey('Escape')).not.toThrow();
    });
  });

  describe('Tab key wrapping', () => {
    it('wraps forward to the first element when Tab is pressed on the last element', () => {
      const { getByTestId } = render(<FocusTrapFixture isActive={true} />);

      const firstBtn = getByTestId('btn-0') as HTMLButtonElement;
      const lastBtn = getByTestId('btn-2') as HTMLButtonElement;
      const focusSpy = vi.spyOn(firstBtn, 'focus');

      // Move focus to the last button
      lastBtn.focus();

      const event = pressKey('Tab');

      expect(event.defaultPrevented).toBe(true);
      expect(focusSpy).toHaveBeenCalled();
    });

    it('does not wrap when Tab is pressed on a non-last element', () => {
      const { getByTestId } = render(<FocusTrapFixture isActive={true} />);

      const middleBtn = getByTestId('btn-1') as HTMLButtonElement;
      const firstFocusSpy = vi.spyOn(getByTestId('btn-0') as HTMLButtonElement, 'focus');
      const lastFocusSpy = vi.spyOn(getByTestId('btn-2') as HTMLButtonElement, 'focus');

      middleBtn.focus();
      const event = pressKey('Tab');

      expect(event.defaultPrevented).toBe(false);
      // Neither wrap should have happened
      expect(firstFocusSpy).not.toHaveBeenCalled();
      expect(lastFocusSpy).not.toHaveBeenCalled();
    });

    it('wraps backward to the last element when Shift+Tab is pressed on the first element', () => {
      const { getByTestId } = render(<FocusTrapFixture isActive={true} />);

      const firstBtn = getByTestId('btn-0') as HTMLButtonElement;
      const lastBtn = getByTestId('btn-2') as HTMLButtonElement;
      const lastFocusSpy = vi.spyOn(lastBtn, 'focus');

      firstBtn.focus();

      const event = pressKey('Tab', /* shiftKey */ true);

      expect(event.defaultPrevented).toBe(true);
      expect(lastFocusSpy).toHaveBeenCalled();
    });

    it('does not wrap backward when Shift+Tab is pressed on a non-first element', () => {
      const { getByTestId } = render(<FocusTrapFixture isActive={true} />);

      const middleBtn = getByTestId('btn-1') as HTMLButtonElement;
      const lastFocusSpy = vi.spyOn(getByTestId('btn-2') as HTMLButtonElement, 'focus');

      middleBtn.focus();
      const event = pressKey('Tab', /* shiftKey */ true);

      expect(event.defaultPrevented).toBe(false);
      expect(lastFocusSpy).not.toHaveBeenCalled();
    });
  });

  describe('focus restoration', () => {
    it('restores focus to the previously focused element when the trap unmounts', () => {
      const outsideButton = document.createElement('button');
      document.body.appendChild(outsideButton);
      outsideButton.focus();

      const focusRestoreSpy = vi.spyOn(outsideButton, 'focus');

      const { unmount } = render(<FocusTrapFixture isActive={true} />);
      unmount();

      expect(focusRestoreSpy).toHaveBeenCalled();
      document.body.removeChild(outsideButton);
    });
  });

  describe('event listener cleanup', () => {
    it('removes the keydown listener when the component unmounts', () => {
      const removeSpy = vi.spyOn(document, 'removeEventListener');
      const onEscape = vi.fn();

      const { unmount } = render(<FocusTrapFixture isActive={true} onEscape={onEscape} />);
      unmount();

      expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
    });

    it('removes the listener when isActive transitions from true to false', () => {
      const removeSpy = vi.spyOn(document, 'removeEventListener');

      const { rerender } = render(<FocusTrapFixture isActive={true} />);
      rerender(<FocusTrapFixture isActive={false} />);

      expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
    });

    it('does not respond to keyboard events after unmount', () => {
      const onEscape = vi.fn();
      const { unmount } = render(<FocusTrapFixture isActive={true} onEscape={onEscape} />);

      unmount();
      pressKey('Escape');

      expect(onEscape).not.toHaveBeenCalled();
    });
  });

  describe('transition from inactive to active', () => {
    it('starts trapping focus after isActive changes from false to true', () => {
      const onEscape = vi.fn();
      const { rerender } = render(<FocusTrapFixture isActive={false} onEscape={onEscape} />);

      pressKey('Escape');
      expect(onEscape).not.toHaveBeenCalled();

      rerender(<FocusTrapFixture isActive={true} onEscape={onEscape} />);
      pressKey('Escape');

      expect(onEscape).toHaveBeenCalledTimes(1);
    });
  });
});
