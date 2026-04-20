/**
 * Error Attribution Types
 *
 * Defines error sources, categories, and attribution results for the
 * Styrby error intelligence system.
 *
 * WHY this system exists: When an AI agent produces an error (e.g., a bash
 * command fails), it is often unclear whether the failure is the agent's
 * fault, a user permissions issue, a network blip, or a Styrby relay bug.
 * Error attribution answers that question automatically so the mobile app
 * can show the right fix suggestion rather than a generic error message.
 *
 * The attribution pipeline:
 * 1. Raw error string arrives from the CLI relay
 * 2. Pattern matching assigns source + category + confidence
 * 3. The mobile UI renders the appropriate fix card
 * 4. Auto-fixable errors (e.g., `npm install`) can be triggered from mobile
 */

/**
 * Top-level source of an error, used to route to the correct UI error card
 * and to track which error class affects users most in analytics.
 *
 * WHY separate source from category: Source identifies who owns the fix
 * (user vs. Styrby team vs. AI provider), while category gives actionable
 * detail. A 'network/network_timeout' error means "check your connection";
 * a 'styrby/relay_connection' means "Styrby infrastructure problem - we're
 * on it."
 */
export type ErrorSource =
  | 'styrby'   // Styrby app/infrastructure error
  | 'agent'    // AI agent error (Claude, Codex, Gemini)
  | 'build'    // Build tool error (npm, webpack, tsc, etc.)
  | 'network'  // Network/connectivity error
  | 'user'     // User-caused error (invalid input, permissions)
  | 'unknown'; // Unable to classify

/**
 * Severity level assigned to an attributed error.
 *
 * Drives both UI rendering (banner color, icon) and notification priority.
 * Maps to the notification priority system: 'critical' errors always
 * generate a priority-1 push notification; 'info' may be suppressed under
 * quiet hours or if the user has raised their notification threshold.
 *
 * Scale: info < warning < error < critical
 */
export type ErrorSeverity = 'info' | 'warning' | 'error' | 'critical';

/**
 * Granular error category within a source, mapped to actionable fix suggestions.
 *
 * WHY fine-grained categories: Each category maps to a specific help card and
 * (where possible) an auto-fix action. For example, 'agent_context_limit'
 * shows a "Start new session" button; 'build_dependency' shows "Run npm install".
 * A flat error string would force the UI to display a generic message.
 *
 * Categories are grouped by source prefix for readability and to make
 * pattern-matching logic easier to audit.
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
 * A fix suggestion rendered in the mobile error card for an attributed error.
 *
 * Multiple suggestions can be attached to a single ErrorAttribution. When
 * `autoFixable` is true, the mobile app renders a primary action button that
 * sends the fix `action` string to the CLI relay as a command. Non-auto-fixable
 * suggestions render as descriptive text with an optional documentation link.
 *
 * WHY `autoFixable` on the shared type: Both the mobile UI and the CLI relay
 * need to know whether a fix can be triggered remotely. The shared type keeps
 * this contract in one place so both sides stay in sync.
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
 * The complete result of attributing a raw error string to a source + category.
 *
 * Produced by the error attribution engine in styrby-cli when a session
 * error event arrives, then transmitted over the relay to the mobile app.
 * The mobile app uses this to render the error card: banner color (from
 * SOURCE_COLORS), severity badge, summary text, and fix suggestion buttons.
 *
 * WHY `confidence` on the result: Some errors are ambiguous — a timeout could
 * be a network issue or an agent issue. The confidence score (0-1) lets the UI
 * hedge its language ("This looks like a network issue") when confidence is low,
 * rather than asserting a cause that might be wrong.
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
 * A registered pattern used by the attribution engine to classify raw errors.
 *
 * The attribution engine holds a list of ErrorPatterns and tests each one
 * against an incoming error message using `patterns` (regex) and `keywords`
 * (string match). The first pattern with a hit determines the source and
 * category of the resulting ErrorAttribution.
 *
 * WHY both `patterns` and `keywords`: Regex is powerful but slow at scale.
 * Keywords are tested first as a cheap pre-filter; regex only runs when
 * keywords match. This keeps attribution fast even with 100+ patterns.
 *
 * `extractDetails` is an optional callback that pulls structured data out
 * of the regex match (e.g., the file path from a TypeScript error) for
 * inclusion in ErrorAttribution.details and the location field.
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
 * Display colors for each error source, used by the mobile and web error cards.
 *
 * Shared here so both styrby-mobile and styrby-web render identical colors for
 * the same source. Each entry contains:
 * - `color`: foreground text / icon color (hex)
 * - `bgColor`: semi-transparent background for the badge/banner
 * - `label`: human-readable source name for display
 *
 * WHY in the shared package: If these lived separately in each app, they
 * could drift over time. A single source of truth ensures the "styrby" color
 * is always orange whether the user is on iOS or web.
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
 * Display colors for each severity level, used by error badges and notification banners.
 *
 * Shared across styrby-mobile and styrby-web for visual consistency. The
 * 'critical' severity intentionally uses a higher-opacity background than
 * other levels to draw immediate attention (e.g., relay disconnects during
 * an active agent session).
 */
export const SEVERITY_COLORS: Record<ErrorSeverity, { color: string; bgColor: string }> = {
  info: { color: '#3b82f6', bgColor: 'rgba(59, 130, 246, 0.1)' },
  warning: { color: '#eab308', bgColor: 'rgba(234, 179, 8, 0.1)' },
  error: { color: '#ef4444', bgColor: 'rgba(239, 68, 68, 0.1)' },
  critical: { color: '#dc2626', bgColor: 'rgba(220, 38, 38, 0.15)' },
};
