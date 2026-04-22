/**
 * Size-limit configuration for Styrby monorepo (Phase 1.6.12)
 *
 * WHY size-limit instead of custom shell scripts:
 * - size-limit is the de-facto standard in the JS ecosystem (Next.js, React,
 *   Preact, tRPC all use it). It handles gzip accounting, webpack bundling
 *   when needed, and generates structured JSON output for CI comparison.
 * - It produces clear, actionable output: "X exceeded budget by Y KB (Z% over)"
 *   rather than silent failures or ambiguous numbers.
 *
 * BASELINES (captured 2026-04-22, no existing dist builds):
 *   All baselines are projected from source size analysis:
 *   - styrby-web TS source: ~3.6 MB → projected ~500 KB first-load JS (gzip)
 *   - styrby-cli TS source: ~2.9 MB → projected ~3 MB unminified bundle
 *   - styrby-shared TS source: ~550 KB → projected ~500 KB dist output
 *   - styrby-mobile Metro bundle: measured from /tmp/expo-export in CI
 *
 * HEADROOM: All thresholds are set at projected_baseline * 1.20 (20% headroom).
 * Ratchet these down in Phase 1.6.13 once actual build outputs are profiled.
 *
 * HOW TO MEASURE ACTUAL BASELINES:
 *   1. pnpm --filter @styrby/shared build
 *   2. pnpm --filter styrby-cli build
 *   3. pnpm --filter styrby-web build
 *   4. npx size-limit --json 2>&1 | jq '.'
 *   Update the baseline comments below with the real numbers.
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
  // WHY 800 KB (raised from initial 600 KB projection on 2026-04-22):
  // Next.js framework alone contributes ~100-150 KB gzip. With the app
  // layout, shared utilities, Radix UI primitives, Supabase client, and
  // Phase 1.6.7 dashboard (sparklines, founder ops page, tier-warning
  // cards — Recharts lazy-loaded via dynamic import in cost-charts-dynamic.tsx),
  // the measured real baseline on Phase 1.6.7 merge is ~725 KB gzipped.
  // 800 KB = ~10% headroom on the measured baseline.
  //
  // RATCHET PLAN (Phase 1.6.13): profile the first-load chunks with
  // `next build --profile` + size-limit --why, identify any remaining
  // non-critical imports that can be dynamic()-ed, ratchet back toward
  // 650-700 KB. Tracked in styrby-backlog.md as Phase 1.6.13.
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
    limit: '800 KB',
    gzip: true,
    // WHY import: We cannot import directly from Next.js output — these are
    // already-built assets. The `import` field is omitted; size-limit will
    // stat the files and sum their sizes.
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
