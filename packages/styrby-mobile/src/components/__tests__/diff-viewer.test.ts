/**
 * Tests for the DiffViewer parseDiff utility.
 *
 * The DiffViewer parses unified git diff strings and renders them with
 * syntax highlighting. These tests validate the parser exhaustively because
 * incorrect parsing produces misleading diffs — silent bugs in a code review
 * tool are particularly harmful.
 *
 * Test coverage:
 * - Line type detection (addition, deletion, context, hunk_header, file_header, no_newline)
 * - Line number tracking across multiple hunks
 * - Edge cases (empty diff, header-only diff, no-newline markers, large diffs)
 * - Complex diffs with multiple files and mixed change types
 * - Total addition/deletion counts derived from parsed output
 *
 * Uses Jest globals (describe/it/expect) — no vitest import needed.
 * WHY Jest: The styrby-mobile package uses Jest via expo's preset, not vitest.
 *
 * @module components/__tests__/diff-viewer.test
 *
 * Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
 */

import { parseDiff } from '../../utils/diff-parser';

// ============================================================================
// Fixtures
// ============================================================================

/**
 * Minimal unified diff for a single-hunk change.
 */
const SIMPLE_DIFF = `--- a/src/auth.ts
+++ b/src/auth.ts
@@ -5,7 +5,8 @@
 import { config } from './config';
 import { logger } from './logger';

-export function signIn(email: string, password: string) {
+export async function signIn(email: string, password: string): Promise<User> {
+  const result = await authClient.signIn(email, password);
   return authClient.signIn(email, password);
 }`;

/**
 * Diff with two separate hunks in the same file.
 */
const TWO_HUNK_DIFF = `--- a/src/utils.ts
+++ b/src/utils.ts
@@ -1,5 +1,6 @@
+import { v4 as uuidv4 } from 'uuid';
 import { config } from './config';

 export function generateId() {
-  return Math.random().toString(36);
+  return uuidv4();
 }
@@ -20,4 +21,4 @@
 export function formatDate(date: Date) {
-  return date.toLocaleDateString();
+  return date.toISOString().split('T')[0];
 }`;

/**
 * Diff with no-newline-at-end-of-file markers.
 */
const NO_NEWLINE_DIFF = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
\\ No newline at end of file`;

/**
 * Empty diff string (no changes).
 */
const EMPTY_DIFF = '';

/**
 * Diff with only file header lines (no hunks).
 */
const HEADER_ONLY_DIFF = `diff --git a/README.md b/README.md
index abc1234..def5678 100644
--- a/README.md
+++ b/README.md`;

// ============================================================================
// Tests: line type detection
// ============================================================================

describe('parseDiff — line type detection', () => {
  it('identifies file_header lines starting with ---', () => {
    const lines = parseDiff(SIMPLE_DIFF);
    const headerLines = lines.filter((l) => l.type === 'file_header');
    expect(headerLines.length).toBeGreaterThanOrEqual(2);
    expect(headerLines.some((l) => l.raw.startsWith('---'))).toBe(true);
    expect(headerLines.some((l) => l.raw.startsWith('+++'))).toBe(true);
  });

  it('identifies hunk_header lines starting with @@', () => {
    const lines = parseDiff(SIMPLE_DIFF);
    const hunkHeaders = lines.filter((l) => l.type === 'hunk_header');
    expect(hunkHeaders).toHaveLength(1);
    expect(hunkHeaders[0].raw).toContain('@@ -5,7 +5,8 @@');
  });

  it('identifies addition lines starting with +', () => {
    const lines = parseDiff(SIMPLE_DIFF);
    const additions = lines.filter((l) => l.type === 'addition');
    expect(additions).toHaveLength(2);
    expect(additions[0].content).toContain('async function signIn');
    expect(additions[1].content).toContain('authClient.signIn');
  });

  it('identifies deletion lines starting with -', () => {
    const lines = parseDiff(SIMPLE_DIFF);
    const deletions = lines.filter((l) => l.type === 'deletion');
    expect(deletions).toHaveLength(1);
    expect(deletions[0].content).toContain('export function signIn');
  });

  it('identifies context lines (space-prefixed)', () => {
    const lines = parseDiff(SIMPLE_DIFF);
    const context = lines.filter((l) => l.type === 'context');
    expect(context.length).toBeGreaterThan(0);
    // Context lines should have their leading space stripped
    expect(context[0].content).not.toMatch(/^ /);
  });

  it('strips the prefix + character from addition content', () => {
    const lines = parseDiff(SIMPLE_DIFF);
    const addition = lines.find((l) => l.type === 'addition');
    expect(addition).toBeDefined();
    expect(addition!.content).not.toMatch(/^\+/);
  });

  it('strips the prefix - character from deletion content', () => {
    const lines = parseDiff(SIMPLE_DIFF);
    const deletion = lines.find((l) => l.type === 'deletion');
    expect(deletion).toBeDefined();
    expect(deletion!.content).not.toMatch(/^-/);
  });

  it('identifies no_newline marker lines', () => {
    const lines = parseDiff(NO_NEWLINE_DIFF);
    const noNewline = lines.find((l) => l.type === 'no_newline');
    expect(noNewline).toBeDefined();
    expect(noNewline!.content).toContain('No newline');
  });

  it('identifies diff --git lines as file_header', () => {
    const lines = parseDiff(HEADER_ONLY_DIFF);
    const gitHeaders = lines.filter((l) => l.type === 'file_header' && l.raw.startsWith('diff --git'));
    expect(gitHeaders.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// Tests: line number tracking
// ============================================================================

describe('parseDiff — line number tracking', () => {
  it('assigns null old/new line numbers to hunk_header lines', () => {
    const lines = parseDiff(SIMPLE_DIFF);
    const hunkHeader = lines.find((l) => l.type === 'hunk_header');
    expect(hunkHeader?.oldLineNumber).toBeNull();
    expect(hunkHeader?.newLineNumber).toBeNull();
  });

  it('assigns null old line number to addition lines', () => {
    const lines = parseDiff(SIMPLE_DIFF);
    const additions = lines.filter((l) => l.type === 'addition');
    for (const add of additions) {
      expect(add.oldLineNumber).toBeNull();
    }
  });

  it('assigns null new line number to deletion lines', () => {
    const lines = parseDiff(SIMPLE_DIFF);
    const deletions = lines.filter((l) => l.type === 'deletion');
    for (const del of deletions) {
      expect(del.newLineNumber).toBeNull();
    }
  });

  it('assigns both old and new line numbers to context lines', () => {
    const lines = parseDiff(SIMPLE_DIFF);
    const context = lines.filter((l) => l.type === 'context');
    for (const ctx of context) {
      expect(ctx.oldLineNumber).not.toBeNull();
      expect(ctx.newLineNumber).not.toBeNull();
    }
  });

  it('initializes line numbers from @@ -5,7 +5,8 @@ hunk header', () => {
    const lines = parseDiff(SIMPLE_DIFF);
    // First context line after the hunk header should start at line 5
    const firstContext = lines.find((l) => l.type === 'context');
    expect(firstContext?.oldLineNumber).toBe(5);
    expect(firstContext?.newLineNumber).toBe(5);
  });

  it('increments line numbers correctly within a single hunk', () => {
    const lines = parseDiff(SIMPLE_DIFF);
    const contextLines = lines.filter((l) => l.type === 'context');
    // Verify old line numbers are monotonically increasing for context lines
    for (let i = 1; i < contextLines.length; i++) {
      const prev = contextLines[i - 1].oldLineNumber;
      const curr = contextLines[i].oldLineNumber;
      if (prev !== null && curr !== null) {
        expect(curr).toBeGreaterThan(prev);
      }
    }
  });

  it('tracks correct new line numbers for the second hunk', () => {
    const lines = parseDiff(TWO_HUNK_DIFF);
    const hunkHeaders = lines.filter((l) => l.type === 'hunk_header');
    expect(hunkHeaders).toHaveLength(2);
    // Second hunk: @@ -20,4 +21,4 @@ — new file starts at line 21
    const secondHunkIndex = lines.indexOf(hunkHeaders[1]);
    const firstContextInSecondHunk = lines.slice(secondHunkIndex + 1).find((l) => l.type === 'context');
    expect(firstContextInSecondHunk?.newLineNumber).toBe(21);
  });

  it('addition lines have incremented new line numbers', () => {
    const lines = parseDiff(TWO_HUNK_DIFF);
    const additions = lines.filter((l) => l.type === 'addition');
    const newLineNumbers = additions.map((l) => l.newLineNumber).filter((n): n is number => n !== null);
    expect(newLineNumbers.length).toBeGreaterThan(0);
    // All addition new line numbers should be positive
    for (const n of newLineNumbers) {
      expect(n).toBeGreaterThan(0);
    }
  });
});

// ============================================================================
// Tests: edge cases
// ============================================================================

describe('parseDiff — edge cases', () => {
  it('returns empty array for empty diff string', () => {
    const lines = parseDiff(EMPTY_DIFF);
    expect(lines).toHaveLength(0);
  });

  it('handles header-only diff (no hunks) without crashing', () => {
    const lines = parseDiff(HEADER_ONLY_DIFF);
    const hunkHeaders = lines.filter((l) => l.type === 'hunk_header');
    const additions = lines.filter((l) => l.type === 'addition');
    const deletions = lines.filter((l) => l.type === 'deletion');
    expect(hunkHeaders).toHaveLength(0);
    expect(additions).toHaveLength(0);
    expect(deletions).toHaveLength(0);
  });

  it('handles diff with multiple hunks in the same file', () => {
    const lines = parseDiff(TWO_HUNK_DIFF);
    const hunkHeaders = lines.filter((l) => l.type === 'hunk_header');
    expect(hunkHeaders).toHaveLength(2);
  });

  it('counts 3 additions in two-hunk diff', () => {
    const lines = parseDiff(TWO_HUNK_DIFF);
    const additions = lines.filter((l) => l.type === 'addition');
    // +import uuid, +return uuidv4(), +return toISOString()
    expect(additions).toHaveLength(3);
  });

  it('counts 2 deletions in two-hunk diff', () => {
    const lines = parseDiff(TWO_HUNK_DIFF);
    const deletions = lines.filter((l) => l.type === 'deletion');
    // -Math.random(), -toLocaleDateString()
    expect(deletions).toHaveLength(2);
  });

  it('handles hunk-only diff (no file headers)', () => {
    const noFileHeaders = `@@ -1,3 +1,3 @@
 const x = 1;
-const y = 2;
+const y = 3;`;
    const lines = parseDiff(noFileHeaders);
    const hunkHeaders = lines.filter((l) => l.type === 'hunk_header');
    expect(hunkHeaders).toHaveLength(1);
    const deletions = lines.filter((l) => l.type === 'deletion');
    expect(deletions).toHaveLength(1);
  });

  it('preserves raw line content on each parsed line', () => {
    const lines = parseDiff(SIMPLE_DIFF);
    const addition = lines.find((l) => l.type === 'addition');
    expect(addition?.raw).toMatch(/^\+/);
  });

  it('handles a large diff with many context lines without error', () => {
    const manyContext = Array.from({ length: 20 }, (_, i) => ` const line${i} = ${i};`).join('\n');
    const largeDiff = `--- a/src/large.ts
+++ b/src/large.ts
@@ -1,21 +1,22 @@
${manyContext}
+const newLine = 999;`;
    const lines = parseDiff(largeDiff);
    const context = lines.filter((l) => l.type === 'context');
    const additions = lines.filter((l) => l.type === 'addition');
    expect(context).toHaveLength(20);
    expect(additions).toHaveLength(1);
  });

  it('handles index/mode header lines as file_header', () => {
    const diffWithAll = `diff --git a/foo.ts b/foo.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/foo.ts
@@ -0,0 +1,3 @@
+const a = 1;
+const b = 2;
+const c = 3;`;
    const lines = parseDiff(diffWithAll);
    const fileHeaders = lines.filter((l) => l.type === 'file_header');
    expect(fileHeaders.length).toBeGreaterThanOrEqual(2);
    const additions = lines.filter((l) => l.type === 'addition');
    expect(additions).toHaveLength(3);
  });
});

// ============================================================================
// Tests: total counts derived from parsed output
// ============================================================================

describe('parseDiff — total counts', () => {
  it('computes 0 additions and 0 deletions for empty diff', () => {
    const lines = parseDiff(EMPTY_DIFF);
    const additions = lines.filter((l) => l.type === 'addition').length;
    const deletions = lines.filter((l) => l.type === 'deletion').length;
    expect(additions).toBe(0);
    expect(deletions).toBe(0);
  });

  it('computes correct counts for simple diff', () => {
    const lines = parseDiff(SIMPLE_DIFF);
    const additions = lines.filter((l) => l.type === 'addition').length;
    const deletions = lines.filter((l) => l.type === 'deletion').length;
    expect(additions).toBe(2);
    expect(deletions).toBe(1);
  });

  it('both counts are positive for multi-hunk diff', () => {
    const lines = parseDiff(TWO_HUNK_DIFF);
    const additions = lines.filter((l) => l.type === 'addition').length;
    const deletions = lines.filter((l) => l.type === 'deletion').length;
    expect(additions).toBeGreaterThan(0);
    expect(deletions).toBeGreaterThan(0);
  });

  it('counts net additions for a pure addition diff', () => {
    const pureAdd = `--- a/src/new.ts
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+const a = 1;
+const b = 2;
+const c = 3;`;
    const lines = parseDiff(pureAdd);
    const additions = lines.filter((l) => l.type === 'addition').length;
    const deletions = lines.filter((l) => l.type === 'deletion').length;
    expect(additions).toBe(3);
    expect(deletions).toBe(0);
  });

  it('counts net deletions for a pure deletion diff', () => {
    const pureDel = `--- a/src/old.ts
+++ b/src/old.ts
@@ -1,3 +0,0 @@
-const a = 1;
-const b = 2;
-const c = 3;`;
    const lines = parseDiff(pureDel);
    const additions = lines.filter((l) => l.type === 'addition').length;
    const deletions = lines.filter((l) => l.type === 'deletion').length;
    expect(additions).toBe(0);
    expect(deletions).toBe(3);
  });
});
