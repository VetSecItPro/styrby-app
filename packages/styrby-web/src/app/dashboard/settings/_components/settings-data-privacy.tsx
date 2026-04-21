'use client';

import { useCallback, useState } from 'react';
import type { InlineMessage } from './types';

/**
 * Data & Privacy section: GDPR export-your-data.
 *
 * WHY a dedicated section even for one row: we will add "Request deletion
 * log", "Consent history", and "Third-party data shares" here in the
 * compliance pass without touching the orchestrator.
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
        <div className="px-4 py-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-zinc-100">Export Your Data</p>
              <p className="text-sm text-zinc-500">
                Download all your data in JSON format (GDPR)
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
              className={`mt-2 text-sm ${
                exportMessage.type === 'success' ? 'text-green-400' : 'text-red-400'
              }`}
            >
              {exportMessage.text}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
