/**
 * SettingRow — labelled form row with optional description + error.
 *
 * Extracted from otel-settings.tsx (Cluster A2 split).
 *
 * @module components/dashboard/otel-settings/SettingRow
 */

/**
 * Render a settings row with a label, description, and interactive control.
 *
 * @param label - Setting name.
 * @param description - Short explanation.
 * @param error - Validation error to display below the control.
 * @param children - The form control (input, toggle, etc.).
 */
export function SettingRow({
  label,
  description,
  error,
  children,
}: {
  label: string;
  description?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium text-foreground">{label}</label>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
      {children}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
