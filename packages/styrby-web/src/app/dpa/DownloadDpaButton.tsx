/**
 * DownloadDpaButton — Client Component
 *
 * Purpose: Provides a "Download PDF" button that triggers the browser's
 * native print dialog, allowing users to save the DPA as a PDF via
 * "Save as PDF" in their print destination.
 *
 * WHY browser print-to-PDF instead of a server-generated PDF:
 *   - Zero new dependencies (no pdf-lib, puppeteer, etc.)
 *   - Works on all browsers (Chrome, Safari, Firefox) without additional infra
 *   - The DPA page content is already beautifully formatted HTML — the browser
 *     renders it perfectly as a PDF via the print pipeline
 *   - @media print styles on the DPA page suppress navigation chrome and
 *     the button itself, producing a clean single-column PDF
 *   - This is the spec-approved approach (Phase 4.4 §4.4 Option C)
 *
 * The button carries data-print-hide so the @media print CSS rule
 * (defined in the DPA page's print style block) hides it in the printed PDF.
 *
 * Operational context:
 *   Enterprise customers who need a countersigned DPA can print this page
 *   to PDF, sign it digitally, and return it via email. This matches the
 *   workflow described in DPA Section 9 (Contact).
 */

'use client';

import { Printer } from 'lucide-react';

/**
 * A button that triggers window.print() to allow saving the DPA as a PDF.
 *
 * @returns A client-side print trigger button, hidden in print output.
 */
export function DownloadDpaButton() {
  return (
    <div data-print-hide className="flex flex-col items-end">
      <button
        type="button"
        aria-label="Open print dialog to save this DPA as a PDF"
        onClick={() => window.print()}
        className="inline-flex items-center gap-2 rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-orange-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-600 transition-colors"
      >
        <Printer className="h-4 w-4" aria-hidden="true" />
        Print or Save as PDF
      </button>
      <p className="text-xs text-muted-foreground mt-2">
        Opens your browser&apos;s print dialog. Choose &quot;Save as PDF&quot; as the destination.
      </p>
    </div>
  );
}
