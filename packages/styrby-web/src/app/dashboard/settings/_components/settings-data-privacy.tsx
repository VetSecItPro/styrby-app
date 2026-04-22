'use client';

/**
 * Settings - Data & Privacy Section
 *
 * Summary card that links to the dedicated Privacy Control Center
 * (/dashboard/privacy) for full GDPR controls. Also provides an inline
 * quick-export button for the common case.
 *
 * WHY a link + inline-export (not full controls here):
 *   The Privacy Control Center has retention pickers, data maps, and the
 *   2-step deletion flow. Embedding all that in the settings page would
 *   violate the 400-LOC per-file limit. The settings section is a
 *   summary/entry-point; the full controls live at /dashboard/privacy.
 *
 * GDPR Art. 15 — Subject Access Request (export)
 * GDPR Art. 17 — Right to Erasure (linked from here)
 * GDPR Art. 5(1)(e) — Storage limitation (retention, linked)
 */

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { Shield, ChevronRight } from 'lucide-react';
import type { InlineMessage } from './types';

/**
 * Data & Privacy section: quick export + link to full privacy controls.
 *
 * WHY keep the quick export here: users in the settings flow expect to
 * find export in settings. The link to /dashboard/privacy provides access
 * to retention and deletion without requiring navigation to a separate page.
 */
export function SettingsDataPrivacy() {
  const [exportLoading, setExportLoading] = useState(false);
  const [exportMessage, setExportMessage] = useState<InlineMessage>(null);

  /**
   * Export the user's data as a JSON download (GDPR Article 20 portability).
   *
   * Handles three failure modes distinctly: rate-limit (429), server error
   * (non-ok), and network error (catch). Each surfaces a different message.
   */
  const handleExportData = useCallback(async () => {
    setExportLoading(true);
    setExportMessage(null);
    try {
      const response = await fetch('/api/account/export', { method: 'POST' });
      if (response.status === 429) {
        const data = await response.json();
        setExportMessage({
          type: 'error',
          text: `Rate limited. Try again in ${Math.ceil(data.retryAfter / 60)} minutes.`,
        });
        return;
      }
      if (!response.ok) {
        const data = await response.json();
        setExportMessage({ type: 'error', text: data.error || 'Failed to export data' });
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download =
        response.headers.get('Content-Disposition')?.match(/filename="(.+)"/)?.[1] ||
        'styrby-data-export.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setExportMessage({ type: 'success', text: 'Your data has been downloaded.' });
    } catch {
      setExportMessage({
        type: 'error',
        text: 'Failed to export data. Please try again.',
      });
    } finally {
      setExportLoading(false);
    }
  }, []);

  return (
    <section className="mb-8">
      <h2 className="text-lg font-semibold text-zinc-100 mb-4">Data & Privacy</h2>
      <div className="rounded-xl bg-zinc-900 border border-zinc-800 divide-y divide-zinc-800">

        {/* Quick export row */}
        <div className="px-4 py-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-zinc-100">Export Your Data</p>
              <p className="text-sm text-zinc-500">
                Download all your data in JSON format (GDPR Art. 15)
              </p>
            </div>
            <button
              onClick={handleExportData}
              disabled={exportLoading}
              className="rounded-lg bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-100 hover:bg-zinc-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              aria-label="Export your data"
            >
              {exportLoading ? 'Exporting...' : 'Export Data'}
            </button>
          </div>
          {exportMessage && (
            <p
              role="status"
              className={`mt-2 text-sm ${
                exportMessage.type === 'success' ? 'text-green-400' : 'text-red-400'
              }`}
            >
              {exportMessage.text}
            </p>
          )}
        </div>

        {/* Privacy Control Center link */}
        <Link
          href="/dashboard/privacy"
          className="flex items-center justify-between px-4 py-4 hover:bg-zinc-800/50 transition-colors group"
          aria-label="Open Privacy Control Center - retention settings, data map, and account deletion"
        >
          <div className="flex items-center gap-3">
            <Shield className="h-4 w-4 text-blue-400" aria-hidden />
            <div>
              <p className="text-sm font-medium text-zinc-100">Privacy Control Center</p>
              <p className="text-sm text-zinc-500">
                Retention policy, data map, encryption details, account deletion
              </p>
            </div>
          </div>
          <ChevronRight className="h-4 w-4 text-zinc-500 group-hover:text-zinc-300 transition-colors" aria-hidden />
        </Link>

      </div>
    </section>
  );
}
