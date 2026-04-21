'use client';

/**
 * OptionPill — shared toggleable pill button used in the modal selectors.
 *
 * WHY extracted: The Period and Agent grids in the alert modal both
 * render the same orange-when-selected, zinc-when-not pill pattern.
 * Centralizing avoids drift if the design system updates the pill
 * styling.
 */

import type { ReactNode } from 'react';

interface OptionPillProps {
  /** Whether this pill represents the currently selected option. */
  isSelected: boolean;
  /** Click handler — called when the pill is activated. */
  onClick: () => void;
  /** Pill label content. */
  children: ReactNode;
  /** Additional classes appended to the base pill style. */
  className?: string;
}

/**
 * Renders a single selectable pill button.
 *
 * @param props - See {@link OptionPillProps}.
 */
export function OptionPill({
  isSelected,
  onClick,
  children,
  className = '',
}: OptionPillProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={isSelected}
      className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
        isSelected
          ? 'bg-orange-500 text-white'
          : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 border border-zinc-700'
      } ${className}`}
    >
      {children}
    </button>
  );
}
