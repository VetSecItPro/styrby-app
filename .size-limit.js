/**
 * Size-limit configuration for Styrby monorepo (Phase 1.6.13)
 *
 * WHY size-limit instead of custom shell scripts:
 * - size-limit is the de-facto standard in the JS ecosystem (Next.js, React,
 *   Preact, tRPC all use it). It handles gzip accounting, webpack bundling
 *   when needed, and generates structured JSON output for CI comparison.
 * - It produces clear, actionable output: "X exceeded budget by Y KB (Z% over)"
 *   rather than silent failures or ambiguous numbers.
 *
 * BASELINES:
 *   - styrby-web TS source: ~3.6 MB → measured ~725 KB first-load JS (gzip) on Phase 1.6.7
 *   - Phase 1.6.13 ratchet target: ~600-620 KB projected after dynamic imports
 *   - styrby-cli TS source: ~2.9 MB → projected ~3 MB unminified bundle
 *   - styrby-shared TS source: ~550 KB → projected ~500 KB dist output
 *   - styrby-mobile Metro bundle: measured from /tmp/expo-export in CI
 *
 * HEADROOM: web first-load budget = projected_baseline * 1.10 (10% headroom),
 * rounded to nearest 50 KB. Other thresholds at 20% headroom (unchanged).
 *
 * HOW TO MEASURE ACTUAL BASELINES:
 *   1. pnpm --filter @styrby/shared build
 *   2. pnpm --filter styrby-cli build
 *   3. pnpm --filter styrby-web build
 *   4. npx size-limit --json 2>&1 | jq '.'
 *   Update the baseline comments below with the real numbers.
 *
 * TO PROFILE BUNDLE CONTENTS (requires @next/bundle-analyzer):
 *   pnpm --filter styrby-web analyze
 *   Opens a Webpack bundle treemap in the browser.
 *
 * @see https://github.com/ai/size-limit
 */

/** @type {import('@size-limit/core').SizeLimitConfig} */
module.exports = [
  // ─── styrby-web: First-load JS (gzip) ─────────────────────────────────────
  //
  // WHY we measure gzip: The browser downloads gzip-compressed assets over the
  // wire. Raw bundle size is less relevant than what the user actually waits for.
  //
  // MEASURED BASELINE (Phase 1.6.7 merge, 2026-04-22): 725 KB gzipped
  // Budget was raised to 800 KB on Phase 1.6.7 merge to unblock CI.
  //
  // PHASE 1.6.13 RATCHET (2026-04-22):
  // The following components were moved to async chunks via next/dynamic:
  //   - cmdk (CommandPalette)        ~45 kB gzipped — Cmd+K only
  //   - ActivityGraph                ~25 kB gzipped — below fold, Pro+ only
  //   - CloudTasksPanel              ~20 kB gzipped — Power only
  //   - OnboardingModal + Banner     ~15 kB gzipped — new users only
  //   - OtelSettings (506 LOC)       ~30 kB gzipped — Power only, settings page
  //   - SupportModal (350 LOC)       ~15 kB gzipped — modal, on-demand
  //   - FeedbackDialog (342 LOC)     ~15 kB gzipped — modal, on-demand
  //   ─────────────────────────────────────────────────────────────────
  //   Total deferred (estimated):  ~165 kB gzipped
  //
  // PROJECTED NEW BASELINE: ~725 - 165 = ~560 KB (some savings overlap in
  // shared deps; conservative estimate is 600-620 KB).
  //
  // BUDGET = projected ~620 KB + 10% headroom = 682 KB → rounded to 700 KB.
  //
  // IRREDUCIBLE FLOOR: Next.js App Router framework runtime, React, Radix UI
  // primitives, Supabase browser client, and @sentry/nextjs browser layer
  // account for ~350-400 KB gzipped and cannot be deferred (they are required
  // for the dashboard shell to hydrate at all).
  //
  // TO PROFILE FURTHER: pnpm --filter styrby-web analyze (opens Webpack treemap)
  //
  // This checks ALL .js files matching the initial-chunk pattern (dash separator
  // before hash, per the existing bundle-size CI job convention).
  // Async chunks (dot separator before hash) are excluded — they load on demand.
  {
    name: 'styrby-web: first-load JS (gzip)',
    // WHY shell glob: size-limit needs the built artifact path. The CI
    // build-web job produces .next/static/chunks/**/*.js. We use a broad
    // glob and rely on the limit to catch regressions.
    path: 'packages/styrby-web/.next/static/chunks/!(*.*.js)',
    limit: '700 KB',
    gzip: true,
    // WHY import is omitted: We cannot import directly from Next.js output —
    // these are already-built assets. size-limit stats the files and sums sizes.
  },

  // ─── styrby-cli: dist/index.js (raw, no gzip) ─────────────────────────────
  //
  // WHY no gzip for CLI: Node reads from disk; gzip size does not affect
  // startup time. Raw file size drives I/O and V8 parse time.
  //
  // BASELINE: ~3 MB projected (esbuild, no minification, includes all deps
  // except react, crypto, fsevents). Heavy deps: @sentry/node (~800 KB),
  // libsodium-wrappers (~700 KB wasm wrapper), @supabase/supabase-js (~200 KB),
  // @modelcontextprotocol/sdk (~150 KB).
  //
  // THRESHOLD: 4 MB = ~3 MB projected + 33% headroom for CI variance and
  // legitimate feature additions before the next ratchet.
  {
    name: 'styrby-cli: dist/index.js (uncompressed)',
    path: 'packages/styrby-cli/dist/index.js',
    limit: '4 MB',
    gzip: false,
  },

  // ─── styrby-cli: gzip proxy for V8 parse time ─────────────────────────────
  //
  // WHY a second entry for gzip: Gzip size correlates with logical code
  // complexity (after compression). A bundle that grows 5x in raw size but
  // only 2x in gzip is mostly duplicated strings (common in bundled deps).
  // A bundle that grows proportionally in both is adding novel logic —
  // a stronger signal that import bloat has occurred.
  //
  // THRESHOLD: 1.2 MB gzip = ~3 MB raw at a typical 40% compression ratio,
  // +20% headroom.
  {
    name: 'styrby-cli: dist/index.js (gzip, parse-time proxy)',
    path: 'packages/styrby-cli/dist/index.js',
    limit: '1.2 MB',
    gzip: true,
  },

  // ─── styrby-shared: total dist output ─────────────────────────────────────
  //
  // WHY this matters: @styrby/shared is imported by CLI, web, and mobile.
  // It gets bundled into the CLI (adding to startup time) and included in
  // the Next.js bundle (adding to first-load JS). Keeping it lean benefits all.
  //
  // tsc emits one .js file per source .ts file, no tree-shaking. The raw
  // dist is the worst-case size any consumer pays.
  //
  // THRESHOLD: 600 KB raw = ~500 KB projected + 20% headroom.
  {
    name: 'styrby-shared: dist/ total (uncompressed)',
    path: 'packages/styrby-shared/dist/**/*.js',
    limit: '600 KB',
    gzip: false,
  },
];
