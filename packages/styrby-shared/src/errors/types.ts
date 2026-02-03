/**
 * Error Attribution Types
 *
 * Defines error sources, categories, and attribution results.
 */

/**
 * Error source categories
 */
export type ErrorSource =
  | 'styrby'   // Styrby app/infrastructure error
  | 'agent'    // AI agent error (Claude, Codex, Gemini)
  | 'build'    // Build tool error (npm, webpack, tsc, etc.)
  | 'network'  // Network/connectivity error
  | 'user'     // User-caused error (invalid input, permissions)
  | 'unknown'; // Unable to classify

/**
 * Error severity levels
 */
export type ErrorSeverity = 'info' | 'warning' | 'error' | 'critical';

/**
 * Specific error categories within each source
 */
export type ErrorCategory =
  // Styrby errors
  | 'relay_connection'
  | 'relay_timeout'
  | 'auth_expired'
  | 'auth_invalid'
  | 'storage_full'
  | 'config_invalid'
  // Agent errors
  | 'agent_timeout'
  | 'agent_rate_limit'
  | 'agent_context_limit'
  | 'agent_invalid_response'
  | 'agent_permission_denied'
  | 'agent_api_error'
  // Build errors
  | 'build_syntax'
  | 'build_type'
  | 'build_dependency'
  | 'build_config'
  | 'build_memory'
  | 'test_failure'
  // Network errors
  | 'network_offline'
  | 'network_timeout'
  | 'network_dns'
  | 'network_ssl'
  | 'network_cors'
  // User errors
  | 'user_input'
  | 'user_permission'
  | 'user_quota'
  // Unknown
  | 'unknown';

/**
 * Fix suggestion with actionability
 */
export interface FixSuggestion {
  /** Short description of the fix */
  title: string;
  /** Detailed explanation */
  description: string;
  /** Whether this can be auto-fixed */
  autoFixable: boolean;
  /** Command or action to fix (if autoFixable) */
  action?: string;
  /** Link to documentation */
  docUrl?: string;
}

/**
 * Error attribution result
 */
export interface ErrorAttribution {
  /** Primary error source */
  source: ErrorSource;
  /** Specific error category */
  category: ErrorCategory;
  /** Confidence score (0-1) */
  confidence: number;
  /** Error severity */
  severity: ErrorSeverity;
  /** Human-readable summary */
  summary: string;
  /** Suggested fixes */
  suggestions: FixSuggestion[];
  /** Original error message */
  originalMessage: string;
  /** Parsed error details */
  details?: Record<string, unknown>;
  /** Related file/line if applicable */
  location?: {
    file?: string;
    line?: number;
    column?: number;
  };
}

/**
 * Error pattern for matching
 */
export interface ErrorPattern {
  /** Unique pattern ID */
  id: string;
  /** Error source this pattern matches */
  source: ErrorSource;
  /** Specific category */
  category: ErrorCategory;
  /** Regex patterns to match */
  patterns: RegExp[];
  /** Keywords to look for */
  keywords: string[];
  /** Default severity */
  severity: ErrorSeverity;
  /** Pattern-specific suggestions */
  suggestions: FixSuggestion[];
  /** Extract details from match */
  extractDetails?: (match: RegExpMatchArray) => Record<string, unknown>;
}

/**
 * Source color configuration
 */
export const SOURCE_COLORS: Record<ErrorSource, { color: string; bgColor: string; label: string }> = {
  styrby: { color: '#f97316', bgColor: 'rgba(249, 115, 22, 0.1)', label: 'Styrby' },
  agent: { color: '#ef4444', bgColor: 'rgba(239, 68, 68, 0.1)', label: 'Agent' },
  build: { color: '#3b82f6', bgColor: 'rgba(59, 130, 246, 0.1)', label: 'Build' },
  network: { color: '#eab308', bgColor: 'rgba(234, 179, 8, 0.1)', label: 'Network' },
  user: { color: '#8b5cf6', bgColor: 'rgba(139, 92, 246, 0.1)', label: 'User' },
  unknown: { color: '#71717a', bgColor: 'rgba(113, 113, 122, 0.1)', label: 'Unknown' },
};

/**
 * Severity color configuration
 */
export const SEVERITY_COLORS: Record<ErrorSeverity, { color: string; bgColor: string }> = {
  info: { color: '#3b82f6', bgColor: 'rgba(59, 130, 246, 0.1)' },
  warning: { color: '#eab308', bgColor: 'rgba(234, 179, 8, 0.1)' },
  error: { color: '#ef4444', bgColor: 'rgba(239, 68, 68, 0.1)' },
  critical: { color: '#dc2626', bgColor: 'rgba(220, 38, 38, 0.15)' },
};
