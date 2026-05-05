/**
 * Email template smoke tests for uptime alert + recovery.
 *
 * Renders each template with sample props and asserts the key
 * operator-facing fields (URL, status code, durations, failing
 * dependencies) appear in the rendered HTML. This catches template
 * regressions without requiring a Resend round trip.
 */

import { describe, it, expect, vi } from 'vitest';
import * as React from 'react';

// WHY mock BaseLayout: the real BaseLayout uses @react-email/components
// <Tailwind> which performs async style-resolution and suspends during
// renderToStaticMarkup, which fails synchronously. The smoke tests only
// need to verify the props reach the children + the variable strings
// render. Stubbing BaseLayout with a passthrough <div> keeps the
// component tree synchronous.
vi.mock('../base-layout', () => ({
  BaseLayout: ({ children }: { children: React.ReactNode; preview: string }) =>
    React.createElement('div', { 'data-test': 'base-layout' }, children),
  Button: ({ children, href }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href }, children),
  Heading: ({ children }: { children: React.ReactNode }) =>
    React.createElement('h1', null, children),
  Paragraph: ({ children }: { children: React.ReactNode }) =>
    React.createElement('p', null, children),
  Divider: () => React.createElement('hr'),
}));

import { renderToStaticMarkup } from 'react-dom/server';
import UptimeAlertEmail from '../uptime-alert';
import UptimeRecoveryEmail from '../uptime-recovery';

async function render(node: React.ReactElement): Promise<string> {
  return renderToStaticMarkup(node);
}

describe('UptimeAlertEmail renders', () => {
  it('contains URL, status, consecutive failures, and failing dep names', async () => {
    const html = await render(
      React.createElement(UptimeAlertEmail, {
        url: 'https://www.styrbyapp.com/api/health',
        statusCode: 503,
        errorMessage: 'HTTP 503',
        consecutiveFailures: 3,
        lastSuccessAt: '2026-05-05T11:00:00Z',
        lastFailureAt: '2026-05-05T12:00:00Z',
        responseTimeMs: 8421,
        healthBody: {
          status: 'down',
          checks: { db: false, polar: true, openrouter: false, version: '1.0.0', commit: 'abc1234' },
        },
        generatedAtIso: '2026-05-05T12:00:00Z',
      })
    );
    expect(html).toContain('styrbyapp.com');
    expect(html).toContain('HTTP 503');
    expect(html).toContain('3 consecutive');
    expect(html).toContain('8421ms');
    // Failing dep callout
    expect(html).toContain('db');
    expect(html).toContain('openrouter');
  });

  it('handles null statusCode (DNS / timeout) without blowing up', async () => {
    const html = await render(
      React.createElement(UptimeAlertEmail, {
        url: 'https://www.styrbyapp.com',
        statusCode: null,
        errorMessage: 'timeout after 10000ms',
        consecutiveFailures: 2,
        lastSuccessAt: null,
        lastFailureAt: '2026-05-05T12:00:00Z',
        responseTimeMs: 10000,
        healthBody: null,
        generatedAtIso: '2026-05-05T12:00:00Z',
      })
    );
    expect(html).toContain('no response');
    expect(html).toContain('timeout');
    expect(html).toContain('never');
  });
});

describe('UptimeRecoveryEmail renders', () => {
  it('contains URL, status, down-for label, and recovered timestamp', async () => {
    const html = await render(
      React.createElement(UptimeRecoveryEmail, {
        url: 'https://www.styrbyapp.com',
        statusCode: 200,
        downForLabel: '14m',
        downSinceIso: '2026-05-05T11:46:00Z',
        recoveredAtIso: '2026-05-05T12:00:00Z',
        responseTimeMs: 142,
      })
    );
    expect(html).toContain('styrbyapp.com');
    expect(html).toContain('Recovered');
    expect(html).toContain('HTTP 200');
    expect(html).toContain('14m');
    expect(html).toContain('142ms');
  });
});
