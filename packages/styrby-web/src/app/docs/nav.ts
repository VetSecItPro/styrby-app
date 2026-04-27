/**
 * Documentation navigation structure.
 *
 * Single source of truth for sidebar links and prev/next computation.
 * Add new pages here; the layout and prev/next links update automatically.
 */
export interface DocNavItem {
  /** Display label in the sidebar */
  title: string;
  /** Route path relative to /docs */
  href: string;
  /** Short description shown on the index page */
  description: string;
}

export const docsNav: DocNavItem[] = [
  {
    title: 'Getting Started',
    href: '/docs/getting-started',
    description: 'Install the CLI, pair your machine, and see your first session.',
  },
  {
    title: 'CLI Reference',
    href: '/docs/cli',
    description: 'Commands, configuration, and supported agents.',
  },
  {
    title: 'Agent Setup',
    href: '/docs/agents',
    description: 'Install and connect all 11 supported CLI coding agents.',
  },
  {
    title: 'Dashboard Guide',
    href: '/docs/dashboard',
    description: 'Costs, sessions, agent status, and settings.',
  },
  {
    title: 'API Reference',
    href: '/docs/api',
    description: 'REST API for programmatic access (Pro and Growth).',
  },
  {
    title: 'Webhooks',
    href: '/docs/webhooks',
    description: 'HTTP event delivery to your endpoints.',
  },
  {
    title: 'Security',
    href: '/docs/security',
    description: 'E2E encryption, zero-knowledge architecture, audit logging.',
  },
  {
    title: 'Mobile App',
    href: '/docs/mobile',
    description: 'Push notifications, offline mode, permission approvals.',
  },
  {
    title: 'Team Management',
    href: '/docs/teams',
    description: 'Roles, shared visibility, and member management (Pro and Pro and Growths).',
  },
  {
    title: 'OTEL Metrics Export',
    href: '/docs/otel',
    description: 'Export metrics to Grafana, Datadog, Honeycomb, or New Relic (Pro and Growth).',
  },
  {
    title: 'Voice Input',
    href: '/docs/voice',
    description: 'Send voice commands to your agents from the mobile app (Pro and Growth).',
  },
  {
    title: 'Troubleshooting',
    href: '/docs/troubleshooting',
    description: 'Common issues and how to fix them.',
  },
];

/**
 * Returns the previous and next nav items for a given path.
 *
 * @param currentPath - The current page path (e.g. "/docs/cli")
 * @returns Object with prev and next items, or null if at the boundary
 */
export function getPrevNext(currentPath: string): {
  prev: DocNavItem | null;
  next: DocNavItem | null;
} {
  const index = docsNav.findIndex((item) => item.href === currentPath);
  return {
    prev: index > 0 ? docsNav[index - 1] : null,
    next: index < docsNav.length - 1 ? docsNav[index + 1] : null,
  };
}
