/**
 * Token Usage Summary component for the costs dashboard.
 *
 * Displays a prominent card with input tokens, output tokens, and total tokens
 * for the current month. Tokens are formatted with locale-aware separators
 * (e.g., "1,234,567") for readability.
 *
 * WHY this exists: Developers need visibility into their token consumption
 * patterns to optimise prompts, manage context windows, and understand the
 * cost breakdown between input (prompts + context) and output (responses).
 * This matches the mobile app's "TOKEN USAGE (MONTH)" section.
 */

/* ──────────────────────────── Types ──────────────────────────── */

/**
 * Aggregated totals by agent type, matching the shape from costs-realtime.
 */
interface AgentTotals {
  [agent: string]: {
    cost: number;
    inputTokens: number;
    outputTokens: number;
  };
}

interface TokenUsageSummaryProps {
  /** Aggregated agent totals containing token counts for the current period */
  agentTotals: AgentTotals;
}

/* ──────────────────────────── Helpers ──────────────────────────── */

/**
 * Format a token count with locale-aware thousands separators.
 *
 * WHY: Large token numbers (e.g., 1234567) are unreadable without formatting.
 * Locale-aware formatting (e.g., "1,234,567" in en-US) makes it immediately
 * clear whether the user has consumed thousands or millions of tokens.
 *
 * @param tokens - Raw token count
 * @returns Formatted string with locale separators (e.g., "1,234,567")
 *
 * @example
 * formatTokenCount(1234567); // "1,234,567"
 * formatTokenCount(0);       // "0"
 */
function formatTokenCount(tokens: number): string {
  return tokens.toLocaleString('en-US');
}

/* ──────────────────────────── Component ──────────────────────────── */

/**
 * Renders a token usage summary card with input, output, and total tokens.
 *
 * Uses the same grid layout as the existing cost summary cards for visual
 * consistency. Each metric is displayed with an icon, label, and formatted
 * token count.
 *
 * @param props - Agent totals containing token data
 * @returns Rendered token usage section, or nothing if no tokens recorded
 */
export function TokenUsageSummary({ agentTotals }: TokenUsageSummaryProps) {
  // Aggregate input and output tokens across all agents
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const agent of Object.values(agentTotals)) {
    totalInputTokens += agent.inputTokens;
    totalOutputTokens += agent.outputTokens;
  }

  const totalTokens = totalInputTokens + totalOutputTokens;

  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold text-foreground mb-4">
        Token Usage (Month)
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Input Tokens */}
        <div className="rounded-xl bg-card/60 border border-border/40 p-4">
          <div className="flex items-center gap-2 mb-2">
            <svg
              className="h-4 w-4 text-blue-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M7 11l5-5m0 0l5 5m-5-5v12"
              />
            </svg>
            <p className="text-sm text-muted-foreground">Input Tokens</p>
          </div>
          <p className="text-2xl font-bold text-foreground">
            {formatTokenCount(totalInputTokens)}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Prompts + context sent to models
          </p>
        </div>

        {/* Output Tokens */}
        <div className="rounded-xl bg-card/60 border border-border/40 p-4">
          <div className="flex items-center gap-2 mb-2">
            <svg
              className="h-4 w-4 text-green-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M17 13l-5 5m0 0l-5-5m5 5V6"
              />
            </svg>
            <p className="text-sm text-muted-foreground">Output Tokens</p>
          </div>
          <p className="text-2xl font-bold text-foreground">
            {formatTokenCount(totalOutputTokens)}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Responses received from models
          </p>
        </div>

        {/* Total Tokens */}
        <div className="rounded-xl bg-card/60 border border-border/40 p-4">
          <div className="flex items-center gap-2 mb-2">
            <svg
              className="h-4 w-4 text-amber-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
              />
            </svg>
            <p className="text-sm text-muted-foreground">Total Tokens</p>
          </div>
          <p className="text-2xl font-bold text-foreground">
            {formatTokenCount(totalTokens)}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Combined input + output this month
          </p>
        </div>
      </div>
    </section>
  );
}
