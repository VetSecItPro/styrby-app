/**
 * ContextBreakdown — Mobile per-file context budget view
 *
 * Renders a list of files that the AI agent has loaded into its context window,
 * each with a visual progress bar showing its share of the total token budget.
 *
 * WHY: No mobile AI coding app (Happy Coder, Cursor, etc.) shows per-file
 * context allocation. Power users constantly hit context limits without knowing
 * which files are responsible. This component surfaces that data so users can
 * proactively slim their context window from their phone.
 *
 * Design:
 * - Compact list items with file name + progress bar + token count
 * - Full path accessible via onPress tooltip / detail sheet
 * - Empty state when breakdown is unavailable
 *
 * @module components/ContextBreakdown
 */

import { View, Text, Pressable, ScrollView, type DimensionValue } from 'react-native';
import { useState, useCallback } from 'react';
import type { ContextBreakdown as ContextBreakdownData, FileContextEntry } from 'styrby-shared';

// ============================================================================
// Types
// ============================================================================

/**
 * Props for the ContextBreakdown component.
 */
interface ContextBreakdownProps {
  /**
   * Context breakdown data from the session relay.
   * Pass null or undefined to show the empty/unavailable state.
   */
  breakdown: ContextBreakdownData | null | undefined;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Shorten a file path to its last two segments for compact display.
 *
 * WHY: Mobile screens are narrow. Absolute paths like
 * /Users/alice/projects/app/src/auth/LoginForm.tsx are unreadable in a
 * progress-bar list. We show only the last two segments (auth/LoginForm.tsx)
 * and let users tap to see the full path.
 *
 * @param filePath - Full or relative path to the file
 * @returns Shortened display path
 *
 * @example
 * shortPath('/home/user/project/src/auth/Login.tsx')
 * // => "auth/Login.tsx"
 */
function shortPath(filePath: string): string {
  const segments = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (segments.length <= 2) return filePath;
  return segments.slice(-2).join('/');
}

/**
 * Format a token count with thousands separators.
 *
 * @param n - Raw token count
 * @returns Formatted string (e.g. "12,345")
 */
function formatTokens(n: number): string {
  return n.toLocaleString('en-US');
}

// ============================================================================
// FileRow sub-component
// ============================================================================

/**
 * Props for a single file row.
 */
interface FileRowProps {
  /** The file context entry to render */
  entry: FileContextEntry;
  /** 0-based index used for alternating background */
  index: number;
}

/**
 * A single row showing one file's context budget allocation.
 *
 * Tapping the row toggles between the short path and full path display.
 *
 * @param entry - File context entry data
 * @param index - Row index for alternating background colors
 */
function FileRow({ entry, index }: FileRowProps) {
  const [showFullPath, setShowFullPath] = useState(false);

  const handlePress = useCallback(() => {
    setShowFullPath((prev) => !prev);
  }, []);

  const displayPath = showFullPath ? entry.filePath : shortPath(entry.filePath);
  const isEven = index % 2 === 0;

  /**
   * Progress bar width capped at 100%. We guarantee a minimum of 2% so very
   * small files still render a visible sliver.
   */
  // WHY DimensionValue cast: barWidth is a percentage string (e.g. "45%").
  // React Native accepts percentage strings as DimensionValue, but TypeScript
  // infers template literals as `string` which is too broad for StyleProp<ViewStyle>.
  const barWidth = `${Math.max(entry.percentage, 2)}%` as DimensionValue;

  return (
    <Pressable
      onPress={handlePress}
      className={`px-4 py-2.5 ${isEven ? 'bg-zinc-900/30' : ''} active:bg-zinc-800`}
      accessibilityRole="button"
      accessibilityLabel={`${entry.filePath}: ${formatTokens(entry.tokenCount)} tokens, ${entry.percentage.toFixed(1)}% of context. Tap to ${showFullPath ? 'collapse' : 'expand'} path.`}
    >
      {/* File path */}
      <Text
        className="text-xs font-mono text-zinc-300 mb-1.5"
        numberOfLines={showFullPath ? undefined : 1}
      >
        {displayPath}
      </Text>

      {/* Progress bar row */}
      <View className="flex-row items-center gap-2">
        {/* Bar track */}
        <View className="flex-1 h-1.5 rounded-full bg-zinc-700 overflow-hidden">
          {/* Bar fill */}
          <View
            className="h-full rounded-full bg-orange-500"
            style={{ width: barWidth }}
            accessibilityElementsHidden
          />
        </View>

        {/* Percentage label */}
        <Text className="text-zinc-400 text-xs tabular-nums w-12 text-right">
          {entry.percentage.toFixed(1)}%
        </Text>

        {/* Token count */}
        <Text className="text-zinc-500 text-xs tabular-nums w-16 text-right">
          {formatTokens(entry.tokenCount)}
        </Text>
      </View>
    </Pressable>
  );
}

// ============================================================================
// Empty state sub-component
// ============================================================================

/**
 * Empty state shown when no context breakdown data has been received yet.
 */
function EmptyState() {
  return (
    <View className="items-center justify-center py-8 px-6">
      <View className="w-10 h-10 rounded-full bg-zinc-800 items-center justify-center mb-3">
        {/* Bar chart icon */}
        <Text className="text-zinc-500 text-base">▦</Text>
      </View>
      <Text className="text-zinc-400 text-sm font-semibold">No context data yet</Text>
      <Text className="text-zinc-600 text-xs text-center mt-1">
        Context usage is tracked while the session is active
      </Text>
    </View>
  );
}

// ============================================================================
// Main component
// ============================================================================

/**
 * ContextBreakdown — Mobile view of per-file token allocation.
 *
 * WHY: This is a key Styrby differentiator. No competitor shows this on mobile.
 * It answers the question every power user asks: "What is eating my context?"
 *
 * @param breakdown - Breakdown data from the CLI relay, or null if unavailable
 *
 * @example
 * <ContextBreakdown breakdown={session.contextBreakdown} />
 */
export function ContextBreakdown({ breakdown }: ContextBreakdownProps) {
  return (
    <View className="mx-4 mb-4 rounded-2xl bg-zinc-900 border border-zinc-800 overflow-hidden">
      {/* Section header */}
      <View className="px-4 py-3 border-b border-zinc-800 flex-row items-center justify-between">
        <View className="flex-row items-center gap-2">
          {/* Chart icon */}
          <Text className="text-orange-400 text-sm">▦</Text>
          <Text className="text-zinc-100 text-sm font-semibold">
            Context Budget
          </Text>
        </View>

        {breakdown && (
          <Text className="text-zinc-500 text-xs">
            <Text className="text-zinc-300 font-semibold tabular-nums">
              {formatTokens(breakdown.totalTokens)}
            </Text>{' '}
            tokens
          </Text>
        )}
      </View>

      {/* File list or empty state */}
      {!breakdown || breakdown.files.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          {/* Column headers */}
          <View className="flex-row items-center px-4 py-1.5 border-b border-zinc-800/60">
            <Text className="flex-1 text-zinc-500 text-xs uppercase font-medium tracking-wide">
              File
            </Text>
            <Text className="text-zinc-500 text-xs uppercase font-medium tracking-wide w-12 text-right">
              %
            </Text>
            <Text className="text-zinc-500 text-xs uppercase font-medium tracking-wide w-16 text-right">
              Tokens
            </Text>
          </View>

          {/* File rows */}
          <ScrollView
            scrollEnabled={false}
            // WHY: Nested scrolling is disabled here; the parent ScrollView
            // on the session detail screen handles scrolling. Setting
            // scrollEnabled=false on this ScrollView avoids nested scroll
            // conflicts on iOS while still letting React Native lay out the
            // list without a fixed height.
          >
            {breakdown.files.map((entry: FileContextEntry, index: number) => (
              <FileRow key={entry.filePath} entry={entry} index={index} />
            ))}
          </ScrollView>

          {/* Footer */}
          <View className="px-4 py-2 border-t border-zinc-800/60">
            <Text className="text-zinc-600 text-xs">
              {breakdown.files.length} file{breakdown.files.length !== 1 ? 's' : ''} in context
              {' · '}Updated{' '}
              {new Date(breakdown.updatedAt).toLocaleTimeString('en-US', {
                hour: 'numeric',
                minute: '2-digit',
                hour12: true,
              })}
            </Text>
          </View>
        </>
      )}
    </View>
  );
}

export default ContextBreakdown;
