/**
 * Fix Suggestions
 *
 * Utilities for generating and filtering fix suggestions.
 */

import type { FixSuggestion, ErrorAttribution, ErrorSource, ErrorSeverity } from './types.js';

/**
 * Filter suggestions to only auto-fixable ones
 */
export function getAutoFixableSuggestions(attribution: ErrorAttribution): FixSuggestion[] {
  return attribution.suggestions.filter((s) => s.autoFixable && s.action);
}

/**
 * Get the best suggestion (first one, as they're ordered by relevance)
 */
export function getBestSuggestion(attribution: ErrorAttribution): FixSuggestion | undefined {
  return attribution.suggestions[0];
}

/**
 * Get auto-fix command if available
 */
export function getAutoFixCommand(attribution: ErrorAttribution): string | undefined {
  const autoFix = getAutoFixableSuggestions(attribution)[0];
  return autoFix?.action;
}

/**
 * Check if error has any actionable suggestions
 */
export function hasActionableSuggestions(attribution: ErrorAttribution): boolean {
  return attribution.suggestions.length > 0;
}

/**
 * Check if error can be auto-fixed
 */
export function canAutoFix(attribution: ErrorAttribution): boolean {
  return getAutoFixableSuggestions(attribution).length > 0;
}

/**
 * Format suggestions for display
 */
export function formatSuggestions(
  suggestions: FixSuggestion[],
  options: { includeActions?: boolean; markdown?: boolean } = {}
): string {
  const { includeActions = true, markdown = false } = options;

  return suggestions
    .map((s, i) => {
      const bullet = markdown ? '-' : `${i + 1}.`;
      let line = `${bullet} **${s.title}**: ${s.description}`;

      if (includeActions && s.action) {
        line += markdown ? `\n  \`${s.action}\`` : ` (run: ${s.action})`;
      }

      if (s.docUrl) {
        line += markdown ? ` [docs](${s.docUrl})` : ` See: ${s.docUrl}`;
      }

      return line;
    })
    .join('\n');
}

/**
 * Generate contextual suggestions based on error details
 */
export function generateContextualSuggestions(attribution: ErrorAttribution): FixSuggestion[] {
  const suggestions = [...attribution.suggestions];

  // Add file-specific suggestions if we have a location
  if (attribution.location?.file) {
    const file = attribution.location.file;

    if (file.endsWith('.ts') || file.endsWith('.tsx')) {
      if (attribution.category === 'build_type') {
        suggestions.push({
          title: 'Check type definitions',
          description: `Review types in ${file}${attribution.location.line ? `:${attribution.location.line}` : ''}`,
          autoFixable: false,
        });
      }
    }

    if (file.includes('test') || file.includes('spec')) {
      suggestions.push({
        title: 'Run single test file',
        description: 'Run just the failing test for faster iteration.',
        autoFixable: true,
        action: `npm test -- ${file}`,
      });
    }
  }

  // Add severity-specific suggestions
  if (attribution.severity === 'critical') {
    suggestions.unshift({
      title: 'Stop and investigate immediately',
      description: 'This is a critical error that may cause data loss or security issues.',
      autoFixable: false,
    });
  }

  return suggestions;
}

/**
 * Group suggestions by type
 */
export function groupSuggestionsByType(suggestions: FixSuggestion[]): {
  autoFixable: FixSuggestion[];
  manual: FixSuggestion[];
  documentation: FixSuggestion[];
} {
  return {
    autoFixable: suggestions.filter((s) => s.autoFixable && s.action),
    manual: suggestions.filter((s) => !s.autoFixable && !s.docUrl),
    documentation: suggestions.filter((s) => s.docUrl),
  };
}

/**
 * Create a custom suggestion
 */
export function createSuggestion(
  title: string,
  description: string,
  options: { action?: string; docUrl?: string } = {}
): FixSuggestion {
  return {
    title,
    description,
    autoFixable: !!options.action,
    action: options.action,
    docUrl: options.docUrl,
  };
}

/**
 * Get source-specific help resources
 */
export function getHelpResources(source: ErrorSource): { title: string; url: string }[] {
  const resources: Record<ErrorSource, { title: string; url: string }[]> = {
    styrby: [
      { title: 'Styrby Documentation', url: 'https://styrby.dev/docs' },
      { title: 'Troubleshooting Guide', url: 'https://styrby.dev/docs/troubleshooting' },
    ],
    agent: [
      { title: 'Anthropic Status', url: 'https://status.anthropic.com' },
      { title: 'OpenAI Status', url: 'https://status.openai.com' },
      { title: 'API Rate Limits', url: 'https://styrby.dev/docs/rate-limits' },
    ],
    build: [
      { title: 'TypeScript Handbook', url: 'https://www.typescriptlang.org/docs/' },
      { title: 'npm Documentation', url: 'https://docs.npmjs.com/' },
    ],
    network: [
      { title: 'Check Internet Connection', url: 'https://www.speedtest.net/' },
      { title: 'DNS Checker', url: 'https://dnschecker.org/' },
    ],
    user: [{ title: 'Getting Started', url: 'https://styrby.dev/docs/getting-started' }],
    unknown: [
      { title: 'Styrby Support', url: 'https://styrby.dev/support' },
      { title: 'Community Discord', url: 'https://discord.gg/styrby' },
    ],
  };

  return resources[source] || resources.unknown;
}

/**
 * Get severity emoji for display
 */
export function getSeverityEmoji(severity: ErrorSeverity): string {
  const emojis: Record<ErrorSeverity, string> = {
    info: 'ℹ️',
    warning: '⚠️',
    error: '❌',
    critical: '🚨',
  };
  return emojis[severity];
}

/**
 * Get source icon for display
 */
export function getSourceIcon(source: ErrorSource): string {
  const icons: Record<ErrorSource, string> = {
    styrby: '🔗',
    agent: '🤖',
    build: '🔨',
    network: '🌐',
    user: '👤',
    unknown: '❓',
  };
  return icons[source];
}
