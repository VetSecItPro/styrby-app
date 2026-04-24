'use client';

/**
 * VerifyChainButton — Client Component for triggering audit chain integrity verification.
 *
 * Purpose:
 *   Fetches `GET /api/admin/audit/verify` and renders the result inline:
 *   - Idle:      "Verify chain integrity" button
 *   - Loading:   "Checking..." spinner text
 *   - Pass:      "Chain OK (N rows)" — green checkmark
 *   - Fail:      "Chain broken at row <id>" — red X with status detail
 *   - Error:     "Verification failed" — generic error state
 *
 * Auth model:
 *   The verify endpoint is gated by middleware (T3) and by the server-side
 *   admin check inside the route handler. This component fetches without any
 *   special auth header — the session cookie is sent automatically by the browser.
 *   Non-admin users cannot reach this page (layout gate), and the endpoint
 *   returns 403 for non-admins as a belt-and-suspenders check.
 *   SOC 2 CC7.2: Audit log integrity monitoring surfaced in the admin UI.
 *
 * WHY "use client": the button needs onClick state (loading/result). A Server
 *   Component cannot hold interaction state. This is the minimal client island —
 *   only the button and its result display are client-rendered; the entire table
 *   and page remain server-rendered.
 *
 * @module components/admin/VerifyChainButton
 */

import { useState } from 'react';
import { CheckCircle, XCircle, Loader2, ShieldCheck } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Possible UI states for the verify button.
 *
 * WHY explicit union over boolean flags: a union makes exhaustive rendering
 * checks possible (TypeScript narrows on `state.kind`) and prevents invalid
 * combinations like `{ loading: true, passed: true }`.
 */
type VerifyState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'pass'; totalRows: number }
  | { kind: 'fail'; status: string; firstBrokenId: number | null; totalRows: number }
  | { kind: 'error' };

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Interactive button that calls the audit chain verify endpoint and displays
 * the result inline without a page navigation.
 *
 * WHY fetch() not a Link: the verify endpoint returns JSON, not a page. We
 * want to display the result in-place rather than navigating to a new route.
 * A client-side fetch + useState pattern is the correct choice for this one
 * interactive element on an otherwise fully server-rendered page.
 */
export function VerifyChainButton() {
  const [state, setState] = useState<VerifyState>({ kind: 'idle' });

  /**
   * Fetches the verify endpoint and updates component state with the result.
   *
   * WHY no error thrown to boundary: a fetch failure (network, 500) is a
   * user-visible ops concern, not an application crash. We render a friendly
   * error state inline rather than unmounting the entire page via an error
   * boundary. The API route captures the underlying error via Sentry.
   */
  async function handleVerify(): Promise<void> {
    setState({ kind: 'loading' });

    try {
      const res = await fetch('/api/admin/audit/verify');

      if (!res.ok) {
        setState({ kind: 'error' });
        return;
      }

      // WHY type assertion: the API contract guarantees AuditVerifyResult shape.
      // A schema mismatch would cause incorrect display (not a crash) and would
      // be caught by the API-level tests.
      const data = (await res.json()) as {
        status: 'ok' | 'prev_hash_mismatch' | 'row_hash_mismatch';
        first_broken_id: number | null;
        total_rows: number;
      };

      if (data.status === 'ok') {
        setState({ kind: 'pass', totalRows: data.total_rows });
      } else {
        setState({
          kind: 'fail',
          status: data.status,
          firstBrokenId: data.first_broken_id,
          totalRows: data.total_rows,
        });
      }
    } catch {
      // WHY catch-all: network errors, JSON parse failures, etc. all result in
      // the same 'error' UI state. The user gets actionable feedback (something
      // is wrong) without a cryptic stack trace. Sentry captures the error at
      // the API layer if it originated server-side.
      setState({ kind: 'error' });
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div
      className="flex items-center gap-3"
      data-testid="verify-chain-container"
    >
      {/* Button — always rendered so the user can re-run after seeing a result */}
      <button
        onClick={handleVerify}
        disabled={state.kind === 'loading'}
        className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
        aria-busy={state.kind === 'loading'}
        data-testid="verify-chain-button"
      >
        <ShieldCheck className="h-4 w-4" aria-hidden="true" />
        {state.kind === 'loading' ? 'Checking...' : 'Verify chain integrity'}
      </button>

      {/* Result display — conditionally rendered based on state */}

      {state.kind === 'loading' && (
        <span
          className="inline-flex items-center gap-1.5 text-sm text-zinc-400"
          data-testid="verify-chain-loading"
          aria-live="polite"
        >
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Checking...
        </span>
      )}

      {state.kind === 'pass' && (
        <span
          className="inline-flex items-center gap-1.5 text-sm text-green-400"
          data-testid="verify-chain-pass"
          aria-live="polite"
        >
          <CheckCircle className="h-4 w-4" aria-hidden="true" />
          {/* WHY checkmark before text: screen readers still announce the full
              sentence. The icon is decorative (aria-hidden). */}
          Chain OK ({state.totalRows} rows)
        </span>
      )}

      {state.kind === 'fail' && (
        <span
          className="inline-flex items-center gap-1.5 text-sm text-red-400"
          data-testid="verify-chain-fail"
          aria-live="polite"
        >
          <XCircle className="h-4 w-4" aria-hidden="true" />
          {/* WHY include status: 'prev_hash_mismatch' vs 'row_hash_mismatch'
              distinguishes chain link deletion/insertion from row tampering.
              An ops admin needs this to determine what kind of incident occurred.
              SOC 2 CC7.2: tamper-evidence detail aids forensic investigation. */}
          Chain broken
          {state.firstBrokenId !== null ? ` at row ${state.firstBrokenId}` : ''}
          {` (${state.status})`}
        </span>
      )}

      {state.kind === 'error' && (
        <span
          className="inline-flex items-center gap-1.5 text-sm text-zinc-400"
          data-testid="verify-chain-error"
          aria-live="polite"
        >
          <XCircle className="h-4 w-4" aria-hidden="true" />
          Verification failed - check server logs
        </span>
      )}
    </div>
  );
}
