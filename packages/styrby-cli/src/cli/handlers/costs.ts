/**
 * `styrby costs` command handler.
 *
 * Shows token usage and cost breakdown sourced from Claude Code JSONL files.
 *
 * @module cli/handlers/costs
 */

/**
 * Handle the `styrby costs` command.
 *
 * @param args - Command arguments. Supports:
 *               `--today` / `-t` (filter to today),
 *               `--month` / `-m` (filter to current month),
 *               no flag defaults to all-time.
 */
export async function handleCosts(args: string[]): Promise<void> {
  const { aggregateCosts, getTodayCosts, getMonthCosts, MODEL_PRICING } = await import('@/costs/index');

  let summary;
  let periodLabel = 'All time';

  if (args.includes('--today') || args.includes('-t')) {
    summary = await getTodayCosts();
    periodLabel = 'Today';
  } else if (args.includes('--month') || args.includes('-m')) {
    summary = await getMonthCosts();
    periodLabel = 'This month';
  } else {
    summary = await aggregateCosts();
  }

  // Format numbers
  const formatTokens = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toString();
  };

  const formatCost = (n: number): string => `$${n.toFixed(4)}`;

  // Print summary
  console.log(`\n📊 Cost Summary (${periodLabel})`);
  console.log('─'.repeat(50));

  if (summary.sessionCount === 0) {
    console.log('\nNo session data found.');
    console.log('Session files are stored in ~/.claude/projects/');
    return;
  }

  console.log(`\n  Sessions:       ${summary.sessionCount}`);
  console.log(`  Input tokens:   ${formatTokens(summary.totalInputTokens)}`);
  console.log(`  Output tokens:  ${formatTokens(summary.totalOutputTokens)}`);
  if (summary.totalCacheReadTokens > 0) {
    console.log(`  Cache read:     ${formatTokens(summary.totalCacheReadTokens)}`);
  }
  if (summary.totalCacheWriteTokens > 0) {
    console.log(`  Cache write:    ${formatTokens(summary.totalCacheWriteTokens)}`);
  }
  console.log(`\n  Total cost:     ${formatCost(summary.totalCostUsd)}`);

  // Print by model breakdown
  const models = Object.entries(summary.byModel);
  if (models.length > 0) {
    console.log('\n📈 By Model');
    console.log('─'.repeat(50));

    for (const [model, modelData] of models) {
      const data = modelData as {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        costUsd: number;
      };
      const pricing = MODEL_PRICING[model];
      const priceInfo = pricing
        ? `($${pricing.input}/$${pricing.output} per 1M)`
        : '(unknown pricing)';

      console.log(`\n  ${model}`);
      console.log(`    ${priceInfo}`);
      console.log(`    Input: ${formatTokens(data.inputTokens)} | Output: ${formatTokens(data.outputTokens)}`);
      console.log(`    Cost: ${formatCost(data.costUsd)}`);
    }
  }

  // Print date range
  if (summary.firstTimestamp && summary.lastTimestamp) {
    console.log('\n📅 Date Range');
    console.log('─'.repeat(50));
    console.log(`  From: ${summary.firstTimestamp.toLocaleString()}`);
    console.log(`  To:   ${summary.lastTimestamp.toLocaleString()}`);
  }

  console.log('\n');
}
