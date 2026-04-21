/**
 * Tests for the useCostExport pure helpers.
 *
 * WHY: We unit-test the deterministic helpers (URL resolution, filename
 * derivation) since they gate the export contract with the web API and
 * with the native share sheet. The full hook flow (fetch + auth + share)
 * is **deferred test debt** — there is no integration test for it today.
 * Tracked in the Phase 1 #4 follow-up bucket.
 *
 * WHY mock src/lib/supabase: useCostExport.ts imports the supabase client
 * at module-load time, which crashes in jest because no SUPABASE_URL env
 * is set. The mock returns a stub that satisfies the import without making
 * the test depend on env config. Real Supabase calls are not exercised by
 * the pure helpers under test here.
 *
 * @module hooks/__tests__/useCostExport
 */

jest.mock('../../lib/supabase', () => ({
  supabase: {
    auth: { getSession: jest.fn() },
    from: jest.fn(),
  },
}));

import { buildExportFilename, getAppUrl } from '../useCostExport';

describe('buildExportFilename', () => {
  it('builds a CSV filename with the date prefix', () => {
    const fixed = new Date('2026-04-20T15:00:00Z');
    expect(buildExportFilename('csv', fixed)).toBe('styrby-costs-2026-04-20.csv');
  });

  it('builds a JSON filename with the date prefix', () => {
    const fixed = new Date('2026-04-20T15:00:00Z');
    expect(buildExportFilename('json', fixed)).toBe('styrby-costs-2026-04-20.json');
  });

  it('uses the current date when no override is provided', () => {
    const result = buildExportFilename('csv');
    expect(result).toMatch(/^styrby-costs-\d{4}-\d{2}-\d{2}\.csv$/);
  });
});

describe('getAppUrl', () => {
  // WHY no env-var-set test: Expo's babel plugin (`babel-preset-expo`)
  // inlines `process.env.EXPO_PUBLIC_*` at build time, so mutating the env
  // var at jest runtime does NOT change what the compiled function sees.
  // We assert the fallback path (the only branch that actually fires in
  // this jest config). The set-env-var case is exercised by the running
  // app at build time and validated via the Expo build CLI, not jest.

  it('returns the production app URL when EXPO_PUBLIC_APP_URL is not baked in', () => {
    expect(getAppUrl()).toBe('https://app.styrby.com');
  });
});
