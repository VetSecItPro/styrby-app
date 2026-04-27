'use client';

/**
 * ExportButton - Power-tier cost export dropdown.
 *
 * Renders a small "Export" dropdown button with "CSV" and "JSON" options.
 * When an option is selected, the component fetches the export endpoint and
 * triggers a browser file download without requiring a page navigation.
 *
 * WHY client component: We need onClick handlers and transient loading state.
 * The parent server component passes `isPowerTier` down so we avoid an extra
 * Supabase query inside this component.
 *
 * WHY fetch + blob + anchor: The export API streams a file response. Using
 * `window.location.href` would work for CSV but would break JSON (the browser
 * would render the JSON instead of saving it). The fetch-blob-anchor pattern
 * forces a download regardless of MIME type.
 */

import { useState, useRef, useEffect, useCallback } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ExportFormat = 'csv' | 'json';

/**
 * Props for the ExportButton component.
 */
interface ExportButtonProps {
  /**
   * Whether the current user is on the Power tier.
   * When false the button is rendered in a locked/disabled state.
   */
  isPowerTier: boolean;
  /**
   * Number of days of history to include in the export.
   * Defaults to 30. Should match the active time-range selection on the page.
   */
  days?: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * A dropdown "Export" button that downloads cost data as CSV or JSON.
 * Only functional for Power tier users.
 *
 * @param isPowerTier - Enables the button for Power users, shows upgrade prompt otherwise
 * @param days - Lookback window passed to the export API
 *
 * @example
 * <ExportButton isPowerTier={userTier === 'growth'} days={days} />
 */
export function ExportButton({ isPowerTier, days = 30 }: ExportButtonProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState<ExportFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  /**
   * Fetches the export endpoint and triggers a browser download.
   *
   * WHY: The API sets Content-Disposition: attachment for CSV but we want
   * consistent download behaviour for JSON too. Using fetch + blob + anchor
   * guarantees a download regardless of format or browser.
   *
   * @param format - 'csv' or 'json'
   */
  const handleExport = useCallback(
    async (format: ExportFormat) => {
      if (!isPowerTier || loading) return;

      setLoading(format);
      setError(null);
      setOpen(false);

      try {
        const params = new URLSearchParams({ format, days: String(days) });
        const res = await fetch(`/api/v1/costs/export?${params.toString()}`);

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const message =
            res.status === 403
              ? 'Upgrade to Power to export cost data.'
              : res.status === 429
                ? 'Rate limited. Try again later.'
                : (body as { message?: string }).message ?? 'Export failed.';
          setError(message);
          return;
        }

        const blob = await res.blob();
        const today = new Date().toISOString().split('T')[0];
        const filename = `styrby-costs-${today}.${format}`;

        // Create an ephemeral anchor element to trigger the download
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();

        // Cleanup after the browser has queued the download
        setTimeout(() => {
          document.body.removeChild(anchor);
          URL.revokeObjectURL(url);
        }, 100);
      } catch {
        setError('Network error. Could not download export.');
      } finally {
        setLoading(null);
      }
    },
    [isPowerTier, loading, days]
  );

  // ---------------------------------------------------------------------------
  // Locked state - shown to Free/Pro users
  // ---------------------------------------------------------------------------

  if (!isPowerTier) {
    return (
      <div className="relative inline-block">
        <button
          type="button"
          disabled
          title="Cost export requires Power plan"
          className="flex items-center gap-1.5 rounded-lg border border-border/40 px-3 py-1.5 text-xs font-medium text-muted-foreground/50 cursor-not-allowed select-none"
          aria-disabled="true"
        >
          {/* Download icon */}
          <svg
            className="h-3.5 w-3.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
            />
          </svg>
          Export
          {/* Lock icon */}
          <svg
            className="h-3 w-3 text-muted-foreground/40"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
            />
          </svg>
        </button>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Active state - Power users
  // ---------------------------------------------------------------------------

  const isExporting = loading !== null;

  return (
    <div className="relative inline-block" ref={dropdownRef}>
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={isExporting}
        aria-haspopup="true"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:border-border transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {isExporting ? (
          /* Spinner while exporting */
          <svg
            className="h-3.5 w-3.5 animate-spin"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" strokeWidth={2} className="opacity-25" />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 2a10 10 0 0110 10"
              className="opacity-75"
            />
          </svg>
        ) : (
          /* Download icon */
          <svg
            className="h-3.5 w-3.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
            />
          </svg>
        )}
        {isExporting ? `Exporting ${loading?.toUpperCase()}…` : 'Export'}
        {/* Chevron */}
        {!isExporting && (
          <svg
            className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 9l-7 7-7-7"
            />
          </svg>
        )}
      </button>

      {/* Dropdown menu */}
      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1 w-40 rounded-lg border border-border/60 bg-card shadow-lg py-1 z-10"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => handleExport('csv')}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-left text-foreground hover:bg-secondary/60 transition-colors"
          >
            {/* Spreadsheet icon */}
            <svg
              className="h-3.5 w-3.5 text-muted-foreground"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
              />
            </svg>
            Download CSV
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => handleExport('json')}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-left text-foreground hover:bg-secondary/60 transition-colors"
          >
            {/* Code/JSON icon */}
            <svg
              className="h-3.5 w-3.5 text-muted-foreground"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
              />
            </svg>
            Download JSON
          </button>
        </div>
      )}

      {/* Inline error message */}
      {error && (
        <p
          role="alert"
          className="absolute top-full right-0 mt-1 w-56 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500 z-10"
        >
          {error}
        </p>
      )}
    </div>
  );
}
