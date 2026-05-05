/**
 * Polar Webhook Health Alert Email
 *
 * Ops alert dispatched by /api/cron/polar-webhook-health when one of the
 * three webhook-health signals trips (no events in 4h during business
 * hours, dedup error rate > 5%, OR latest event > 24h old). Operator-facing,
 * not a customer email — voice is factual, no marketing copy.
 *
 * The template is fed pre-computed numbers + a suspected-cause string by
 * the route. It does no signal evaluation of its own (testability + single
 * source of truth for the health logic in lib.ts).
 */

import { Section, Text } from '@react-email/components';
import * as React from 'react';
import {
  BaseLayout,
  Button,
  Heading,
  Paragraph,
  Divider,
} from './base-layout';

/**
 * Pre-computed status snapshot rendered in the alert. The route owns all
 * arithmetic; this template is render-only.
 */
export interface PolarWebhookHealthAlertProps {
  /** Tripped-signal identifier; used in subject + footer. */
  signal:
    | 'no_events_business_hours'
    | 'dedup_error_spike'
    | 'latest_event_24h_old';
  /** Human label for the tripped signal (matches subject). */
  signalLabel: string;
  /** Latest event timestamp as a Central-time string, or "never" if the table is empty. */
  latestEventLabel: string;
  /** Hours since the latest event, formatted ("3.4h", "26.1h", "never"). */
  hoursSinceLatestLabel: string;
  /** Total polar_webhook_events rows in the last 24h. */
  eventCount24h: number;
  /** Guard-error rate as a percentage (0-100). */
  guardErrorRatePct: number;
  /** Raw guard error count contributing to the rate. */
  guardErrorCount24h: number;
  /** Top 3 most-recent event types observed (for context). */
  recentEventTypes: string[];
  /** Per-signal evaluation summaries (rendered as a small table). */
  signalSummaries: Array<{
    label: string;
    detail: string;
    tripped: boolean;
  }>;
  /** One-paragraph hypothesis on which side is broken. */
  suspectedCause: string;
  /** ISO timestamp when this email was generated (UTC). */
  generatedAtIso: string;
  /** Central-time human render of `generatedAtIso`. */
  generatedAtCentralLabel: string;
}

/**
 * Renders one row of the signal-summary table. Inline styles because email
 * clients ignore most CSS and Tailwind from base-layout doesn't apply
 * consistently to `<td>` elements across Outlook/Gmail.
 */
function Row({
  label,
  detail,
  tripped,
}: {
  label: string;
  detail: string;
  tripped: boolean;
}) {
  const valueColor = tripped ? '#f87171' : '#a1a1aa';
  return (
    <tr>
      <td
        style={{
          padding: '8px 12px',
          fontSize: '13px',
          color: tripped ? '#f4f4f5' : '#a1a1aa',
          fontWeight: tripped ? 600 : 400,
          borderBottom: '1px solid #27272a',
          width: '40%',
        }}
      >
        {tripped ? '[TRIPPED] ' : ''}
        {label}
      </td>
      <td
        style={{
          padding: '8px 12px',
          fontSize: '13px',
          color: valueColor,
          textAlign: 'right',
          borderBottom: '1px solid #27272a',
        }}
      >
        {detail}
      </td>
    </tr>
  );
}

export default function PolarWebhookHealthAlertEmail(
  props: PolarWebhookHealthAlertProps
) {
  const {
    signalLabel,
    latestEventLabel,
    hoursSinceLatestLabel,
    eventCount24h,
    guardErrorRatePct,
    guardErrorCount24h,
    recentEventTypes,
    signalSummaries,
    suspectedCause,
    generatedAtIso,
    generatedAtCentralLabel,
  } = props;

  const subjectPreview = `Polar webhook ${signalLabel} - last event ${hoursSinceLatestLabel} ago`;
  const recentTypesLine =
    recentEventTypes.length > 0 ? recentEventTypes.join(', ') : 'none in window';

  return (
    <BaseLayout preview={subjectPreview}>
      <Heading>Polar webhook health alert</Heading>
      <Paragraph>
        {signalLabel}. Last successful webhook was {hoursSinceLatestLabel} ago
        ({latestEventLabel}).
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
            <Row
              label="Last event"
              detail={latestEventLabel}
              tripped={false}
            />
            <Row
              label="Time since last event"
              detail={hoursSinceLatestLabel}
              tripped={false}
            />
            <Row
              label="Events processed (last 24h)"
              detail={`${eventCount24h}`}
              tripped={false}
            />
            <Row
              label="Guard-error rate (last 24h)"
              detail={`${guardErrorRatePct.toFixed(1)}% (${guardErrorCount24h} rows)`}
              tripped={false}
            />
            <Row
              label="Recent event types"
              detail={recentTypesLine}
              tripped={false}
            />
          </tbody>
        </table>
      </Section>

      {/* ---- Per-signal evaluation ---- */}
      <Section
        style={{
          backgroundColor: '#18181b',
          borderRadius: '8px',
          padding: '8px 4px',
          marginBottom: '20px',
          border: '1px solid #27272a',
        }}
      >
        <Text
          style={{
            margin: '8px 12px',
            fontSize: '12px',
            fontWeight: 600,
            color: '#a1a1aa',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          Signal evaluation
        </Text>
        <table
          cellPadding={0}
          cellSpacing={0}
          style={{ width: '100%', borderCollapse: 'collapse' }}
        >
          <tbody>
            {signalSummaries.map((s) => (
              <Row
                key={s.label}
                label={s.label}
                detail={s.detail}
                tripped={s.tripped}
              />
            ))}
          </tbody>
        </table>
      </Section>

      {/* ---- Suspected cause ---- */}
      <Paragraph>
        <strong>Suspected cause:</strong> {suspectedCause}
      </Paragraph>

      {/* ---- Three actions ---- */}
      <Section style={{ textAlign: 'center', marginBottom: '12px' }}>
        <Button href="https://polar.sh/dashboard">Open Polar dashboard</Button>
      </Section>
      <Section style={{ textAlign: 'center', marginBottom: '12px' }}>
        <a
          href="https://vercel.com/vetsecitpro/styrby-web/logs"
          style={{ color: '#f97316', fontSize: '13px', textDecoration: 'underline' }}
        >
          Vercel function logs (api/webhooks/polar)
        </a>
      </Section>
      <Section style={{ textAlign: 'center', marginBottom: '20px' }}>
        <a
          href="https://supabase.com/dashboard/project/akmtmxunjhsgldjztdtt/editor"
          style={{ color: '#f97316', fontSize: '13px', textDecoration: 'underline' }}
        >
          Supabase polar_webhook_events table
        </a>
      </Section>

      <Divider />

      {/* ---- Footer ---- */}
      <Text style={{ margin: '0 0 4px', fontSize: '11px', color: '#71717a' }}>
        Signal: {signalLabel}
      </Text>
      <Text style={{ margin: '0 0 4px', fontSize: '11px', color: '#71717a' }}>
        Generated {generatedAtCentralLabel} ({generatedAtIso})
      </Text>
      <Text style={{ margin: '0', fontSize: '11px', color: '#71717a' }}>
        You&apos;re getting this because the hourly polar-webhook-health cron
        detected an unhealthy signal. Throttle: 1 alert per signal per 24h.
        Adjust thresholds in lib.ts if the signal is too sensitive.
      </Text>
    </BaseLayout>
  );
}
