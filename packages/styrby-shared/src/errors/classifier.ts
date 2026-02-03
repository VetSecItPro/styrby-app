/**
 * Error Classifier
 *
 * Matches error messages against known patterns to determine source and category.
 */

import type { ErrorAttribution, ErrorPattern, ErrorSource, ErrorCategory } from './types.js';
import { ALL_PATTERNS } from './patterns.js';

/**
 * Match result with confidence score
 */
interface PatternMatch {
  pattern: ErrorPattern;
  confidence: number;
  matchedPattern: RegExp;
  match: RegExpMatchArray;
}

/**
 * Calculate keyword match score
 */
function calculateKeywordScore(message: string, keywords: string[]): number {
  const lowerMessage = message.toLowerCase();
  const matches = keywords.filter((kw) => lowerMessage.includes(kw.toLowerCase()));
  return matches.length / keywords.length;
}

/**
 * Find all matching patterns for an error message
 */
function findMatches(message: string): PatternMatch[] {
  const matches: PatternMatch[] = [];

  for (const pattern of ALL_PATTERNS) {
    for (const regex of pattern.patterns) {
      const match = message.match(regex);
      if (match) {
        // Calculate confidence based on pattern match + keyword overlap
        const keywordScore = calculateKeywordScore(message, pattern.keywords);
        const confidence = 0.7 + keywordScore * 0.3; // Base 70% + up to 30% from keywords

        matches.push({
          pattern,
          confidence,
          matchedPattern: regex,
          match,
        });
        break; // Only match once per pattern
      }
    }
  }

  // Sort by confidence descending
  return matches.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Extract file location from error message
 */
function extractLocation(
  message: string
): { file?: string; line?: number; column?: number } | undefined {
  // Common patterns:
  // /path/to/file.ts:10:5
  // /path/to/file.ts(10,5)
  // at /path/to/file.ts:10
  // Error in ./src/file.ts

  const patterns = [
    // TypeScript/ESLint: file:line:column
    /(?:at\s+)?([\/\w\-\.]+\.\w+):(\d+):(\d+)/,
    // Visual Studio style: file(line,column)
    /([\/\w\-\.]+\.\w+)\((\d+),(\d+)\)/,
    // Simple file:line
    /(?:at\s+)?([\/\w\-\.]+\.\w+):(\d+)/,
    // Webpack style: ./src/file.ts
    /(?:Error in |Failed to compile)\s*\.?([\/\w\-\.]+\.\w+)/,
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match) {
      return {
        file: match[1],
        line: match[2] ? parseInt(match[2], 10) : undefined,
        column: match[3] ? parseInt(match[3], 10) : undefined,
      };
    }
  }

  return undefined;
}

/**
 * Generate a human-readable summary for the error
 */
function generateSummary(source: ErrorSource, category: ErrorCategory, message: string): string {
  const summaries: Record<ErrorCategory, string> = {
    // Styrby
    relay_connection: 'Connection to Styrby relay failed',
    relay_timeout: 'Relay connection timed out',
    auth_expired: 'Your authentication session has expired',
    auth_invalid: 'Invalid authentication credentials',
    storage_full: 'Local storage quota exceeded',
    config_invalid: 'Invalid configuration detected',
    // Agent
    agent_timeout: 'AI agent request timed out',
    agent_rate_limit: 'API rate limit exceeded',
    agent_context_limit: 'Conversation context limit reached',
    agent_invalid_response: 'Invalid response from AI agent',
    agent_permission_denied: 'Permission denied by AI agent',
    agent_api_error: 'AI provider API error',
    // Build
    build_syntax: 'Syntax error in source code',
    build_type: 'TypeScript type error',
    build_dependency: 'Package dependency issue',
    build_config: 'Build configuration error',
    build_memory: 'Build ran out of memory',
    test_failure: 'Test suite failed',
    // Network
    network_offline: 'No internet connection',
    network_timeout: 'Network request timed out',
    network_dns: 'DNS resolution failed',
    network_ssl: 'SSL/TLS certificate error',
    network_cors: 'Cross-origin request blocked',
    // User
    user_input: 'Invalid user input',
    user_permission: 'Permission denied',
    user_quota: 'Usage quota exceeded',
    // Unknown
    unknown: 'An unexpected error occurred',
  };

  return summaries[category] || `${source} error: ${message.slice(0, 100)}`;
}

/**
 * Classify an error message and return attribution
 */
export function classifyError(message: string): ErrorAttribution {
  const matches = findMatches(message);

  if (matches.length === 0) {
    // No pattern matched - return unknown
    return {
      source: 'unknown',
      category: 'unknown',
      confidence: 0.1,
      severity: 'error',
      summary: 'An unexpected error occurred',
      suggestions: [
        {
          title: 'Check the error message',
          description: 'Review the full error output for more details.',
          autoFixable: false,
        },
        {
          title: 'Search for solutions',
          description: 'Search the error message online for potential fixes.',
          autoFixable: false,
        },
      ],
      originalMessage: message,
      location: extractLocation(message),
    };
  }

  const bestMatch = matches[0];
  const { pattern, confidence, match } = bestMatch;

  // Extract additional details if the pattern has an extractor
  const details = pattern.extractDetails ? pattern.extractDetails(match) : undefined;

  return {
    source: pattern.source,
    category: pattern.category,
    confidence,
    severity: pattern.severity,
    summary: generateSummary(pattern.source, pattern.category, message),
    suggestions: pattern.suggestions,
    originalMessage: message,
    details,
    location: extractLocation(message),
  };
}

/**
 * Classify multiple error messages and deduplicate by category
 */
export function classifyErrors(messages: string[]): ErrorAttribution[] {
  const attributions = messages.map(classifyError);

  // Deduplicate by category, keeping highest confidence
  const byCategory = new Map<ErrorCategory, ErrorAttribution>();

  for (const attr of attributions) {
    const existing = byCategory.get(attr.category);
    if (!existing || attr.confidence > existing.confidence) {
      byCategory.set(attr.category, attr);
    }
  }

  // Sort by severity (critical > error > warning > info)
  const severityOrder = { critical: 0, error: 1, warning: 2, info: 3 };
  return Array.from(byCategory.values()).sort(
    (a, b) => severityOrder[a.severity] - severityOrder[b.severity]
  );
}

/**
 * Check if an error is likely caused by a specific source
 */
export function isErrorFromSource(message: string, source: ErrorSource): boolean {
  const attribution = classifyError(message);
  return attribution.source === source && attribution.confidence >= 0.5;
}

/**
 * Get pattern by ID
 */
export function getPatternById(id: string): ErrorPattern | undefined {
  return ALL_PATTERNS.find((p) => p.id === id);
}
