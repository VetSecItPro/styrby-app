'use client';

/**
 * Export Section — GDPR Art. 15 Subject Access Request / Art. 20 Data Portability
 *
 * Lets the user download all their data as a JSON file. One request per hour
 * (rate limited server-side). Shows the last export timestamp so users can
 * track when they last downloaded a copy.
 *
 * WHY JSON not ZIP:
 *   The current export endpoint (POST /api/account/export) streams JSON directly.
 *   A ZIP bundle with a README (as spec'd in Phase 1.6.9) is the next iteration
 *   once the export-user-data edge function is deployed. The JSON export is
 *   already GDPR-compliant for Art. 15/20; the ZIP just improves UX.
 *
 * GDPR Art. 15  — Subject Access Request (SAR) self-service
 * GDPR Art. 20  — Right to data portability
 */

import { useCallback, useState } from 'react';
import { Download } from 'lucide-react';

/** Props for {@link ExportSection}. */
export interface ExportSectionProps {
  /** ISO timestamp of the last successful export, or null if never. */
  lastExportedAt: string | null;
}

/**
 * Renders the data export panel with the last-exported timestamp.
 *
 * @param props - Server-pre-fetched export history
 */
export function ExportSection({ lastExportedAt }: ExportSectionProps) {
  const [isExporting, setIsExporting] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  /** Format a date string for display. Returns empty string for null. */
  const formatDate = (iso: string | null): string => {
    if (!iso) return '';
    try {
      return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date(iso));
    } catch {
      return iso;
    }
  };

  /**
   * Request a data export and trigger a browser download.
   *
   * WHY POST not GET: the export is expensive, writes an audit_log row,
   * and should not be cached or prefetched by the browser or CDN.
   */
  const handleExport = useCallback(async () => {
    setIsExporting(true);
    setMessage(null);

    try {
      const response = await fetch('/api/account/export', { method: 'POST' });

      if (response.status === 429) {
        const data = await response.json();
        setMessage({
          type: 'error',
          text: `Rate limited. You can export once per hour. Try again in ${Math.ceil((data.retryAfter ?? 3600) / 60)} minutes.`,
        });
        return;
      }

      if (!response.ok) {
        const data = await response.json();
        setMessage({ type: 'error', text: data.error ?? 'Export failed. Please try again.' });
        return;
      }

      // Trigger browser download
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download =
        response.headers.get('Content-Disposition')?.match(/filename="(.+)"/)?.[1] ??
        'styrby-data-export.json';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);

      setMessage({
        type: 'success',
        text: 'Your data has been exported. Check your downloads folder.',
      });
    } catch {
      setMessage({ type: 'error', text: 'Network error. Please try again.' });
    } finally {
      setIsExporting(false);
    }
  }, []);

  return (
    <section className="rounded-xl bg-zinc-900 border border-zinc-800">
      <div className="px-6 py-4 border-b border-zinc-800 flex items-center gap-3">
        <Download className="h-4 w-4 text-green-400" aria-hidden />
        <h2 className="text-base font-semibold text-zinc-100">Export Your Data</h2>
        <span className="ml-auto text-xs text-zinc-500">GDPR Art. 15 / Art. 20</span>
      </div>

      <div className="px-6 py-4">
        <p className="text-sm text-zinc-400 mb-1">
          Download a complete copy of your Styrby data - sessions, messages, configurations,
          billing history, and audit logs. This is your right under GDPR Article 15
          (Subject Access Request) and Article 20 (Data Portability).
        </p>
        <p className="text-xs text-zinc-500 mb-4">
          The export contains all your data in JSON format. Message content is included
          in encrypted form - only your device can decrypt it.
        </p>

        {lastExportedAt && (
          <p className="text-xs text-zinc-500 mb-3">
            Last exported: {formatDate(lastExportedAt)}
          </p>
        )}

        <button
          type="button"
          onClick={handleExport}
          disabled={isExporting}
          className="flex items-center gap-2 rounded-lg bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-100 hover:bg-zinc-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <Download className="h-4 w-4" aria-hidden />
          {isExporting ? 'Preparing export...' : 'Export My Data'}
        </button>

        {message && (
          <p
            role="status"
            className={`mt-3 text-sm ${message.type === 'success' ? 'text-green-400' : 'text-red-400'}`}
          >
            {message.text}
          </p>
        )}
      </div>
    </section>
  );
}
