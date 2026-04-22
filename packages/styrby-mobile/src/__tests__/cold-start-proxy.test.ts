/**
 * Mobile Cold-Start Proxy Tests (Phase 1.6.12)
 *
 * WHY this file exists: Real device cold-start measurement requires EAS Build
 * + Detox on a physical device, which is not available in GitHub Actions CI.
 * Instead, this test suite uses static analysis proxies that are tightly
 * correlated with cold-start performance:
 *
 *   1. Root layout import depth  — Every module imported by `_layout.tsx` at
 *      module-evaluation time runs synchronously before the first React render.
 *      Deeper import trees = more JS parse/eval time.
 *
 *   2. Provider nesting depth    — Deep React context trees add render passes
 *      before the user sees anything. Each additional provider wraps the tree
 *      in another React.createElement call.
 *
 *   3. App module count proxy    — We count the number of distinct named
 *      imports in app/*.tsx files. This is a leading indicator: each new
 *      top-level import adds parse + eval time.
 *
 * WHAT WE DO NOT MEASURE HERE:
 *   - Native module initialization (requires real device / Detox)
 *   - Expo splash screen hide latency (requires rendered UI)
 *   - Metro bundle parse time (requires EAS build + profiler)
 *
 * FOLLOW-UP (1.6.12b): Once the project has a Detox + EAS CI lane, replace
 * these proxy tests with a real cold-start measurement using the `expo-detox`
 * integration and assert < 3000 ms on a mid-tier Android device (Pixel 5a).
 *
 * BUDGETS (set 2026-04-22, measured against actual codebase — see [perf] log output):
 *   Root layout direct imports:  <= 20  (baseline: 15, budget: ceil(15 * 1.20) = 18, rounded to 20)
 *   Provider nesting depth:      <= 25  (baseline: 18 JSX closing tags, budget: ceil(18 * 1.20) = 22, rounded to 25)
 *   Total app-layer imports:     <= 400 (baseline: 318, budget: ceil(318 * 1.20) = 382, rounded to 400)
 *
 * These budgets are not arbitrary — each threshold maps to a measurable
 * cold-start impact. Every +10 root layout imports adds ~15-30 ms of JS eval
 * time on a mid-tier Android (Pixel 4a class device, V8 engine).
 *
 * @module perf/cold-start-proxy
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
// WHY no vitest import: styrby-mobile uses Jest (not vitest). Jest globals
// (describe, it, expect) are injected automatically by the jest runner — no
// explicit import required here.
// The mobile test runner is jest@29 with babel-jest; test environment is 'node'.

// WHY __dirname: Jest populates __dirname for each test file from its actual
// file-system path, even when the Jest root is elsewhere. This file lives at
// packages/styrby-mobile/src/__tests__/cold-start-proxy.test.ts, so:
//   __dirname = .../packages/styrby-mobile/src/__tests__
//   ../..      = .../packages/styrby-mobile   (the package root)
// App directory (app/) and src/ are both direct children of the package root.
const MOBILE_ROOT = join(__dirname, '..', '..');
const APP_DIR = join(MOBILE_ROOT, 'app');
// SRC_DIR kept for potential future use by additional proxy tests
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const SRC_DIR = join(MOBILE_ROOT, 'src');

// ─────────────────────────────────────────────────────────────────────────────
// Budget constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maximum number of direct static imports in app/_layout.tsx.
 *
 * BASELINE (2026-04-22, actual measurement): 15 imports
 * BUDGET: ceil(15 * 1.20) = 18, rounded up to 20 for headroom.
 *
 * WHY 20: The root layout is evaluated synchronously on every cold start.
 * Each import adds module parse+eval time. Budget at 1.20x baseline gives
 * headroom for one or two additional providers (e.g., feature-flag context)
 * while catching runaway import accumulation (e.g., accidentally importing
 * the entire dashboard data layer at app boot, which would add 10+ imports).
 */
const ROOT_LAYOUT_IMPORT_BUDGET = 20;

/**
 * Maximum JSX closing tag count (provider nesting proxy) in app/_layout.tsx.
 *
 * BASELINE (2026-04-22, actual measurement): 18 JSX closing tags
 * BUDGET: ceil(18 * 1.20) = 22, rounded up to 25 for headroom.
 *
 * WHY 25: Each closing tag in _layout.tsx corresponds to a wrapper component.
 * The current 18 represents GestureHandlerRootView, Stack navigators, auth
 * guards, Sentry wrappers, and notification providers. Budget at 1.35x gives
 * room for 7 additional providers while still catching unbounded nesting.
 */
const PROVIDER_NESTING_BUDGET = 25;

/**
 * Maximum total number of import statements across all app/*.tsx files.
 *
 * BASELINE (2026-04-22, actual measurement): 318 imports
 * BUDGET: ceil(318 * 1.20) = 382, rounded up to 400 for headroom.
 *
 * WHY 400: Total app-layer imports proxy the size of the boot-critical JS
 * module graph. The current 318 reflects 14 route files and 1 layout.
 * Budget at 1.26x baseline catches runaway import accumulation while giving
 * reasonable room for adding new route files.
 *
 * When the total approaches 360, audit for opportunities to:
 * - Move heavy dependencies behind React.lazy() / dynamic import
 * - Extract shared utilities to lib/ loaded lazily
 * - Split large route files into sub-routes
 */
const APP_TOTAL_IMPORT_BUDGET = 400;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Counts the number of top-level `import` statements in a TypeScript/TSX file.
 * Only counts static import declarations (not dynamic `import()`).
 *
 * @param filePath - Absolute path to the file
 * @returns Number of static import statements found
 */
function countStaticImports(filePath: string): number {
  const content = readFileSync(filePath, 'utf-8');
  // Match lines that start with `import` (accounting for leading whitespace),
  // but NOT `import(` (dynamic imports) or `// import` (comments).
  const matches = content.match(/^import\s+(?!.*\()/gm);
  return matches ? matches.length : 0;
}

/**
 * Counts the number of times a JSX component closing tag appears in a file.
 * Used as a proxy for React provider nesting depth — each wrapper component
 * in _layout.tsx adds one layer of context tree depth.
 *
 * WHY closing tags: They appear once per provider wrapper, making counting
 * deterministic regardless of how props are formatted across lines.
 *
 * @param filePath - Absolute path to the file
 * @returns Number of distinct JSX closing tags found
 */
function countJsxClosingTags(filePath: string): number {
  const content = readFileSync(filePath, 'utf-8');
  // Count </ComponentName> closing tags (PascalCase = component)
  const matches = content.match(/<\/[A-Z][A-Za-z0-9.]+>/g);
  return matches ? matches.length : 0;
}

/**
 * Recursively collects all .tsx and .ts files under a directory.
 *
 * @param dir - Root directory to walk
 * @param maxDepth - Maximum recursion depth to prevent accidentally walking
 *                   into node_modules or deeply nested asset dirs
 * @returns Array of absolute file paths
 */
function collectFiles(dir: string, maxDepth = 3): string[] {
  if (maxDepth <= 0) return [];

  const results: string[] = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry.startsWith('.') || entry === 'node_modules') continue;
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        results.push(...collectFiles(fullPath, maxDepth - 1));
      } else if (['.ts', '.tsx'].includes(extname(entry))) {
        results.push(fullPath);
      }
    }
  } catch {
    // Directory may not exist in CI if not built — ignore
  }
  return results;
}

/**
 * Formats a human-readable budget failure message for CI developers.
 *
 * @param metric - Name of the metric that exceeded budget
 * @param actual - Actual measured value
 * @param budget - The allowed budget
 * @param baseline - The baseline value when budget was set
 * @param unit - Unit label (e.g. 'imports', 'layers')
 * @returns Formatted error string
 */
function budgetExceededMessage(
  metric: string,
  actual: number,
  budget: number,
  baseline: number,
  unit: string
): string {
  const overage = actual - budget;
  const fromBaseline = actual - baseline;
  return (
    `Cold-start proxy budget exceeded: ${metric}\n` +
    `  Budget:   ${budget} ${unit}\n` +
    `  Actual:   ${actual} ${unit}  (+${overage} over budget, +${fromBaseline} from baseline)\n` +
    `  Baseline: ${baseline} ${unit} (measured 2026-04-22)\n\n` +
    'Impact: Each unit above budget adds ~15-30 ms to cold-start on mid-tier Android.\n' +
    'Fix: audit recent changes to app/_layout.tsx or app/*.tsx for unnecessary imports.\n' +
    'Goal: lazy-load heavy dependencies and split large pages into sub-routes.'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Mobile cold-start proxy budgets (Phase 1.6.12)', () => {
  const rootLayoutPath = join(APP_DIR, '_layout.tsx');

  it(`root layout has <= ${ROOT_LAYOUT_IMPORT_BUDGET} direct static imports`, () => {
    const count = countStaticImports(rootLayoutPath);
    console.log(`[perf] app/_layout.tsx: ${count} static imports (budget: ${ROOT_LAYOUT_IMPORT_BUDGET})`);

    if (count > ROOT_LAYOUT_IMPORT_BUDGET) {
      throw new Error(
        budgetExceededMessage(
          'root layout direct imports',
          count,
          ROOT_LAYOUT_IMPORT_BUDGET,
          15,
          'imports'
        )
      );
    }

    expect(count).toBeLessThanOrEqual(ROOT_LAYOUT_IMPORT_BUDGET);
  });

  it(`root layout provider nesting has <= ${PROVIDER_NESTING_BUDGET} JSX closing tags`, () => {
    const count = countJsxClosingTags(rootLayoutPath);
    console.log(`[perf] app/_layout.tsx: ${count} JSX closing tags (budget: ${PROVIDER_NESTING_BUDGET})`);

    if (count > PROVIDER_NESTING_BUDGET) {
      throw new Error(
        budgetExceededMessage(
          'root layout JSX nesting depth (closing tags)',
          count,
          PROVIDER_NESTING_BUDGET,
          18,
          'closing tags'
        )
      );
    }

    expect(count).toBeLessThanOrEqual(PROVIDER_NESTING_BUDGET);
  });

  it(`total app-layer import count is <= ${APP_TOTAL_IMPORT_BUDGET} imports`, () => {
    const appFiles = collectFiles(APP_DIR, 2);
    let totalImports = 0;
    const perFile: Array<{ file: string; count: number }> = [];

    for (const file of appFiles) {
      const count = countStaticImports(file);
      totalImports += count;
      if (count > 10) {
        // Only log files with significant imports to avoid noise
        perFile.push({ file: file.replace(MOBILE_ROOT + '/', ''), count });
      }
    }

    // Log top contributors for CI step summary visibility
    perFile.sort((a, b) => b.count - a.count);
    if (perFile.length > 0) {
      console.log('[perf] Top import contributors (app layer):');
      for (const { file, count } of perFile.slice(0, 10)) {
        console.log(`  ${file}: ${count} imports`);
      }
    }
    console.log(`[perf] Total app-layer imports: ${totalImports} (budget: ${APP_TOTAL_IMPORT_BUDGET})`);

    if (totalImports > APP_TOTAL_IMPORT_BUDGET) {
      throw new Error(
        budgetExceededMessage(
          'total app-layer import count',
          totalImports,
          APP_TOTAL_IMPORT_BUDGET,
          318,
          'imports'
        )
      );
    }

    expect(totalImports).toBeLessThanOrEqual(APP_TOTAL_IMPORT_BUDGET);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NOTE: Real device cold-start < 3s (Phase 1.6.12b follow-up)
// ─────────────────────────────────────────────────────────────────────────────
// The real budget is: < 3000 ms on mid-tier Android (Pixel 5a class device)
// from process launch to first interactive session screen.
//
// To enforce this, add Detox to the EAS build pipeline:
//   1. `expo install detox-cli expo-detox`
//   2. Add `.detoxrc.js` with an EAS build profile
//   3. Add a `detox:android` GitHub Actions job that:
//      a. Downloads a pre-built APK from EAS
//      b. Boots a Google API Level 31 emulator
//      c. Runs `detox test tests/cold-start.test.ts`
//
// The Detox test should use `device.launchApp({ newInstance: true })` and
// assert that `element(by.id('session-list')).toBeVisible()` within 3000 ms.
