/**
 * Tests for the Fix Suggestions Utilities
 *
 * Validates suggestion filtering (auto-fixable vs manual), formatting output
 * for plain text and markdown, grouping by type, contextual suggestion
 * augmentation, and source-specific help resource lookup.
 */

import { describe, it, expect } from 'vitest';
import {
  getAutoFixableSuggestions,
  getBestSuggestion,
  getAutoFixCommand,
  hasActionableSuggestions,
  canAutoFix,
  formatSuggestions,
  generateContextualSuggestions,
  groupSuggestionsByType,
  createSuggestion,
  getHelpResources,
  getSeverityEmoji,
  getSourceIcon,
} from '../../src/errors/suggestions';
import type { ErrorAttribution, FixSuggestion } from '../../src/errors/types';

// ---------------------------------------------------------------------------
// Helpers to build minimal ErrorAttribution objects for testing
// ---------------------------------------------------------------------------

/**
 * Build a minimal ErrorAttribution for use in tests.
 *
 * @param overrides - Partial overrides applied on top of sensible defaults
 * @returns A complete ErrorAttribution suitable for passing to suggestion utils
 */
function makeAttribution(overrides: Partial<ErrorAttribution> = {}): ErrorAttribution {
  return {
    source: 'agent',
    category: 'agent_rate_limit',
    confidence: 0.9,
    severity: 'warning',
    summary: 'Rate limit exceeded',
    suggestions: [],
    originalMessage: 'rate limit exceeded',
    ...overrides,
  };
}

/**
 * Build a FixSuggestion for use in tests.
 *
 * @param overrides - Partial overrides applied on top of sensible defaults
 * @returns A FixSuggestion object
 */
function makeSuggestion(overrides: Partial<FixSuggestion> = {}): FixSuggestion {
  return {
    title: 'Retry',
    description: 'Try again after a short wait.',
    autoFixable: false,
    ...overrides,
  };
}

// =============================================================================
// getAutoFixableSuggestions()
// =============================================================================

describe('getAutoFixableSuggestions()', () => {
  it('returns only suggestions with autoFixable=true and an action', () => {
    const attr = makeAttribution({
      suggestions: [
        makeSuggestion({ autoFixable: true, action: 'styrby restart' }),
        makeSuggestion({ autoFixable: false }),
        makeSuggestion({ autoFixable: true }), // no action — excluded
      ],
    });
    const results = getAutoFixableSuggestions(attr);
    expect(results.length).toBe(1);
    expect(results[0].action).toBe('styrby restart');
  });

  it('returns an empty array when no suggestion is auto-fixable', () => {
    const attr = makeAttribution({
      suggestions: [makeSuggestion(), makeSuggestion()],
    });
    expect(getAutoFixableSuggestions(attr)).toEqual([]);
  });

  it('returns all auto-fixable suggestions when multiple qualify', () => {
    const attr = makeAttribution({
      suggestions: [
        makeSuggestion({ autoFixable: true, action: 'cmd1' }),
        makeSuggestion({ autoFixable: true, action: 'cmd2' }),
        makeSuggestion({ autoFixable: false }),
      ],
    });
    expect(getAutoFixableSuggestions(attr).length).toBe(2);
  });
});

// =============================================================================
// getBestSuggestion()
// =============================================================================

describe('getBestSuggestion()', () => {
  it('returns the first suggestion', () => {
    const first = makeSuggestion({ title: 'First' });
    const attr = makeAttribution({ suggestions: [first, makeSuggestion({ title: 'Second' })] });
    expect(getBestSuggestion(attr)?.title).toBe('First');
  });

  it('returns undefined when suggestions array is empty', () => {
    const attr = makeAttribution({ suggestions: [] });
    expect(getBestSuggestion(attr)).toBeUndefined();
  });
});

// =============================================================================
// getAutoFixCommand()
// =============================================================================

describe('getAutoFixCommand()', () => {
  it('returns the action string of the first auto-fixable suggestion', () => {
    const attr = makeAttribution({
      suggestions: [
        makeSuggestion({ autoFixable: true, action: 'styrby auth' }),
      ],
    });
    expect(getAutoFixCommand(attr)).toBe('styrby auth');
  });

  it('returns undefined when there are no auto-fixable suggestions', () => {
    const attr = makeAttribution({ suggestions: [makeSuggestion()] });
    expect(getAutoFixCommand(attr)).toBeUndefined();
  });

  it('returns undefined when no suggestion has an action property', () => {
    const attr = makeAttribution({
      suggestions: [makeSuggestion({ autoFixable: true })],
    });
    expect(getAutoFixCommand(attr)).toBeUndefined();
  });
});

// =============================================================================
// hasActionableSuggestions()
// =============================================================================

describe('hasActionableSuggestions()', () => {
  it('returns true when there is at least one suggestion', () => {
    const attr = makeAttribution({ suggestions: [makeSuggestion()] });
    expect(hasActionableSuggestions(attr)).toBe(true);
  });

  it('returns false when the suggestions array is empty', () => {
    const attr = makeAttribution({ suggestions: [] });
    expect(hasActionableSuggestions(attr)).toBe(false);
  });
});

// =============================================================================
// canAutoFix()
// =============================================================================

describe('canAutoFix()', () => {
  it('returns true when there is an auto-fixable suggestion with an action', () => {
    const attr = makeAttribution({
      suggestions: [makeSuggestion({ autoFixable: true, action: 'npm install' })],
    });
    expect(canAutoFix(attr)).toBe(true);
  });

  it('returns false when no suggestion is auto-fixable', () => {
    const attr = makeAttribution({ suggestions: [makeSuggestion()] });
    expect(canAutoFix(attr)).toBe(false);
  });

  it('returns false when all auto-fixable suggestions lack an action', () => {
    const attr = makeAttribution({
      suggestions: [makeSuggestion({ autoFixable: true })],
    });
    expect(canAutoFix(attr)).toBe(false);
  });
});

// =============================================================================
// formatSuggestions()
// =============================================================================

describe('formatSuggestions()', () => {
  const suggestions: FixSuggestion[] = [
    { title: 'Wait', description: 'Give it a moment.', autoFixable: false },
    { title: 'Retry', description: 'Try the request again.', autoFixable: true, action: 'styrby retry' },
  ];

  it('returns a non-empty string for a non-empty suggestions array', () => {
    const output = formatSuggestions(suggestions);
    expect(output.length).toBeGreaterThan(0);
  });

  it('includes the title and description of each suggestion', () => {
    const output = formatSuggestions(suggestions);
    expect(output).toContain('Wait');
    expect(output).toContain('Give it a moment.');
    expect(output).toContain('Retry');
  });

  it('includes the action command when includeActions is true (default)', () => {
    const output = formatSuggestions(suggestions);
    expect(output).toContain('styrby retry');
  });

  it('omits the action command when includeActions is false', () => {
    const output = formatSuggestions(suggestions, { includeActions: false });
    expect(output).not.toContain('styrby retry');
  });

  it('uses numbered bullets in plain text mode', () => {
    const output = formatSuggestions(suggestions, { markdown: false });
    expect(output).toContain('1.');
    expect(output).toContain('2.');
  });

  it('uses dash bullets in markdown mode', () => {
    const output = formatSuggestions(suggestions, { markdown: true });
    expect(output.startsWith('-')).toBe(true);
  });

  it('includes docUrl in markdown mode when present', () => {
    const withDoc: FixSuggestion[] = [
      { title: 'Docs', description: 'Read the docs.', autoFixable: false, docUrl: '/pricing' },
    ];
    const output = formatSuggestions(withDoc, { markdown: true });
    expect(output).toContain('/pricing');
  });

  it('returns an empty string for an empty array', () => {
    expect(formatSuggestions([])).toBe('');
  });
});

// =============================================================================
// generateContextualSuggestions()
// =============================================================================

describe('generateContextualSuggestions()', () => {
  it('returns at least as many suggestions as the attribution already has', () => {
    const attr = makeAttribution({
      suggestions: [makeSuggestion()],
    });
    const result = generateContextualSuggestions(attr);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it('adds a TypeScript-specific suggestion for a .ts file with build_type category', () => {
    const attr = makeAttribution({
      source: 'build',
      category: 'build_type',
      suggestions: [],
      location: { file: '/src/utils/foo.ts', line: 10 },
    });
    const result = generateContextualSuggestions(attr);
    const tsHint = result.find((s) => s.title.toLowerCase().includes('type'));
    expect(tsHint).toBeDefined();
  });

  it('adds a run-single-test suggestion for test files', () => {
    const attr = makeAttribution({
      source: 'build',
      category: 'test_failure',
      suggestions: [],
      location: { file: '/src/utils/foo.test.ts' },
    });
    const result = generateContextualSuggestions(attr);
    const testHint = result.find((s) => s.autoFixable && s.action?.includes('foo.test.ts'));
    expect(testHint).toBeDefined();
  });

  it('prepends a critical-severity warning for critical errors', () => {
    const attr = makeAttribution({
      severity: 'critical',
      suggestions: [makeSuggestion()],
    });
    const result = generateContextualSuggestions(attr);
    expect(result[0].title.toLowerCase()).toContain('stop');
  });

  it('does not alter suggestions for a non-critical error with no file location', () => {
    const original = [makeSuggestion()];
    const attr = makeAttribution({ severity: 'warning', suggestions: original, location: undefined });
    const result = generateContextualSuggestions(attr);
    // Should be identical to the original suggestions since no augmentation applies
    expect(result).toEqual(original);
  });
});

// =============================================================================
// groupSuggestionsByType()
// =============================================================================

describe('groupSuggestionsByType()', () => {
  const suggestions: FixSuggestion[] = [
    { title: 'Auto', description: 'Run it.', autoFixable: true, action: 'cmd' },
    { title: 'Manual', description: 'Do it yourself.', autoFixable: false },
    { title: 'Docs', description: 'Read the docs.', autoFixable: false, docUrl: '/docs' },
  ];

  it('places auto-fixable suggestions with action in the autoFixable group', () => {
    const { autoFixable } = groupSuggestionsByType(suggestions);
    expect(autoFixable.length).toBe(1);
    expect(autoFixable[0].title).toBe('Auto');
  });

  it('places non-auto-fixable suggestions without docUrl in the manual group', () => {
    const { manual } = groupSuggestionsByType(suggestions);
    expect(manual.length).toBe(1);
    expect(manual[0].title).toBe('Manual');
  });

  it('places suggestions with docUrl in the documentation group', () => {
    const { documentation } = groupSuggestionsByType(suggestions);
    expect(documentation.length).toBe(1);
    expect(documentation[0].title).toBe('Docs');
  });

  it('returns three empty arrays for an empty input', () => {
    const result = groupSuggestionsByType([]);
    expect(result.autoFixable).toEqual([]);
    expect(result.manual).toEqual([]);
    expect(result.documentation).toEqual([]);
  });
});

// =============================================================================
// createSuggestion()
// =============================================================================

describe('createSuggestion()', () => {
  it('creates a suggestion with the given title and description', () => {
    const s = createSuggestion('Fix it', 'Run the fix command.');
    expect(s.title).toBe('Fix it');
    expect(s.description).toBe('Run the fix command.');
  });

  it('sets autoFixable to false when no action is provided', () => {
    const s = createSuggestion('Docs', 'Read the docs.');
    expect(s.autoFixable).toBe(false);
  });

  it('sets autoFixable to true when an action is provided', () => {
    const s = createSuggestion('Run', 'Execute.', { action: 'npm run fix' });
    expect(s.autoFixable).toBe(true);
    expect(s.action).toBe('npm run fix');
  });

  it('includes docUrl when provided', () => {
    const s = createSuggestion('Docs', 'Read the docs.', { docUrl: '/docs/troubleshooting' });
    expect(s.docUrl).toBe('/docs/troubleshooting');
  });

  it('does not include docUrl when not provided', () => {
    const s = createSuggestion('No Docs', 'Nothing extra.');
    expect(s.docUrl).toBeUndefined();
  });
});

// =============================================================================
// getHelpResources()
// =============================================================================

describe('getHelpResources()', () => {
  it('returns a non-empty array for source "styrby"', () => {
    const resources = getHelpResources('styrby');
    expect(resources.length).toBeGreaterThan(0);
  });

  it('returns resources with title and url for source "agent"', () => {
    const resources = getHelpResources('agent');
    for (const r of resources) {
      expect(typeof r.title).toBe('string');
      expect(typeof r.url).toBe('string');
      expect(r.url.startsWith('http')).toBe(true);
    }
  });

  it('returns resources for source "build"', () => {
    expect(getHelpResources('build').length).toBeGreaterThan(0);
  });

  it('returns resources for source "network"', () => {
    expect(getHelpResources('network').length).toBeGreaterThan(0);
  });

  it('returns resources for source "unknown"', () => {
    expect(getHelpResources('unknown').length).toBeGreaterThan(0);
  });

  it('returns resources for source "user"', () => {
    expect(getHelpResources('user').length).toBeGreaterThan(0);
  });
});

// =============================================================================
// getSeverityEmoji()
// =============================================================================

describe('getSeverityEmoji()', () => {
  it('returns a non-empty string for each severity level', () => {
    const severities = ['info', 'warning', 'error', 'critical'] as const;
    for (const s of severities) {
      const emoji = getSeverityEmoji(s);
      expect(typeof emoji).toBe('string');
      expect(emoji.length).toBeGreaterThan(0);
    }
  });

  it('returns distinct emojis for different severity levels', () => {
    const emojis = new Set([
      getSeverityEmoji('info'),
      getSeverityEmoji('warning'),
      getSeverityEmoji('error'),
      getSeverityEmoji('critical'),
    ]);
    expect(emojis.size).toBe(4);
  });
});

// =============================================================================
// getSourceIcon()
// =============================================================================

describe('getSourceIcon()', () => {
  it('returns a non-empty string for each source', () => {
    const sources = ['styrby', 'agent', 'build', 'network', 'user', 'unknown'] as const;
    for (const s of sources) {
      const icon = getSourceIcon(s);
      expect(typeof icon).toBe('string');
      expect(icon.length).toBeGreaterThan(0);
    }
  });

  it('returns distinct icons for different sources', () => {
    const icons = new Set([
      getSourceIcon('styrby'),
      getSourceIcon('agent'),
      getSourceIcon('build'),
      getSourceIcon('network'),
      getSourceIcon('user'),
      getSourceIcon('unknown'),
    ]);
    expect(icons.size).toBe(6);
  });
});
