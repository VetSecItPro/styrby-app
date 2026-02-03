/**
 * Error Patterns
 *
 * Predefined patterns for classifying common errors.
 */

import type { ErrorPattern } from './types.js';

/**
 * Styrby infrastructure error patterns
 */
export const STYRBY_PATTERNS: ErrorPattern[] = [
  {
    id: 'relay_connection_failed',
    source: 'styrby',
    category: 'relay_connection',
    patterns: [
      /failed to connect to relay/i,
      /relay connection (failed|error|timeout)/i,
      /supabase.*realtime.*error/i,
      /websocket.*connection.*failed/i,
    ],
    keywords: ['relay', 'connection', 'websocket', 'realtime'],
    severity: 'error',
    suggestions: [
      {
        title: 'Check your internet connection',
        description: 'Ensure you have a stable internet connection and try again.',
        autoFixable: false,
      },
      {
        title: 'Restart the CLI',
        description: 'Run `styrby restart` to reset the connection.',
        autoFixable: true,
        action: 'styrby restart',
      },
    ],
  },
  {
    id: 'auth_expired',
    source: 'styrby',
    category: 'auth_expired',
    patterns: [
      /token.*expired/i,
      /session.*expired/i,
      /authentication.*expired/i,
      /refresh.*token.*invalid/i,
    ],
    keywords: ['token', 'expired', 'session', 'authentication'],
    severity: 'warning',
    suggestions: [
      {
        title: 'Re-authenticate',
        description: 'Your session has expired. Please log in again.',
        autoFixable: true,
        action: 'styrby auth',
      },
    ],
  },
];

/**
 * Agent error patterns
 */
export const AGENT_PATTERNS: ErrorPattern[] = [
  {
    id: 'agent_rate_limit',
    source: 'agent',
    category: 'agent_rate_limit',
    patterns: [
      /rate limit/i,
      /too many requests/i,
      /429/,
      /quota exceeded/i,
      /requests per minute/i,
    ],
    keywords: ['rate', 'limit', '429', 'quota', 'throttle'],
    severity: 'warning',
    suggestions: [
      {
        title: 'Wait and retry',
        description: 'You\'ve hit the API rate limit. Wait a few minutes before trying again.',
        autoFixable: false,
      },
      {
        title: 'Upgrade your plan',
        description: 'Consider upgrading to a higher tier for increased rate limits.',
        autoFixable: false,
        docUrl: '/pricing',
      },
    ],
  },
  {
    id: 'agent_context_limit',
    source: 'agent',
    category: 'agent_context_limit',
    patterns: [
      /context.*length.*exceeded/i,
      /maximum.*tokens/i,
      /context.*window.*full/i,
      /too many tokens/i,
    ],
    keywords: ['context', 'tokens', 'length', 'exceeded', 'window'],
    severity: 'warning',
    suggestions: [
      {
        title: 'Start a new session',
        description: 'The conversation is too long. Start a fresh session to continue.',
        autoFixable: true,
        action: 'styrby new',
      },
      {
        title: 'Summarize context',
        description: 'Ask the agent to summarize the conversation before continuing.',
        autoFixable: false,
      },
    ],
  },
  {
    id: 'agent_api_error',
    source: 'agent',
    category: 'agent_api_error',
    patterns: [
      /anthropic.*error/i,
      /openai.*error/i,
      /gemini.*error/i,
      /api.*error.*5\d{2}/i,
      /internal server error/i,
    ],
    keywords: ['api', 'server', '500', '502', '503'],
    severity: 'error',
    suggestions: [
      {
        title: 'Retry the request',
        description: 'The AI service encountered an error. Try your request again.',
        autoFixable: false,
      },
      {
        title: 'Check service status',
        description: 'Check the AI provider\'s status page for any ongoing incidents.',
        autoFixable: false,
      },
    ],
  },
];

/**
 * Build tool error patterns
 */
export const BUILD_PATTERNS: ErrorPattern[] = [
  {
    id: 'typescript_error',
    source: 'build',
    category: 'build_type',
    patterns: [
      /TS\d{4,5}:/,
      /typescript.*error/i,
      /type.*is not assignable/i,
      /property.*does not exist/i,
      /cannot find module/i,
    ],
    keywords: ['typescript', 'type', 'TS', 'tsc'],
    severity: 'error',
    suggestions: [
      {
        title: 'Fix type errors',
        description: 'Review the TypeScript errors and fix the type mismatches.',
        autoFixable: false,
      },
      {
        title: 'Run type check',
        description: 'Run `npm run typecheck` to see all type errors.',
        autoFixable: true,
        action: 'npm run typecheck',
      },
    ],
    extractDetails: (match) => {
      const tsError = match[0].match(/TS(\d+)/);
      return tsError ? { errorCode: `TS${tsError[1]}` } : {};
    },
  },
  {
    id: 'eslint_error',
    source: 'build',
    category: 'build_syntax',
    patterns: [
      /eslint.*error/i,
      /\d+ errors? and \d+ warnings?/i,
      /parsing error/i,
    ],
    keywords: ['eslint', 'lint', 'parsing'],
    severity: 'warning',
    suggestions: [
      {
        title: 'Fix lint errors',
        description: 'Run the linter with auto-fix to resolve issues.',
        autoFixable: true,
        action: 'npm run lint -- --fix',
      },
    ],
  },
  {
    id: 'npm_dependency',
    source: 'build',
    category: 'build_dependency',
    patterns: [
      /npm ERR!/,
      /ERESOLVE/i,
      /peer dep/i,
      /could not resolve/i,
      /module not found/i,
    ],
    keywords: ['npm', 'dependency', 'module', 'resolve', 'ERESOLVE'],
    severity: 'error',
    suggestions: [
      {
        title: 'Clear cache and reinstall',
        description: 'Remove node_modules and reinstall dependencies.',
        autoFixable: true,
        action: 'rm -rf node_modules && npm install',
      },
      {
        title: 'Use legacy peer deps',
        description: 'If peer dependency conflicts persist, try --legacy-peer-deps.',
        autoFixable: true,
        action: 'npm install --legacy-peer-deps',
      },
    ],
  },
  {
    id: 'test_failure',
    source: 'build',
    category: 'test_failure',
    patterns: [
      /test.*failed/i,
      /\d+ failed/i,
      /FAIL\s+\w+/,
      /AssertionError/i,
      /expect.*received/i,
    ],
    keywords: ['test', 'failed', 'FAIL', 'assertion', 'expect'],
    severity: 'error',
    suggestions: [
      {
        title: 'Review test failures',
        description: 'Check the test output to understand what failed.',
        autoFixable: false,
      },
      {
        title: 'Run tests in watch mode',
        description: 'Use watch mode to iterate on fixes.',
        autoFixable: true,
        action: 'npm test -- --watch',
      },
    ],
  },
];

/**
 * Network error patterns
 */
export const NETWORK_PATTERNS: ErrorPattern[] = [
  {
    id: 'network_offline',
    source: 'network',
    category: 'network_offline',
    patterns: [
      /network.*offline/i,
      /no internet/i,
      /ERR_INTERNET_DISCONNECTED/i,
      /net::ERR_/i,
    ],
    keywords: ['offline', 'internet', 'network', 'disconnected'],
    severity: 'error',
    suggestions: [
      {
        title: 'Check internet connection',
        description: 'Ensure you are connected to the internet.',
        autoFixable: false,
      },
    ],
  },
  {
    id: 'network_timeout',
    source: 'network',
    category: 'network_timeout',
    patterns: [
      /timeout/i,
      /ETIMEDOUT/i,
      /ECONNRESET/i,
      /request timed out/i,
    ],
    keywords: ['timeout', 'ETIMEDOUT', 'ECONNRESET'],
    severity: 'warning',
    suggestions: [
      {
        title: 'Retry the request',
        description: 'The request timed out. Try again.',
        autoFixable: false,
      },
      {
        title: 'Check firewall settings',
        description: 'Ensure your firewall isn\'t blocking the connection.',
        autoFixable: false,
      },
    ],
  },
  {
    id: 'network_dns',
    source: 'network',
    category: 'network_dns',
    patterns: [
      /ENOTFOUND/i,
      /dns.*failed/i,
      /getaddrinfo/i,
    ],
    keywords: ['DNS', 'ENOTFOUND', 'getaddrinfo'],
    severity: 'error',
    suggestions: [
      {
        title: 'Check DNS settings',
        description: 'The domain could not be resolved. Check your DNS settings.',
        autoFixable: false,
      },
      {
        title: 'Try alternative DNS',
        description: 'Try using 8.8.8.8 or 1.1.1.1 as your DNS server.',
        autoFixable: false,
      },
    ],
  },
];

/**
 * All error patterns combined
 */
export const ALL_PATTERNS: ErrorPattern[] = [
  ...STYRBY_PATTERNS,
  ...AGENT_PATTERNS,
  ...BUILD_PATTERNS,
  ...NETWORK_PATTERNS,
];
