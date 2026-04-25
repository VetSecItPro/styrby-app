/**
 * Tests for the support-access success page (server component).
 *
 * Phase 4.2 — Support Tooling T4
 * Added 2026-04-25 — SEC-ADV-001 remediation. Validates the server-side token
 * pickup architecture that replaced the previous non-HttpOnly cookie channel.
 *
 * Coverage:
 *   (a) Happy path — RPC returns the raw token; page renders TokenDisplay.
 *   (b) RPC raises 22023 — renders "expired or already consumed" fallback.
 *   (c) RPC raises 42501 — renders "unauthorized" fallback.
 *   (d) Missing grant id in URL — renders "missing grant id" fallback.
 *   (e) Non-numeric grant id in URL — same fallback as missing.
 *   (f) RPC returns empty string with no error — treated as expired (defensive).
 *
 * Strategy:
 *   - Mock @/lib/supabase/server createClient to expose a mockRpc.
 *   - Mock TokenDisplay so we can verify the rawToken prop without rendering
 *     the full interactive subtree.
 *   - Render the async server component and inspect the resulting React tree
 *     via renderToStaticMarkup (no DOM events needed).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// ─── Supabase mock ────────────────────────────────────────────────────────────

const mockRpc = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}));

import { createClient } from '@/lib/supabase/server';
import type { Mock } from 'vitest';

// ─── TokenDisplay mock ────────────────────────────────────────────────────────

// We render a tiny stub so we can detect whether the page handed a token to
// the interactive subtree. The real TokenDisplay is exercised via direct
// component tests if needed; here we verify only the data flow.
vi.mock('../TokenDisplay', () => ({
  TokenDisplay: ({ rawToken }: { rawToken: string }) => (
    <div data-testid="token-display-stub">TOKEN:{rawToken}</div>
  ),
}));

import RequestAccessSuccessPage from '../page';

const TICKET_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const GRANT_ID = '42';
const RAW_TOKEN = 'raw-base64url-token-43chars-aabbccdd1122334455667';

describe('RequestAccessSuccessPage (server component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (createClient as Mock).mockResolvedValue({ rpc: mockRpc });
  });

  /**
   * Helper: render the async server component to static HTML.
   *
   * Server components return Promises in React 19 / Next 15. We await the
   * component invocation directly and feed the resulting element to
   * renderToStaticMarkup.
   */
  async function renderPage(opts: {
    grant?: string;
  }): Promise<string> {
    const element = await RequestAccessSuccessPage({
      params: Promise.resolve({ id: TICKET_ID }),
      searchParams: Promise.resolve({ grant: opts.grant }),
    });
    return renderToStaticMarkup(element as React.ReactElement);
  }

  // ── (a) Happy path ─────────────────────────────────────────────────────────

  it('(a) renders TokenDisplay with the raw token when pickup RPC returns it', async () => {
    mockRpc.mockResolvedValueOnce({ data: RAW_TOKEN, error: null });

    const html = await renderPage({ grant: GRANT_ID });

    expect(html).toContain(`TOKEN:${RAW_TOKEN}`);
    expect(html).not.toContain('Token is no longer available');
    // RPC must have been called with the parsed numeric grant id.
    expect(mockRpc).toHaveBeenCalledWith('admin_pickup_grant_token', {
      p_grant_id: 42,
    });
  });

  // ── (b) Expired / already-consumed ─────────────────────────────────────────

  it('(b) renders the "expired or already consumed" fallback when RPC raises 22023', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: '22023', message: 'token expired or already consumed' },
    });

    const html = await renderPage({ grant: GRANT_ID });

    expect(html).not.toContain('TOKEN:');
    expect(html).toContain('Token is no longer available');
  });

  // ── (c) Unauthorized ──────────────────────────────────────────────────────

  it('(c) renders the "unauthorized" fallback when RPC raises 42501', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: '42501', message: 'not authorized' },
    });

    const html = await renderPage({ grant: GRANT_ID });

    expect(html).not.toContain('TOKEN:');
    expect(html).toContain('Only the admin who created the grant');
  });

  // ── (d) Missing grant id ──────────────────────────────────────────────────

  it('(d) renders the "missing grant id" fallback when ?grant is absent', async () => {
    const html = await renderPage({});

    expect(html).toContain('Missing grant id in URL');
    // RPC must NOT be called.
    expect(mockRpc).not.toHaveBeenCalled();
  });

  // ── (e) Non-numeric grant id ──────────────────────────────────────────────

  it('(e) renders the "missing grant id" fallback when ?grant is non-numeric', async () => {
    const html = await renderPage({ grant: 'not-a-number' });

    expect(html).toContain('Missing grant id in URL');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  // ── (f) Empty token with no error (defensive) ─────────────────────────────

  it('(f) treats an empty string return as expired', async () => {
    mockRpc.mockResolvedValueOnce({ data: '', error: null });

    const html = await renderPage({ grant: GRANT_ID });

    expect(html).toContain('Token is no longer available');
    expect(html).not.toContain('TOKEN:');
  });

  it('(f) renders generic fallback for unknown SQLSTATE', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'XX000', message: 'something else' },
    });

    const html = await renderPage({ grant: GRANT_ID });

    expect(html).toContain('Token could not be retrieved');
  });
});
