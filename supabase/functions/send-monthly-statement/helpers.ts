/**
 * send-monthly-statement helpers — pure functions testable without Deno.
 *
 * All exported functions from this module are pure (no Deno.env, no fetch,
 * no Supabase client). This makes them importable from vitest tests running
 * in Node without any Deno polyfills.
 *
 * WHY separate from index.ts: index.ts imports Deno APIs and Supabase Edge
 * Function runtime utilities. Separating the pure helpers lets the test
 * suite import helpers.ts without requiring Deno.
 *
 * @module send-monthly-statement/helpers
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Per-user aggregate data for the monthly statement.
 * Re-exported by index.ts for handler use.
 */
export interface UserMonthlyStats {
  userId: string;
  email: string;
  displayName?: string;
  totalCostUsd: number;
  sessionCount: number;
  topAgent: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  billingCounts: { apiKey: number; subscription: number; credit: number; free: number };
}

/**
 * Database row shape from cost_records aggregation.
 */
export interface CostAggRow {
  user_id: string;
  agent_type: string;
  billing_model: string;
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  record_count: number;
}

// ============================================================================
// getPriorMonthBounds
// ============================================================================

/**
 * Compute the first and last day (inclusive) of the prior calendar month.
 *
 * @param referenceDate - Reference date (defaults to today). Must be in UTC.
 * @returns { start: string, end: string, label: string }
 *
 * @example
 * getPriorMonthBounds(new Date('2026-04-21'))
 * // → { start: '2026-03-01', end: '2026-03-31', label: 'March 2026' }
 */
export function getPriorMonthBounds(referenceDate: Date = new Date()): {
  start: string;
  end: string;
  label: string;
} {
  const year = referenceDate.getUTCFullYear();
  const month = referenceDate.getUTCMonth(); // 0-indexed

  const priorYear = month === 0 ? year - 1 : year;
  const priorMonth = month === 0 ? 11 : month - 1;

  const startDate = new Date(Date.UTC(priorYear, priorMonth, 1));
  const endDate = new Date(Date.UTC(priorYear, priorMonth + 1, 0));

  const toDateStr = (d: Date) => d.toISOString().split('T')[0];

  const MONTHS = [
    'January','February','March','April','May','June',
    'July','August','September','October','November','December',
  ];

  return {
    start: toDateStr(startDate),
    end: toDateStr(endDate),
    label: `${MONTHS[priorMonth]} ${priorYear}`,
  };
}

// ============================================================================
// parseMonthOverride
// ============================================================================

/**
 * Parse a YYYY-MM override string into month bounds.
 *
 * @param monthStr - Month in YYYY-MM format
 * @returns Same shape as getPriorMonthBounds
 * @throws {Error} When the format is invalid
 */
export function parseMonthOverride(monthStr: string): {
  start: string;
  end: string;
  label: string;
} {
  const match = /^(\d{4})-(\d{2})$/.exec(monthStr);
  if (!match) {
    throw new Error(`Invalid month format "${monthStr}" — expected YYYY-MM`);
  }

  const year = parseInt(match[1], 10);
  const monthOneBased = parseInt(match[2], 10);

  if (monthOneBased < 1 || monthOneBased > 12) {
    throw new Error(`Month ${monthOneBased} out of range [1, 12]`);
  }

  const monthZeroIdx = monthOneBased - 1;
  const startDate = new Date(Date.UTC(year, monthZeroIdx, 1));
  const endDate = new Date(Date.UTC(year, monthZeroIdx + 1, 0));

  const toDateStr = (d: Date) => d.toISOString().split('T')[0];

  const MONTHS = [
    'January','February','March','April','May','June',
    'July','August','September','October','November','December',
  ];

  return {
    start: toDateStr(startDate),
    end: toDateStr(endDate),
    label: `${MONTHS[monthZeroIdx]} ${year}`,
  };
}

// ============================================================================
// aggregateUserStats
// ============================================================================

/**
 * Aggregate per-user monthly stats from cost_records rows.
 *
 * @param rows - Raw cost_records aggregation rows
 * @param userMap - Map of userId → { email, displayName }
 * @returns Array of UserMonthlyStats, one per user
 */
export function aggregateUserStats(
  rows: CostAggRow[],
  userMap: Map<string, { email: string; displayName?: string }>
): UserMonthlyStats[] {
  const byUser = new Map<string, CostAggRow[]>();
  for (const row of rows) {
    const existing = byUser.get(row.user_id);
    if (existing) {
      existing.push(row);
    } else {
      byUser.set(row.user_id, [row]);
    }
  }

  const stats: UserMonthlyStats[] = [];

  for (const [userId, userRows] of byUser) {
    const userInfo = userMap.get(userId);
    if (!userInfo) continue;

    let totalCostUsd = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const agentCounts: Record<string, number> = {};
    const billingCounts = { apiKey: 0, subscription: 0, credit: 0, free: 0 };

    for (const row of userRows) {
      totalCostUsd += Number(row.total_cost_usd) || 0;
      totalInputTokens += Number(row.total_input_tokens) || 0;
      totalOutputTokens += Number(row.total_output_tokens) || 0;

      const agent = row.agent_type ?? 'unknown';
      agentCounts[agent] = (agentCounts[agent] ?? 0) + (Number(row.record_count) || 0);

      switch (row.billing_model) {
        case 'api-key': billingCounts.apiKey += Number(row.record_count) || 0; break;
        case 'subscription': billingCounts.subscription += Number(row.record_count) || 0; break;
        case 'credit': billingCounts.credit += Number(row.record_count) || 0; break;
        case 'free': billingCounts.free += Number(row.record_count) || 0; break;
      }
    }

    const topAgent = Object.entries(agentCounts).sort(([, a], [, b]) => b - a)[0]?.[0] ?? 'unknown';

    stats.push({
      userId,
      email: userInfo.email,
      displayName: userInfo.displayName,
      totalCostUsd,
      sessionCount: 0,
      topAgent,
      totalInputTokens,
      totalOutputTokens,
      billingCounts,
    });
  }

  return stats;
}

// ============================================================================
// buildEmailPayload
// ============================================================================

/**
 * Build the email payload (HTML string + plain text + subject) for a user's
 * monthly statement.
 *
 * @param stats - Aggregated user stats
 * @param monthLabel - Human-readable month label, e.g. "April 2026"
 * @param appUrl - Base URL for dashboard links
 * @returns { subject, html, text }
 */
export function buildEmailPayload(
  stats: UserMonthlyStats,
  monthLabel: string,
  appUrl: string
): { subject: string; html: string; text: string } {
  const fmtUsd = (n: number) => `$${n.toFixed(2)}`;
  const fmtTokens = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toLocaleString();
  };

  const totalRows = stats.billingCounts.apiKey + stats.billingCounts.subscription + stats.billingCounts.credit + stats.billingCounts.free;
  const billing = totalRows > 0
    ? {
        apiPct: Math.round((stats.billingCounts.apiKey / totalRows) * 100),
        subscriptionPct: Math.round((stats.billingCounts.subscription / totalRows) * 100),
        creditPct: Math.round((stats.billingCounts.credit / totalRows) * 100),
      }
    : { apiPct: 0, subscriptionPct: 0, creditPct: 0 };

  const name = stats.displayName || stats.email.split('@')[0];
  const dashboardUrl = `${appUrl}/dashboard/costs`;

  const billingParts: string[] = [];
  if (billing.apiPct > 0) billingParts.push(`${billing.apiPct}% API`);
  if (billing.subscriptionPct > 0) billingParts.push(`${billing.subscriptionPct}% subscription quota`);
  if (billing.creditPct > 0) billingParts.push(`${billing.creditPct}% credits`);
  const billingLine = billingParts.join(', ') || 'No billed usage';

  const text = [
    `Hey ${name},`,
    '',
    `Here's your ${monthLabel} AI coding summary:`,
    '',
    `  Total Spent:    ${fmtUsd(stats.totalCostUsd)}`,
    `  Sessions:       ${stats.sessionCount}`,
    `  Top Agent:      ${stats.topAgent}`,
    `  Input Tokens:   ${fmtTokens(stats.totalInputTokens)}`,
    `  Output Tokens:  ${fmtTokens(stats.totalOutputTokens)}`,
    `  Billing Mix:    ${billingLine}`,
    '',
    `View your full cost dashboard: ${dashboardUrl}`,
    '',
    '-- Styrby',
  ].join('\n');

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Your ${monthLabel} Summary</title></head>
<body style="background:#09090b;font-family:sans-serif;margin:0;padding:0;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#09090b;">
  <tr><td align="center" style="padding:40px 16px;">
    <table width="560" cellpadding="0" cellspacing="0" style="background:#18181b;border-radius:12px;border:1px solid #27272a;padding:32px;">
      <tr><td>
        <p style="color:#f97316;font-size:24px;font-weight:700;margin:0 0 8px;">Styrby</p>
        <h1 style="color:#fafafa;font-size:20px;font-weight:600;margin:0 0 16px;">Your ${monthLabel} in Review</h1>
        <p style="color:#a1a1aa;font-size:14px;">Hey ${name},</p>
        <p style="color:#a1a1aa;font-size:14px;">Here&apos;s your AI coding summary for <strong style="color:#fafafa;">${monthLabel}</strong>.</p>
        <table width="100%" cellpadding="12" cellspacing="0" style="background:#27272a;border-radius:8px;margin:20px 0;">
          <tr>
            <td align="center" width="33%"><div style="font-size:24px;font-weight:700;color:#fafafa;">${fmtUsd(stats.totalCostUsd)}</div><div style="font-size:11px;color:#71717a;margin-top:4px;">Total Spent</div></td>
            <td align="center" width="33%"><div style="font-size:24px;font-weight:700;color:#fafafa;">${stats.sessionCount}</div><div style="font-size:11px;color:#71717a;margin-top:4px;">Sessions</div></td>
            <td align="center" width="33%"><div style="font-size:16px;font-weight:700;color:#fafafa;">${stats.topAgent}</div><div style="font-size:11px;color:#71717a;margin-top:4px;">Top Agent</div></td>
          </tr>
          <tr>
            <td align="center" colspan="2" style="border-top:1px solid #3f3f46;padding-top:12px;"><div style="font-size:16px;font-weight:600;color:#fafafa;">${fmtTokens(stats.totalInputTokens)}</div><div style="font-size:11px;color:#71717a;margin-top:4px;">Input Tokens</div></td>
            <td align="center" style="border-top:1px solid #3f3f46;padding-top:12px;"><div style="font-size:16px;font-weight:600;color:#fafafa;">${fmtTokens(stats.totalOutputTokens)}</div><div style="font-size:11px;color:#71717a;margin-top:4px;">Output Tokens</div></td>
          </tr>
        </table>
        <p style="color:#71717a;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 8px;">Billing Mix</p>
        <div style="background:#27272a;border:1px solid #3f3f46;border-radius:8px;padding:12px;font-size:13px;color:#d4d4d8;">${billingLine}</div>
        <hr style="border:none;border-top:1px solid #27272a;margin:24px 0;">
        <p style="color:#a1a1aa;font-size:13px;">Want to dig deeper? View your full cost dashboard.</p>
        <a href="${dashboardUrl}" style="display:inline-block;background:#f97316;color:#fff;font-size:14px;font-weight:600;text-decoration:none;padding:10px 24px;border-radius:8px;margin:8px 0;">View Cost Dashboard</a>
        <p style="color:#52525b;font-size:11px;margin-top:24px;">You&apos;re receiving this because you have a Styrby account. <a href="${appUrl}/dashboard/settings/notifications" style="color:#71717a;">Manage preferences</a>.</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  return {
    subject: `Your ${monthLabel} Styrby Summary - ${fmtUsd(stats.totalCostUsd)}`,
    html,
    text,
  };
}
