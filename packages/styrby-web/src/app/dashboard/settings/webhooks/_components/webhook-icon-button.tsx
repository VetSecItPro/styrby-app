/**
 * WebhookIconButton
 *
 * A small icon-only button used by the action row on every webhook card.
 *
 * WHY a primitive: Each card has 4 nearly-identical action buttons (test,
 * deliveries, edit, delete). Extracting a primitive prevents copy-paste
 * drift in their styling and aria handling.
 */

import type { ReactNode } from 'react';

interface WebhookIconButtonProps {
  /** Icon content (an SVG). */
  children: ReactNode;
  /** Click handler. */
  onClick: () => void;
  /** Accessible label for screen readers. */
  ariaLabel: string;
  /** Optional native title (tooltip on hover). */
  title?: string;
  /** Disable the button (e.g., while a request is in flight). */
  disabled?: boolean;
  /**
   * Visual variant. `danger` highlights the button red on hover, used by
   * the delete action.
   */
  variant?: 'default' | 'danger';
}

/**
 * Small icon button used in webhook card action rows.
 *
 * Centralises padding, hover, and disabled styling so all four buttons in
 * a card stay visually consistent.
 */
export function WebhookIconButton({
  children,
  onClick,
  ariaLabel,
  title,
  disabled,
  variant = 'default',
}: WebhookIconButtonProps) {
  const hoverClasses =
    variant === 'danger'
      ? 'hover:text-red-400 hover:bg-red-500/10'
      : 'hover:text-zinc-300 hover:bg-zinc-800';

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`p-1.5 rounded-lg text-zinc-500 transition-colors disabled:opacity-50 ${hoverClasses}`}
      aria-label={ariaLabel}
      title={title}
    >
      {children}
    </button>
  );
}
