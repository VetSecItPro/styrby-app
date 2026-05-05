/**
 * Uptime Alert Email
 *
 * Operator-facing alert dispatched by /api/cron/uptime-monitor when a
 * monitored URL has failed 2+ consecutive ticks. Voice is factual ops
 * (Datadog-style), no marketing copy. Numbers are pre-computed by the
 * route; this template only formats and lays them out.
 */

import { Section, Text } from '@react-email/components';
import * as React from 'react';
import { BaseLayout, Button, Heading, Paragraph, Divider } from './base-layout';

/**
 * Pre-computed alert payload from the route. Every field is required;
 * the route fills nullable fields with sensible defaults so the template
 * never needs to handle undefined.
 */
export interface UptimeAlertProps {
  /** The URL that failed (full https://... form). */
  url: string;
  /** HTTP status code returned, or null if no response (DNS, timeout). */
  statusCode: number | null;
  /** Short error string (e.g. "HTTP 503", "timeout after 10000ms"). */
  errorMessage: string | null;
  /** How many back-to-back failures led to this alert. */
  consecutiveFailures: number;
  /** ISO timestamp of the last successful ping, or null if never. */
  lastSuccessAt: string | null;
  /** ISO timestamp of this failure (cron tick time). */
  lastFailureAt: string;
  /** Round-trip duration of the failed ping, in milliseconds. */
  responseTimeMs: number;
  /**
   * Parsed JSON body from /api/health when the failed URL was the
   * health endpoint, so the alert surfaces WHICH dependency went down.
   * null for non-health URLs.
   */
  healthBody: Record<string, unknown> | null;
  /** ISO timestamp the email was generated (UTC). */
  generatedAtIso: string;
}

function Row({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: 'warn' | 'danger';
}) {
  const valueColor =
    emphasis === 'danger'
      ? '#f87171'
      : emphasis === 'warn'
        ? '#facc15'
        : '#f4f4f5';
  return (
    <tr>
      <td
        style={{
          padding: '8px 12px',
          fontSize: '13px',
          color: '#a1a1aa',
          borderBottom: '1px solid #27272a',
        }}
      >
        {label}
      </td>
      <td
        style={{
          padding: '8px 12px',
          fontSize: '13px',
          color: valueColor,
          fontWeight: 600,
          textAlign: 'right',
          borderBottom: '1px solid #27272a',
        }}
      >
        {value}
      </td>
    </tr>
  );
}

/**
 * Approximate "how long has this URL been failing" given the last
 * success timestamp. Returns a short label like "12m" or "never". Pure
 * presentation; the route does not pre-compute this because the email
 * is the only consumer.
 */
function approxDownDuration(
  lastSuccessAt: string | null,
  generatedAtIso: string
): string {
  if (!lastSuccessAt) return 'never';
  const ms = new Date(generatedAtIso).getTime() - new Date(lastSuccessAt).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

export default function UptimeAlertEmail(props: UptimeAlertProps) {
  const {
    url,
    statusCode,
    errorMessage,
    consecutiveFailures,
    lastSuccessAt,
    lastFailureAt,
    responseTimeMs,
    healthBody,
    generatedAtIso,
  } = props;

  const statusLabel = statusCode === null ? 'no response' : `HTTP ${statusCode}`;
  const downFor = approxDownDuration(lastSuccessAt, generatedAtIso);
  const subjectPreview = `${url} returning ${statusLabel} for ~${downFor}`;

  // Health-body breakdown: surface the failing dependencies in plain
  // text so the operator doesn't have to load the URL manually.
  let healthBreakdown: string | null = null;
  if (healthBody && typeof healthBody === 'object') {
    const checks = healthBody.checks as Record<string, unknown> | undefined;
    if (checks) {
      const failing = Object.entries(checks)
        .filter(([, v]) => v === false)
        .map(([k]) => k);
      if (failing.length > 0) {
        healthBreakdown = `Failing dependencies: ${failing.join(', ')}`;
      }
    }
  }

  return (
    <BaseLayout preview={subjectPreview}>
      <Heading>Styrby uptime alert</Heading>
      <Paragraph>
        {url} has failed {consecutiveFailures} consecutive ping
        {consecutiveFailures === 1 ? '' : 's'}. Last success was approximately
        {' '}
        {downFor} ago.
      </Paragraph>

      {/* ---- Status table ---- */}
      <Section
        style={{
          backgroundColor: '#18181b',
          borderRadius: '8px',
          padding: '8px 4px',
          marginBottom: '20px',
          border: '1px solid #27272a',
        }}
      >
        <table
          cellPadding={0}
          cellSpacing={0}
          style={{ width: '100%', borderCollapse: 'collapse' }}
        >
          <tbody>
            <Row label="URL" value={url} />
            <Row
              label="Response"
              value={statusLabel}
              emphasis="danger"
            />
            <Row
              label="Error"
              value={errorMessage ?? 'unknown'}
              emphasis="danger"
            />
            <Row
              label="Consecutive failures"
              value={String(consecutiveFailures)}
              emphasis="warn"
            />
            <Row
              label="Last success"
              value={lastSuccessAt ?? 'never recorded'}
            />
            <Row label="Last failure" value={lastFailureAt} />
            <Row label="Response time" value={`${responseTimeMs}ms`} />
          </tbody>
        </table>
      </Section>

      {/* ---- Health body breakdown when present ---- */}
      {healthBreakdown && (
        <Section
          style={{
            backgroundColor: '#18181b',
            borderRadius: '8px',
            padding: '16px 20px',
            marginBottom: '20px',
            border: '1px solid #27272a',
          }}
        >
          <Text
            style={{
              margin: '0 0 8px',
              fontSize: '12px',
              fontWeight: 600,
              color: '#a1a1aa',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            Health endpoint detail
          </Text>
          <Text
            style={{
              margin: '0 0 8px',
              fontSize: '13px',
              color: '#f87171',
              fontWeight: 600,
            }}
          >
            {healthBreakdown}
          </Text>
          <Text
            style={{
              margin: '0',
              fontSize: '12px',
              color: '#a1a1aa',
              fontFamily: 'monospace',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {JSON.stringify(healthBody, null, 2)}
          </Text>
        </Section>
      )}

      <Paragraph>
        First action: confirm whether this is a real outage or a
        false-positive (deploy in flight, edge node hiccup). The
        consecutive-failure threshold is 2, so a single transient blip
        will not have triggered this email.
      </Paragraph>

      {/* ---- Three action CTAs ---- */}
      <Section style={{ textAlign: 'center', marginBottom: '12px' }}>
        <Button href="https://vercel.com/vetsecitpro/styrby-web/deployments">
          View Vercel deploys
        </Button>
      </Section>
      <Section style={{ textAlign: 'center', marginBottom: '12px' }}>
        <a
          href="https://status.supabase.com"
          style={{
            color: '#f97316',
            fontSize: '13px',
            textDecoration: 'underline',
          }}
        >
          Check Supabase status
        </a>
      </Section>
      <Section style={{ textAlign: 'center', marginBottom: '20px' }}>
        <a
          href={url}
          style={{
            color: '#f97316',
            fontSize: '13px',
            textDecoration: 'underline',
          }}
        >
          Open the failing URL
        </a>
      </Section>

      <Divider />

      {/* ---- Footer ---- */}
      <Text style={{ margin: '0 0 4px', fontSize: '11px', color: '#71717a' }}>
        Generated at {generatedAtIso}
      </Text>
      <Text style={{ margin: '0', fontSize: '11px', color: '#71717a' }}>
        You are receiving this because the uptime monitor at
        {' '}
        /api/cron/uptime-monitor crossed the failure threshold.
        Configure URLs via UPTIME_CHECK_URLS, recipient via
        {' '}
        UPTIME_ALERT_EMAIL.
      </Text>
    </BaseLayout>
  );
}
