/**
 * POST /api/security/csp-report
 *
 * CSP violation report receiver. Browsers POST violations to this endpoint
 * when a page-level Content-Security-Policy rule is breached. The endpoint
 * persists each report to `audit_log` with `action='csp_violation'` for
 * correlation with other anomaly signals (rate-limit spikes, 401 bursts).
 *
 * @rateLimit 60 reports per minute per IP (browsers naturally batch; this is
 *            generous to avoid losing legitimate violation evidence during a
 *            real attack while still capping flood risk).
 *
 * @body
 *   The browser sends two body shapes depending on which Reporting API
 *   level it supports:
 *
 *   Level 2 (legacy `report-uri`):
 *     application/csp-report
 *     {
 *       "csp-report": {
 *         "document-uri": "https://styrbyapp.com/dashboard",
 *         "violated-directive": "script-src",
 *         "blocked-uri": "https://evil.example.com/x.js",
 *         ...
 *       }
 *     }
 *
 *   Level 3 (`report-to`):
 *     application/reports+json
 *     [{ "type": "csp-violation", "body": {...}, "url": ..., "user_agent": ... }]
 *
 *   We accept both. The handler normalizes each to a single `cspReport` record
 *   shape before insertion.
 *
 * Security design:
 *
 * 1. NO AUTHENTICATION on this endpoint. Browsers cannot authenticate CSP
 *    reports — they're sent before any session context is established for the
 *    page. Public-by-construction.
 *
 * 2. INPUT SIZE CAP. A malicious site cannot DoS us by sending mega-payloads
 *    because we cap the body at 10KB before parsing. Real CSP reports are
 *    typically <2KB.
 *
 * 3. NO REFLECTION. The endpoint never returns the report content in its
 *    response body. Eliminates use as an XSS amplifier.
 *
 * 4. RATE-LIMITED. A compromised browser sending floods can't fill the
 *    audit_log; the rate limiter caps per-IP intake.
 *
 * 5. NO PII LOGGING. We strip query strings from `document-uri` before
 *    persistence (some apps put email/token in URL params).
 *
 * Governing standards:
 * - OWASP A03:2021 (Injection): early-warning system for XSS attempts.
 * - SOC 2 CC7.2: security event detection + logging.
 * - W3C CSP Level 3 Reporting API.
 *
 * @module api/security/csp-report
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server';
import { rateLimit, getClientIp, rateLimitResponse } from '@/lib/rateLimit';

// ============================================================================
// Body schemas (best-effort — different browsers send slightly different shapes)
// ============================================================================

const Level2ReportSchema = z
  .object({
    'csp-report': z
      .object({
        'document-uri': z.string().optional(),
        'violated-directive': z.string().optional(),
        'effective-directive': z.string().optional(),
        'blocked-uri': z.string().optional(),
        'source-file': z.string().optional(),
        'line-number': z.number().optional(),
        'column-number': z.number().optional(),
        'status-code': z.number().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const Level3ReportItemSchema = z
  .object({
    type: z.string().optional(),
    age: z.number().optional(),
    url: z.string().optional(),
    user_agent: z.string().optional(),
    body: z.record(z.unknown()).optional(),
  })
  .passthrough();

const Level3ReportSchema = z.array(Level3ReportItemSchema);

// ============================================================================
// Helpers
// ============================================================================

/** Strip query string from a URL to avoid persisting tokens / emails. */
function stripQuery(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split('?')[0];
  }
}

interface NormalizedReport {
  documentUri?: string;
  violatedDirective?: string;
  blockedUri?: string;
  sourceFile?: string;
  lineNumber?: number;
  reportType: 'level-2' | 'level-3';
}

/** Normalize either body shape into the same record we persist. */
function normalize(body: unknown): NormalizedReport[] {
  // Level 2: { "csp-report": {...} }
  const l2 = Level2ReportSchema.safeParse(body);
  if (l2.success) {
    const r = l2.data['csp-report'];
    return [
      {
        documentUri: stripQuery(r['document-uri']),
        violatedDirective: r['violated-directive'] ?? r['effective-directive'],
        blockedUri: stripQuery(r['blocked-uri']),
        sourceFile: stripQuery(r['source-file']),
        lineNumber: r['line-number'],
        reportType: 'level-2',
      },
    ];
  }

  // Level 3: [{type, body: {...}, url, user_agent}]
  const l3 = Level3ReportSchema.safeParse(body);
  if (l3.success) {
    return l3.data
      .filter((item) => item.type === 'csp-violation' || item.type === undefined)
      .map((item) => {
        const body = item.body as Record<string, unknown> | undefined;
        return {
          documentUri: stripQuery((body?.documentURL ?? item.url) as string | undefined),
          violatedDirective: (body?.effectiveDirective ?? body?.violatedDirective) as
            | string
            | undefined,
          blockedUri: stripQuery(body?.blockedURL as string | undefined),
          sourceFile: stripQuery(body?.sourceFile as string | undefined),
          lineNumber: body?.lineNumber as number | undefined,
          reportType: 'level-3',
        };
      });
  }

  return [];
}

// ============================================================================
// Handler
// ============================================================================

const MAX_BODY_BYTES = 10 * 1024; // 10KB cap — real CSP reports are <2KB.

/**
 * Receives CSP violation reports and persists each to audit_log.
 *
 * @returns Always 204 No Content on accept (so the browser doesn't retry).
 *          Never returns the report content. Errors logged server-side only.
 */
export async function POST(request: NextRequest) {
  const ip = getClientIp(request) ?? 'unknown';

  // 1. Rate limit by IP (60/min). Generous because browsers batch; tight enough
  //    to prevent log floods. The shared rateLimit() helper extracts client IP
  //    from the request internally (X-Forwarded-For etc.) — we pass `request`,
  //    not a manually-keyed string, to stay consistent with other endpoints.
  const limit = await rateLimit(
    request,
    {
      windowMs: 60_000,
      maxRequests: 60,
    },
    'csp-report'
  );
  if (!limit.allowed) {
    return rateLimitResponse(limit.retryAfter ?? 60);
  }

  // 2. Read body with size cap. A 10KB cap prevents memory abuse from a
  //    misbehaving or malicious browser.
  let raw: string;
  try {
    raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      // Silently drop oversized reports — telling the client "too big" would
      // give an attacker a length-detection oracle. Log server-side instead.
      console.warn('[csp-report] dropped oversized report', {
        ip,
        bytes: raw.length,
      });
      return new NextResponse(null, { status: 204 });
    }
  } catch {
    return new NextResponse(null, { status: 204 });
  }

  // 3. Parse + normalize. Tolerate any malformed shape — silent 204.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new NextResponse(null, { status: 204 });
  }
  const reports = normalize(parsed);
  if (reports.length === 0) {
    return new NextResponse(null, { status: 204 });
  }

  // 4. Persist each report to audit_log. Best-effort — if the DB write fails
  //    we don't want to retry from the browser, so always 204.
  // WHY admin client (not user-scoped): no session context for the visitor.
  const supabase = createAdminClient();

  for (const r of reports) {
    try {
      await supabase.from('audit_log').insert({
        // No user_id — these reports are pre-auth.
        action: 'csp_violation',
        resource_type: 'security',
        resource_id: null,
        metadata: {
          ip,
          report_type: r.reportType,
          document_uri: r.documentUri,
          violated_directive: r.violatedDirective,
          blocked_uri: r.blockedUri,
          source_file: r.sourceFile,
          line_number: r.lineNumber,
          // user-agent stripped — too noisy for audit_log; can be reconstructed
          // from access logs if needed.
        },
      });
    } catch (err) {
      // Swallow + log — never propagate DB errors back to the browser.
      console.error('[csp-report] DB insert failed', {
        ip,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return new NextResponse(null, { status: 204 });
}

/**
 * Reject any non-POST method explicitly.
 *
 * WHY: Browsers always POST CSP reports per spec. A GET to this endpoint is
 * either a misconfiguration or an active reconnaissance attempt. Returning
 * 405 (rather than 200/404) explicitly surfaces the misuse.
 */
export async function GET() {
  return new NextResponse(null, { status: 405 });
}
