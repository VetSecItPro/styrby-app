'use client';

import type { ReactNode } from 'react';
import { SettingsLinkRow } from './settings-link-row';

/**
 * Colored leading-icon badge used by each integration row. Accepts an SVG
 * path string so the three rows stay declarative.
 */
function IconBadge({
  bg,
  fg,
  path,
}: {
  bg: string;
  fg: string;
  path: string;
}) {
  return (
    <div className={`h-8 w-8 rounded-lg flex items-center justify-center ${bg}`}>
      <svg
        className={`h-4 w-4 ${fg}`}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        aria-hidden="true"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={path} />
      </svg>
    </div>
  );
}

/**
 * Row definitions for the Integrations section.
 *
 * WHY a data-driven map: the original had three hand-written 40-line Link
 * blocks that differed only in icon color + href. A map-driven render is
 * half the code and eliminates drift (e.g., missing hover state on one row).
 */
const ROWS: Array<{
  href: string;
  label: string;
  description: string;
  badge?: ReactNode;
  icon: { bg: string; fg: string; path: string };
}> = [
  {
    href: '/dashboard/settings/api',
    label: 'API Keys',
    description: 'Access your data programmatically',
    badge: (
      <span className="inline-flex items-center rounded-full bg-orange-500/10 px-2 py-0.5 text-xs font-medium text-orange-400">
        Power
      </span>
    ),
    icon: {
      bg: 'bg-orange-500/10',
      fg: 'text-orange-400',
      path: 'M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z',
    },
  },
  {
    href: '/dashboard/settings/webhooks',
    label: 'Webhooks',
    description: 'Send events to Slack, Discord, or custom endpoints',
    icon: {
      bg: 'bg-purple-500/10',
      fg: 'text-purple-400',
      path: 'M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1',
    },
  },
  {
    href: '/dashboard/settings/templates',
    label: 'Prompt Templates',
    description: 'Reusable prompts for common tasks',
    icon: {
      bg: 'bg-cyan-500/10',
      fg: 'text-cyan-400',
      path: 'M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2',
    },
  },
];

/**
 * Integrations section: API keys, webhooks, prompt templates.
 */
export function SettingsIntegrations() {
  return (
    <section className="mb-8">
      <h2 className="text-lg font-semibold text-zinc-100 mb-4">Integrations</h2>
      <div className="rounded-xl bg-zinc-900 border border-zinc-800 divide-y divide-zinc-800">
        {ROWS.map((row) => (
          <SettingsLinkRow
            key={row.href}
            href={row.href}
            label={row.label}
            description={row.description}
            badge={row.badge}
            icon={<IconBadge {...row.icon} />}
          />
        ))}
      </div>
    </section>
  );
}
