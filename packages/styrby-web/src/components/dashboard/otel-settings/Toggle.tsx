/**
 * Toggle — accessible on/off switch.
 *
 * Extracted from otel-settings.tsx (Cluster A2 split).
 *
 * @module components/dashboard/otel-settings/Toggle
 */

/**
 * Simple accessible toggle switch.
 *
 * @param checked - Whether the toggle is on.
 * @param onChange - Callback when toggled.
 * @param disabled - Whether the toggle is disabled.
 * @param label - Accessible label for screen readers.
 */
export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed ${
        checked ? 'bg-emerald-500' : 'bg-zinc-700'
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-[18px]' : 'translate-x-1'
        }`}
      />
    </button>
  );
}
