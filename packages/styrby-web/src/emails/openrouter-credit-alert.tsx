/**
 * OpenRouter Credit Alert Email
 *
 * Ops alert dispatched by /api/cron/openrouter-credit-monitor when the
 * Styrby Production v2 OpenRouter API key drops below the configured
 * low-balance threshold (default $20). This is operator-facing, not a
 * customer email — voice is factual, no marketing copy.
 *
 * The template is fed pre-computed numbers from the route. It does no
 * arithmetic of its own (testability + single source of truth for the
 * burn-rate math).
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
 * Pre-computed metrics displayed in the alert. All currency values are
 * USD; the route formats them as numbers and the template renders them
 * via `formatUsd()` below so a single rounding rule applies everywhere.
 */
export interface OpenRouterCreditAlertProps {
  /** Monthly cap on the OpenRouter key (USD, e.g. 50). */
  capUsd: number;
  /** Cap minus this period's usage (USD). */
  remainingUsd: number;
  /** This-cycle (calendar-month) usage (USD). */
  usedThisCycleUsd: number;
  /** Percent of the cap consumed this cycle (0-100, may exceed 100). */
  capPctUsed: number;
  /** Average daily burn for the current cycle so far (USD/day). */
  dailyBurnUsd: number;
  /** Linear projection for the full cycle (USD). */
  projectedEndOfCycleUsd: number;
  /**
   * Projected overage (USD). 0 if on-track. Triggers the red call-out
   * paragraph when > 0.
   */
  projectedOverageUsd: number;
  /** Days remaining in the current calendar month (integer ≥ 0). */
  daysRemainingInCycle: number;
  /** Days into the current calendar month (integer ≥ 1). */
  daysIntoCycle: number;
  /** Human label for the next reset date, e.g. "Saturday, June 1". */
  nextResetLabel: string;
  /** Rolling 24h usage from the OpenRouter key endpoint (USD). */
  usageDailyUsd: number;
  /** Rolling 7d usage from the OpenRouter key endpoint (USD). */
  usageWeeklyUsd: number;
  /** Rolling-month usage from the OpenRouter key endpoint (USD). */
  usageMonthlyUsd: number;
  /** Identifier displayed in the footer; currently always "Styrby Production v2". */
  keyLabel: string;
  /** Threshold (USD) that triggered this email — shown in footer for env-var docs. */
  thresholdUsd: number;
  /** ISO timestamp the email was generated (UTC). */
  generatedAtIso: string;
  /** Human-readable Central Time render of `generatedAtIso`. */
  generatedAtCentralLabel: string;
}

function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * Renders one row of the metrics table. Inline styles because email
 * clients ignore most CSS and Tailwind classes from base-layout don't
 * apply consistently to `<td>` elements across Outlook/Gmail.
 */
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
      ? '#f87171' // red-400
      : emphasis === 'warn'
        ? '#facc15' // yellow-400
        : '#f4f4f5'; // zinc-100
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

export default function OpenRouterCreditAlertEmail(
  props: OpenRouterCreditAlertProps
) {
  const {
    capUsd,
    remainingUsd,
    usedThisCycleUsd,
    capPctUsed,
    dailyBurnUsd,
    projectedEndOfCycleUsd,
    projectedOverageUsd,
    daysRemainingInCycle,
    nextResetLabel,
    usageDailyUsd,
    usageWeeklyUsd,
    usageMonthlyUsd,
    keyLabel,
    thresholdUsd,
    generatedAtIso,
    generatedAtCentralLabel,
  } = props;

  const overage = projectedOverageUsd > 0;
  const highBurn = capPctUsed > 80;

  // WHY this branching is here, not in the route: the route owns numbers,
  // the template owns the operator-facing narrative. Keeping the prose
  // beside the layout makes copy edits a single-file change.
  let situationLine: string;
  if (overage) {
    situationLine = `At the current burn rate ($${dailyBurnUsd.toFixed(2)}/day) the cycle projects to ${formatUsd(projectedEndOfCycleUsd)} — over the cap by ${formatUsd(projectedOverageUsd)}. Summary generation will start failing once the cap is hit.`;
  } else if (highBurn) {
    situationLine = `Burn rate is ${formatUsd(dailyBurnUsd)}/day and ${capPctUsed.toFixed(0)}% of the cap is used. You'll likely hit the cap in the next few days; top up or raise the cap to keep summaries running.`;
  } else {
    situationLine = `Cycle is tracking to about ${formatUsd(projectedEndOfCycleUsd)} — within the ${formatUsd(capUsd)} cap. Balance crossed the alert threshold (${formatUsd(thresholdUsd)}); top up at your convenience.`;
  }

  const subjectPreview = `${formatUsd(remainingUsd)} remaining (${capPctUsed.toFixed(0)}% of cap used) — ${daysRemainingInCycle} days left in cycle`;

  return (
    <BaseLayout preview={subjectPreview}>
      <Heading>OpenRouter balance running low</Heading>
      <Paragraph>
        {formatUsd(remainingUsd)} of the {formatUsd(capUsd)} monthly cap
        remaining on the {keyLabel} key.
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
            <Row label="Cap" value={`${formatUsd(capUsd)} / month`} />
            <Row
              label="Used this cycle"
              value={`${formatUsd(usedThisCycleUsd)} (${capPctUsed.toFixed(0)}%)`}
              emphasis={highBurn ? 'warn' : undefined}
            />
            <Row
              label="Remaining"
              value={formatUsd(remainingUsd)}
              emphasis={remainingUsd < thresholdUsd ? 'warn' : undefined}
            />
            <Row
              label="Daily burn (avg this cycle)"
              value={`${formatUsd(dailyBurnUsd)}/day`}
            />
            <Row
              label="Projected end-of-cycle"
              value={
                overage
                  ? `${formatUsd(projectedEndOfCycleUsd)} (over by ${formatUsd(projectedOverageUsd)})`
                  : formatUsd(projectedEndOfCycleUsd)
              }
              emphasis={overage ? 'danger' : undefined}
            />
            <Row
              label="Days remaining in cycle"
              value={`${daysRemainingInCycle} day${daysRemainingInCycle === 1 ? '' : 's'}`}
            />
            <Row label="Next reset" value={nextResetLabel} />
          </tbody>
        </table>
      </Section>

      {/* ---- Burn breakdown ---- */}
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
          Rolling burn (this key)
        </Text>
        <Text style={{ margin: '0 0 4px', fontSize: '13px', color: '#f4f4f5' }}>
          Last 24h: {formatUsd(usageDailyUsd)}
        </Text>
        <Text style={{ margin: '0 0 4px', fontSize: '13px', color: '#f4f4f5' }}>
          Last 7d: {formatUsd(usageWeeklyUsd)}
        </Text>
        <Text style={{ margin: '0', fontSize: '13px', color: '#f4f4f5' }}>
          This month: {formatUsd(usageMonthlyUsd)}
        </Text>
      </Section>

      {/* ---- Situation paragraph ---- */}
      <Paragraph>{situationLine}</Paragraph>

      {/* ---- Three actions ---- */}
      <Section style={{ textAlign: 'center', marginBottom: '12px' }}>
        <Button href="https://openrouter.ai/credits">Top up credits</Button>
      </Section>
      <Section style={{ textAlign: 'center', marginBottom: '12px' }}>
        <Text style={{ margin: '0 0 4px', fontSize: '13px', color: '#a1a1aa' }}>
          Need a higher monthly cap? Edit the {keyLabel} key:
        </Text>
        <a
          href="https://openrouter.ai/keys"
          style={{ color: '#f97316', fontSize: '13px', textDecoration: 'underline' }}
        >
          openrouter.ai/keys
        </a>
      </Section>
      <Section style={{ textAlign: 'center', marginBottom: '20px' }}>
        <a
          href="https://openrouter.ai/activity"
          style={{ color: '#f97316', fontSize: '13px', textDecoration: 'underline' }}
        >
          View usage detail (openrouter.ai/activity)
        </a>
      </Section>

      <Divider />

      {/* ---- Footer ---- */}
      <Text style={{ margin: '0 0 4px', fontSize: '11px', color: '#71717a' }}>
        Alert for OR key: {keyLabel}
      </Text>
      <Text style={{ margin: '0 0 4px', fontSize: '11px', color: '#71717a' }}>
        Generated {generatedAtCentralLabel} ({generatedAtIso})
      </Text>
      <Text style={{ margin: '0', fontSize: '11px', color: '#71717a' }}>
        You&apos;re getting this because OpenRouter balance dropped below
        {' '}
        {formatUsd(thresholdUsd)}. Adjust the threshold via the
        {' '}
        OPENROUTER_LOW_BALANCE_THRESHOLD env var.
      </Text>
    </BaseLayout>
  );
}
