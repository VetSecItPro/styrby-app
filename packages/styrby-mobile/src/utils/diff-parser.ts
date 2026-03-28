/**
 * Unified Diff Parser Utility
 *
 * Parses unified git diff strings into structured line objects for rendering.
 * This module is framework-agnostic (no React, no native modules) so it can
 * be imported and tested in a pure Node.js Jest environment.
 *
 * The DiffViewer component imports from here rather than embedding the parser
 * so the parser logic can be unit-tested in isolation.
 *
 * @module utils/diff-parser
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Semantic classification for a single line in a unified diff.
 *
 * WHY these types: Each type maps to a distinct visual treatment in the diff
 * renderer (green bg, red bg, blue text, neutral, etc.). Separating parsing
 * from rendering keeps concerns isolated.
 */
export type DiffLineType =
  | 'addition'     // Line starting with '+' (new content)
  | 'deletion'     // Line starting with '-' (removed content)
  | 'context'      // Line starting with ' ' (unchanged, shown for context)
  | 'hunk_header'  // Line starting with '@@' (range info)
  | 'file_header'  // Line starting with '---', '+++', 'diff --git', 'index', etc.
  | 'no_newline';  // '\ No newline at end of file' marker

/**
 * Parsed representation of a single line in a unified diff.
 */
export interface DiffLine {
  /** Original raw line text (including prefix character) */
  raw: string;
  /** Content with the prefix character removed, for display */
  content: string;
  /** Semantic type of the line */
  type: DiffLineType;
  /**
   * Line number in the original file (for deletions and context).
   * null for additions, hunk headers, and file headers.
   */
  oldLineNumber: number | null;
  /**
   * Line number in the new file (for additions and context).
   * null for deletions, hunk headers, and file headers.
   */
  newLineNumber: number | null;
}

// ============================================================================
// Parser
// ============================================================================

/**
 * Parses a unified diff string into an array of typed DiffLine objects.
 *
 * Tracks old/new line numbers from hunk headers so each context and
 * changed line can display accurate gutter numbers.
 *
 * Handles standard unified diff format as produced by `git diff`:
 * - `diff --git a/... b/...` headers
 * - `index ...` lines
 * - `--- a/...` / `+++ b/...` file markers
 * - `@@ -old_start,old_count +new_start,new_count @@` hunk headers
 * - Context lines (space-prefixed)
 * - Addition lines (`+`-prefixed)
 * - Deletion lines (`-`-prefixed)
 * - `\ No newline at end of file` markers
 *
 * @param diffText - Raw unified diff string from git diff output
 * @returns Array of parsed DiffLine objects, one per input line
 *
 * @example
 * const lines = parseDiff(reviewFile.diff);
 * const additions = lines.filter((l) => l.type === 'addition');
 * console.log(`+${additions.length} lines added`);
 */
export function parseDiff(diffText: string): DiffLine[] {
  if (!diffText.trim()) {
    return [];
  }

  const rawLines = diffText.split('\n');
  const result: DiffLine[] = [];

  // WHY track separately: old/new counters diverge at additions/deletions —
  // an addition increments only newLine, a deletion only oldLine.
  let oldLine = 0;
  let newLine = 0;

  for (const raw of rawLines) {
    // Hunk header: @@ -10,7 +10,8 @@ optional context text
    // WHY regex: The numbers can have optional comma+count (,-N) portions.
    if (raw.startsWith('@@')) {
      const match = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldLine = parseInt(match[1], 10);
        newLine = parseInt(match[2], 10);
      }
      result.push({
        raw,
        content: raw,
        type: 'hunk_header',
        oldLineNumber: null,
        newLineNumber: null,
      });
      continue;
    }

    // File header lines (--- / +++ / diff --git / index / new file / deleted file / mode)
    if (
      raw.startsWith('--- ') ||
      raw.startsWith('+++ ') ||
      raw.startsWith('diff --git') ||
      raw.startsWith('index ') ||
      raw.startsWith('new file') ||
      raw.startsWith('deleted file') ||
      raw.startsWith('old mode') ||
      raw.startsWith('new mode')
    ) {
      result.push({
        raw,
        content: raw,
        type: 'file_header',
        oldLineNumber: null,
        newLineNumber: null,
      });
      continue;
    }

    // No newline at end of file marker
    if (raw.startsWith('\\')) {
      result.push({
        raw,
        content: raw,
        type: 'no_newline',
        oldLineNumber: null,
        newLineNumber: null,
      });
      continue;
    }

    // Addition line
    if (raw.startsWith('+')) {
      result.push({
        raw,
        content: raw.slice(1),
        type: 'addition',
        oldLineNumber: null,
        newLineNumber: newLine,
      });
      newLine++;
      continue;
    }

    // Deletion line
    if (raw.startsWith('-')) {
      result.push({
        raw,
        content: raw.slice(1),
        type: 'deletion',
        oldLineNumber: oldLine,
        newLineNumber: null,
      });
      oldLine++;
      continue;
    }

    // Context line (space prefix) or empty line within a hunk
    if (raw.startsWith(' ') || raw === '') {
      result.push({
        raw,
        content: raw.startsWith(' ') ? raw.slice(1) : '',
        type: 'context',
        oldLineNumber: oldLine,
        newLineNumber: newLine,
      });
      oldLine++;
      newLine++;
    }
    // WHY: Unrecognized lines (e.g. trailing empty lines after the diff) are
    // silently skipped rather than throwing — malformed diffs should degrade
    // gracefully to "no content" rather than crashing the review screen.
  }

  return result;
}
