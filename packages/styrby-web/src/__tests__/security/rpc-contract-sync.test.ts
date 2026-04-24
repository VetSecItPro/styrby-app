/**
 * RPC Contract Sync Test
 *
 * WHY this test exists (Phase 4.3 — 3rd consecutive phase hit):
 *   Three phases in a row shipped with an RPC call-site param-count mismatch vs the
 *   migration signature. The bug class: a migration adds or removes a param from a
 *   SECURITY DEFINER function, but the TypeScript call site is not updated.
 *   TypeScript cannot catch this because supabase.rpc() accepts `Record<string,
 *   unknown>` — any object is accepted at compile time.
 *
 * This test parses:
 *   1. All `supabase/migrations/*.sql` files to extract SECURITY DEFINER function
 *      signatures (parameter names starting with `p_`).
 *   2. All production TypeScript files under `src/app/` and `src/lib/` (excluding
 *      test files) for `.rpc('function_name', { ... })` invocations.
 *
 * For each RPC call-site it asserts:
 *   - callKeys ⊆ migrationKeys   (no extra keys sent that migration doesn't know)
 *   - migrationKeys ⊆ callKeys   (no missing keys the migration requires)
 *
 * LIMITATION: This treats all migration params as required (no DEFAULT tracking).
 *   Optional params with DB defaults may produce false-positive failures for
 *   zero-param or partial RPC calls. Such call sites must add a comment
 *   `// rpc-contract-sync: skip` on the .rpc() line to suppress the check.
 *
 * SOC 2 CC7.2: ensures every admin audit RPC is called with the full expected
 *   param set so no audit row is silently dropped due to a missing parameter.
 *
 * @module __tests__/security/rpc-contract-sync
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, join, extname } from 'path';

// ─── Path roots ────────────────────────────────────────────────────────────────

// __dirname = packages/styrby-web/src/__tests__/security
const WEB_SRC       = resolve(__dirname, '../../');              // src/
const MIGRATIONS_DIR = resolve(__dirname, '../../../../../supabase/migrations');

// ─── Migration parser ─────────────────────────────────────────────────────────

/**
 * Represents one parsed SECURITY DEFINER function from migrations.
 */
interface MigrationFn {
  /** Postgres function name (without schema prefix). */
  name: string;
  /** Ordered list of parameter names (p_ prefix retained). */
  params: string[];
  /** Path of the migration file that defines this function (last one wins). */
  definedIn: string;
}

/**
 * Parses all migration files and returns a map of function_name → MigrationFn.
 *
 * WHY last-definition-wins: CREATE OR REPLACE means later migrations supersede
 * earlier ones. We process files in lexicographic order so the newest definition
 * is kept.
 *
 * @returns Map from function name to its parsed signature.
 */
function parseMigrationFunctions(): Map<string, MigrationFn> {
  const result = new Map<string, MigrationFn>();

  const files = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort(); // lexicographic = chronological (NNN_ prefix)

  for (const file of files) {
    const filePath = join(MIGRATIONS_DIR, file);
    const content = readFileSync(filePath, 'utf-8');

    // Match: CREATE [OR REPLACE] FUNCTION public.<name>(...)
    // Capture the function name and the raw parameter block.
    // WHY non-greedy (.+?) for param block: the params end at ')' followed by
    // RETURNS or LANGUAGE — we stop at the first ')' that is likely the end
    // of the param list. We extract the block between '(' and the matching ')'
    // using a line-by-line scan rather than a single regex to handle multi-line
    // parameter lists robustly.
    const fnHeaderRe =
      /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(\w+)\s*\(/gi;

    let match: RegExpExecArray | null;
    while ((match = fnHeaderRe.exec(content)) !== null) {
      const fnName = match[1]!.toLowerCase();
      const openParenPos = match.index + match[0].length - 1; // position of '('

      // Extract everything from '(' to the matching ')'.
      let depth = 0;
      let paramBlock = '';
      for (let i = openParenPos; i < content.length; i++) {
        const ch = content[i]!;
        if (ch === '(') depth++;
        else if (ch === ')') {
          depth--;
          if (depth === 0) break;
        }
        if (i > openParenPos) paramBlock += ch;
      }

      // Extract parameter names: tokens that start with p_
      // Each param line looks like: p_some_name   type  [DEFAULT ...]
      // We split by comma and pick the first word of each segment if it starts with p_.
      const params: string[] = [];
      for (const segment of paramBlock.split(',')) {
        // strip SQL comments
        const clean = segment.replace(/--[^\n]*/g, '').trim();
        const firstToken = clean.split(/\s+/)[0];
        if (firstToken && firstToken.toLowerCase().startsWith('p_')) {
          params.push(firstToken.toLowerCase());
        }
      }

      // Only record functions that have at least one p_ param OR are zero-param
      // functions we might call with no args (those are fine either way).
      result.set(fnName, { name: fnName, params, definedIn: file });
    }
  }

  return result;
}

// ─── Source walker ────────────────────────────────────────────────────────────

/**
 * Represents one `.rpc()` call found in source.
 */
interface RpcCallSite {
  /** RPC function name (first arg to .rpc()). */
  fnName: string;
  /** Parameter keys passed as the second arg. Empty array for zero-param calls. */
  keys: string[];
  /** Source file path (relative to WEB_SRC). */
  file: string;
  /** 1-based line number of the .rpc() call. */
  line: number;
  /** True if the call site opted out via // rpc-contract-sync: skip comment. */
  skip: boolean;
}

/**
 * Recursively collects all `.ts`/`.tsx` files under `dir`, excluding test files.
 *
 * WHY exclude test files: mocks use `.rpc()` with arbitrary shapes; we only
 * care about production call sites.
 *
 * @param dir - Absolute directory to walk.
 * @returns List of absolute file paths.
 */
function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];

  function walk(current: string): void {
    const entries = readdirSync(current);
    for (const entry of entries) {
      const full = join(current, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        // Skip test directories
        if (entry === '__tests__' || entry === '__mocks__' || entry === 'node_modules') continue;
        walk(full);
      } else if (stat.isFile()) {
        const ext = extname(entry);
        if (ext !== '.ts' && ext !== '.tsx') continue;
        // Skip test/spec files
        if (entry.includes('.test.') || entry.includes('.spec.')) continue;
        results.push(full);
      }
    }
  }

  walk(dir);
  return results;
}

/**
 * Extracts all `.rpc('name', { ... })` call sites from a source file.
 *
 * Strategy: line-by-line scan. When we detect `.rpc(` we extract the function
 * name and then collect the object literal that follows (may span multiple lines).
 * We parse keys from the object literal using a simple regex.
 *
 * WHY not full AST parse: no ts-morph in test dependencies. Regex approach is
 * sufficient given the consistent `.rpc('name', { p_... })` call pattern in this
 * codebase. False negatives (missed calls with dynamic names) are acceptable
 * since those can't be statically verified anyway.
 *
 * @param filePath - Absolute path to the TypeScript file.
 * @returns List of parsed RPC call sites.
 */
function extractRpcCallSites(filePath: string): RpcCallSite[] {
  const rawContent = readFileSync(filePath, 'utf-8');
  const lines = rawContent.split('\n');
  const relFile = filePath.replace(WEB_SRC + '/', '');
  const callSites: RpcCallSite[] = [];

  // Strip block comments (/** ... */ and /* ... */) before scanning so that
  // JSDoc @example snippets with .rpc() are not treated as real call sites.
  // WHY: token.ts has a @example with `.rpc('admin_request_support_access', ...)`
  // that is documentation, not a production call. Stripping blocks prevents
  // false-positive contract violations from JSDoc examples.
  // We replace block comment content with same-length whitespace to preserve
  // line numbers for the violation report.
  let content = rawContent;
  content = content.replace(/\/\*[\s\S]*?\*\//g, (match) =>
    match.replace(/[^\n]/g, ' ')
  );

  // We scan the full text for `.rpc(` occurrences.
  const rpcRe = /\.rpc\(\s*['"`](\w+)['"`]/g;
  let match: RegExpExecArray | null;

  while ((match = rpcRe.exec(content)) !== null) {
    const fnName = match[1]!.toLowerCase();
    const matchStart = match.index;

    // Determine line number (1-based)
    const lineNum = content.slice(0, matchStart).split('\n').length;

    // Check for skip annotation on the same line or the preceding line.
    const currentLine = lines[lineNum - 1] ?? '';
    const prevLine = lines[lineNum - 2] ?? '';
    const skip =
      currentLine.includes('rpc-contract-sync: skip') ||
      prevLine.includes('rpc-contract-sync: skip');

    // Find the second argument: the object literal `{ ... }` or nothing.
    // After the function name string, we skip to ',' then find '{'.
    const afterName = content.indexOf(',', matchStart + match[0].length);
    if (afterName === -1) {
      // Zero-arg call like .rpc('verify_admin_audit_chain')
      callSites.push({ fnName, keys: [], file: relFile, line: lineNum, skip });
      continue;
    }

    // Find the opening '{' of the params object.
    const braceStart = content.indexOf('{', afterName);
    if (braceStart === -1) {
      callSites.push({ fnName, keys: [], file: relFile, line: lineNum, skip });
      continue;
    }

    // Extract the balanced object literal.
    let depth = 0;
    let objBlock = '';
    for (let i = braceStart; i < content.length; i++) {
      const ch = content[i]!;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          objBlock = content.slice(braceStart + 1, i);
          break;
        }
      }
    }

    // Extract keys from the object literal.
    // Match `p_word:` or `'p_word':` or `"p_word":` patterns.
    const keyRe = /['"]?(p_\w+)['"]?\s*:/g;
    const keys: string[] = [];
    let keyMatch: RegExpExecArray | null;
    while ((keyMatch = keyRe.exec(objBlock)) !== null) {
      keys.push(keyMatch[1]!.toLowerCase());
    }

    callSites.push({ fnName, keys, file: relFile, line: lineNum, skip });
  }

  return callSites;
}

// ─── Test ──────────────────────────────────────────────────────────────────────

describe('RPC contract sync — call-site params must match migration signatures', () => {
  // Parse migrations once for all tests.
  const migrationFns = parseMigrationFunctions();

  // Collect all production source files under src/app/ and src/lib/.
  const sourceFiles = [
    ...collectSourceFiles(resolve(WEB_SRC, 'app')),
    ...collectSourceFiles(resolve(WEB_SRC, 'lib')),
  ];

  // Gather all call sites.
  const allCallSites: RpcCallSite[] = [];
  for (const file of sourceFiles) {
    allCallSites.push(...extractRpcCallSites(file));
  }

  // Filter to call sites whose function has a known migration signature
  // and are not opted out.
  const verifiableCalls = allCallSites.filter(cs => {
    if (cs.skip) return false;
    const mfn = migrationFns.get(cs.fnName);
    // Only verify if migration has p_ params — zero-param functions are fine
    // (call with no second arg or empty object).
    return mfn !== undefined && mfn.params.length > 0;
  });

  it('at least one verifiable RPC call site is found (smoke-check the parser)', () => {
    // If this fails, the regex broke and we are no longer checking anything.
    expect(verifiableCalls.length).toBeGreaterThan(0);
  });

  it('every RPC call-site sends all params required by the migration signature', () => {
    const violations: string[] = [];

    for (const cs of verifiableCalls) {
      const mfn = migrationFns.get(cs.fnName)!;
      const migrationKeys = new Set(mfn.params);
      const callKeys = new Set(cs.keys);

      // Check for missing keys (migration requires them, call site omits them).
      const missing = mfn.params.filter(k => !callKeys.has(k));

      // Check for extra keys (call site sends keys migration doesn't know).
      const extra = cs.keys.filter(k => !migrationKeys.has(k));

      if (missing.length > 0 || extra.length > 0) {
        const lines: string[] = [
          `RPC contract drift: ${cs.fnName}`,
          `  Migration (${mfn.definedIn}) expects: ${mfn.params.join(', ')}`,
          `  Call site sends:                      ${cs.keys.join(', ') || '(none)'}`,
        ];
        if (missing.length > 0) lines.push(`  Missing: ${missing.join(', ')}`);
        if (extra.length > 0)   lines.push(`  Extra:   ${extra.join(', ')}`);
        lines.push(`  File: ${cs.file}:${cs.line}`);
        violations.push(lines.join('\n'));
      }
    }

    if (violations.length > 0) {
      // Fail with a clear, actionable message listing every mismatch.
      throw new Error(
        `\n\n${violations.join('\n\n')}\n\n` +
        `Fix: update the call site(s) above to match the migration signature.\n` +
        `If a param has a DB DEFAULT and is intentionally omitted, add the comment\n` +
        `  // rpc-contract-sync: skip\n` +
        `on the line before the .rpc() call to suppress this check.\n`,
      );
    }

    // Explicit pass message for clarity in CI output.
    expect(violations).toHaveLength(0);
  });

  it('admin_issue_refund call site sends all 8 migration params including p_polar_subscription_id', () => {
    // WHY this pinned test: admin_issue_refund was the P0 that motivated this
    // suite. Pin it explicitly so any future regression on this specific function
    // produces an unambiguous failure (rather than a generic contract-drift error).
    const refundCalls = verifiableCalls.filter(cs => cs.fnName === 'admin_issue_refund');
    expect(refundCalls.length).toBeGreaterThan(0);

    const mfn = migrationFns.get('admin_issue_refund');
    expect(mfn).toBeDefined();
    expect(mfn!.params).toContain('p_polar_subscription_id');

    for (const cs of refundCalls) {
      expect(cs.keys).toContain('p_polar_subscription_id');
    }
  });
});
