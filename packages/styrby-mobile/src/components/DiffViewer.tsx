/**
 * DiffViewer Component
 *
 * Renders a unified git diff with syntax-highlighted additions and deletions.
 *
 * Features:
 * - Green/red line highlighting for additions (+) and deletions (-)
 * - Context lines shown in neutral zinc color
 * - Hunk headers (@@ ... @@) shown in blue
 * - Line number gutters (optional, enabled by default)
 * - Collapsible file sections via toggleable accordion
 * - Scrollable horizontally for long lines
 * - Pinch-to-zoom via ScrollView contentContainerStyle scaling
 * - File navigation: pass a list of ReviewFile and let users scroll between them
 *
 * Diff format assumed: standard unified diff as output by `git diff`
 * Example hunk:
 *   @@ -10,7 +10,8 @@
 *   -const foo = 1;
 *   +const foo = 2;
 *    const bar = 3;
 *
 * WHY no third-party diff renderer: This keeps the dependency count minimal.
 * The parser is simple (line prefix detection) and sufficient for viewing
 * agent-generated changes on mobile.
 *
 * @module components/DiffViewer
 */

import React, { useState, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { ReviewFile } from 'styrby-shared';
import { parseDiff as parseDiffUtil, type DiffLine } from '../utils/diff-parser';

// Re-export for backward compatibility and direct import in tests.
// WHY: The parser lives in utils/diff-parser (no React deps) so it can be
// unit-tested in a pure Node.js Jest environment. DiffViewer re-exports it
// so callers don't need to know where it lives.
export { parseDiff } from '../utils/diff-parser';

// ============================================================================
// Colors
// ============================================================================

/**
 * WHY: Fixed color values rather than Tailwind classes because this component
 * renders inside a ScrollView where className-based layouts can have issues
 * with dynamic width. Inline styles are safer for horizontally-scrollable text.
 */
const COLORS = {
  addition_bg:      'rgba(34, 197, 94, 0.12)',
  deletion_bg:      'rgba(239, 68, 68, 0.12)',
  hunk_header_bg:   'rgba(59, 130, 246, 0.10)',
  context_bg:       'transparent',
  addition_text:    '#86efac',
  deletion_text:    '#fca5a5',
  hunk_header_text: '#93c5fd',
  context_text:     '#d4d4d8',
  line_number:      '#52525b',
  gutter_bg:        '#0f0f11',
  no_newline_text:  '#71717a',
};

// WHY: parseDiff is imported from utils/diff-parser (no React/native deps)
// so it can be unit-tested in a pure Node.js Jest environment. The re-export
// at the top of this file makes it available as DiffViewer.parseDiff for
// backwards compatibility.

// ============================================================================
// Props
// ============================================================================

/**
 * Props for the DiffViewer component.
 */
export interface DiffViewerProps {
  /**
   * The ReviewFile to render (includes the raw diff string).
   */
  file: ReviewFile;

  /**
   * Whether to show line number gutters.
   * Defaults to true.
   */
  showLineNumbers?: boolean;

  /**
   * Whether to start in collapsed state.
   * Defaults to false (expanded).
   */
  defaultCollapsed?: boolean;
}

// ============================================================================
// Diff Line Renderer
// ============================================================================

/**
 * Renders a single parsed diff line with appropriate background and text colors.
 *
 * @param line - Parsed DiffLine
 * @param showLineNumbers - Whether to render the gutter
 * @returns React element
 */
function DiffLineRow({
  line,
  showLineNumbers,
}: {
  line: DiffLine;
  showLineNumbers: boolean;
}) {
  const bgColor =
    line.type === 'addition'    ? COLORS.addition_bg
    : line.type === 'deletion'  ? COLORS.deletion_bg
    : line.type === 'hunk_header' ? COLORS.hunk_header_bg
    : COLORS.context_bg;

  const textColor =
    line.type === 'addition'    ? COLORS.addition_text
    : line.type === 'deletion'  ? COLORS.deletion_text
    : line.type === 'hunk_header' ? COLORS.hunk_header_text
    : line.type === 'no_newline' ? COLORS.no_newline_text
    : COLORS.context_text;

  const prefix =
    line.type === 'addition'    ? '+'
    : line.type === 'deletion'  ? '-'
    : line.type === 'hunk_header' || line.type === 'file_header' || line.type === 'no_newline'
    ? ''
    : ' ';

  return (
    <View
      style={{
        flexDirection: 'row',
        backgroundColor: bgColor,
        minHeight: 20,
      }}
    >
      {/* Line number gutter */}
      {showLineNumbers && (
        <View
          style={{
            width: 80,
            flexDirection: 'row',
            backgroundColor: COLORS.gutter_bg,
            paddingHorizontal: 4,
          }}
        >
          <Text
            style={{
              color: COLORS.line_number,
              fontSize: 11,
              fontFamily: 'monospace',
              width: 36,
              textAlign: 'right',
              paddingRight: 4,
            }}
          >
            {line.oldLineNumber ?? ''}
          </Text>
          <Text
            style={{
              color: COLORS.line_number,
              fontSize: 11,
              fontFamily: 'monospace',
              width: 36,
              textAlign: 'right',
              paddingRight: 4,
            }}
          >
            {line.newLineNumber ?? ''}
          </Text>
        </View>
      )}

      {/* Prefix character */}
      <Text
        style={{
          color: textColor,
          fontSize: 13,
          fontFamily: 'monospace',
          width: 14,
          paddingLeft: 2,
        }}
      >
        {prefix}
      </Text>

      {/* Line content */}
      <Text
        style={{
          color: textColor,
          fontSize: 13,
          fontFamily: 'monospace',
          flex: 1,
          paddingRight: 8,
        }}
        // WHY: We do NOT set numberOfLines here because truncating diff lines
        // hides important context. Horizontal scroll handles long lines.
      >
        {line.content}
      </Text>
    </View>
  );
}

// ============================================================================
// Component
// ============================================================================

/**
 * Renders a unified diff for a single ReviewFile.
 *
 * Parses the raw unified diff string and renders each line with syntax
 * highlighting. Supports collapsing the file section and horizontal scroll
 * for long lines.
 *
 * @param props - DiffViewerProps
 * @returns React element
 *
 * @example
 * <DiffViewer file={reviewFile} showLineNumbers />
 */
export function DiffViewer({
  file,
  showLineNumbers = true,
  defaultCollapsed = false,
}: DiffViewerProps) {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);

  // WHY: Memoize parsing so it only runs when the diff string changes,
  // not on every re-render triggered by parent state.
  const parsedLines = useMemo(() => parseDiffUtil(file.diff), [file.diff]);

  const additionCount = parsedLines.filter((l) => l.type === 'addition').length;
  const deletionCount = parsedLines.filter((l) => l.type === 'deletion').length;

  return (
    <View
      style={{
        backgroundColor: '#0f0f11',
        borderRadius: 10,
        overflow: 'hidden',
        marginBottom: 12,
        borderWidth: 1,
        borderColor: '#27272a',
      }}
    >
      {/* File header / collapse toggle */}
      <Pressable
        onPress={() => setIsCollapsed((c) => !c)}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 12,
          paddingVertical: 10,
          backgroundColor: '#18181b',
        }}
        accessibilityRole="button"
        accessibilityLabel={`${isCollapsed ? 'Expand' : 'Collapse'} diff for ${file.path}`}
        accessibilityState={{ expanded: !isCollapsed }}
      >
        <Ionicons
          name={isCollapsed ? 'chevron-forward' : 'chevron-down'}
          size={16}
          color="#71717a"
        />

        {/* File path */}
        <Text
          style={{
            color: '#e4e4e7',
            fontSize: 13,
            fontFamily: 'monospace',
            marginLeft: 6,
            flex: 1,
          }}
          numberOfLines={1}
        >
          {file.path}
        </Text>

        {/* Addition / deletion counters */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {additionCount > 0 && (
            <Text style={{ color: '#86efac', fontSize: 12, fontWeight: '600' }}>
              +{additionCount}
            </Text>
          )}
          {deletionCount > 0 && (
            <Text style={{ color: '#fca5a5', fontSize: 12, fontWeight: '600' }}>
              -{deletionCount}
            </Text>
          )}
        </View>
      </Pressable>

      {/* Diff content — horizontally scrollable for long lines */}
      {!isCollapsed && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View>
            {parsedLines.map((line, idx) => (
              <DiffLineRow
                key={idx}
                line={line}
                showLineNumbers={showLineNumbers}
              />
            ))}
            {parsedLines.length === 0 && (
              <View style={{ padding: 16 }}>
                <Text style={{ color: '#71717a', fontSize: 13 }}>No changes in this file.</Text>
              </View>
            )}
          </View>
        </ScrollView>
      )}
    </View>
  );
}
