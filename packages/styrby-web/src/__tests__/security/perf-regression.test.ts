/**
 * Performance Regression Tests
 *
 * Protects against reintroduction of performance regressions fixed on
 * 2026-03-21. Each test reads actual source files to verify that
 * performance-critical patterns remain in place.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// __dirname = packages/styrby-web/src/__tests__/security
//   ../      = __tests__
//   ../../   = src   (where all source files live)
const WEB_SRC = resolve(__dirname, '../../');
const CLI_SRC = resolve(__dirname, '../../../../styrby-cli/src');

function readWeb(relPath: string): string {
  return readFileSync(resolve(WEB_SRC, relPath), 'utf-8');
}

function readCli(relPath: string): string {
  return readFileSync(resolve(CLI_SRC, relPath), 'utf-8');
}

// ============================================================================
// force-dynamic on dashboard pages
// ============================================================================

describe('dashboard pages — force-dynamic directive', () => {
  it('dashboard home page has force-dynamic export', () => {
    const content = readWeb('app/dashboard/page.tsx');
    expect(content).toContain("export const dynamic = 'force-dynamic'");
  });

  it('sessions list page has force-dynamic export', () => {
    const content = readWeb('app/dashboard/sessions/page.tsx');
    expect(content).toContain("export const dynamic = 'force-dynamic'");
  });

  it('costs page has force-dynamic export', () => {
    const content = readWeb('app/dashboard/costs/page.tsx');
    expect(content).toContain("export const dynamic = 'force-dynamic'");
  });
});

// ============================================================================
// cost-ticker — module-level Intl.NumberFormat
// ============================================================================

describe('cost-ticker — Intl.NumberFormat hoisted to module level', () => {
  it('cost-ticker defines COST_FORMATTER at module (top) level', () => {
    const content = readWeb('components/cost-ticker.tsx');
    // Must be a module-level const starting with COST_FORMATTER
    expect(content).toMatch(/^const COST_FORMATTER/m);
  });

  it('cost-ticker has two formatters (normal and micro amounts)', () => {
    const content = readWeb('components/cost-ticker.tsx');
    expect(content).toContain('COST_FORMATTER_NORMAL');
    expect(content).toContain('COST_FORMATTER_MICRO');
  });

  it('cost-ticker Intl.NumberFormat is not instantiated inside a render function', () => {
    const content = readWeb('components/cost-ticker.tsx');
    // The new Intl.NumberFormat() call must appear before any function/component definition
    // at module scope, not inside a function body
    const firstFormatter = content.indexOf('new Intl.NumberFormat');
    const firstFunction = content.search(/^(export\s+)?(default\s+)?function\s/m);
    expect(firstFormatter).toBeGreaterThan(-1);
    expect(firstFormatter).toBeLessThan(firstFunction);
  });
});

// ============================================================================
// budget-monitor — Promise.all for concurrent alert checks
// ============================================================================

describe('budget-monitor — parallel alert checking', () => {
  it('budget-monitor uses Promise.all for concurrent cost fetches', () => {
    const content = readCli('costs/budget-monitor.ts');
    expect(content).toContain('Promise.all');
  });

  it('budget-monitor uses Promise.all for concurrent alert evaluation', () => {
    const content = readCli('costs/budget-monitor.ts');
    // Should appear at least twice: once for cost fetches, once for alert checks
    const matches = content.match(/Promise\.all/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });
});

// ============================================================================
// cost-reporter — MAX_PENDING buffer cap
// ============================================================================

describe('cost-reporter — MAX_PENDING memory cap', () => {
  it('cost-reporter defines MAX_PENDING constant', () => {
    const content = readCli('costs/cost-reporter.ts');
    expect(content).toContain('MAX_PENDING');
  });

  it('cost-reporter MAX_PENDING is used in addRecord to cap the buffer', () => {
    const content = readCli('costs/cost-reporter.ts');
    // The guard must reference MAX_PENDING in the record-adding path
    expect(content).toMatch(/pendingRecords\.length\s*>=\s*MAX_PENDING/);
  });

  it('cost-reporter drops oldest record when MAX_PENDING is exceeded', () => {
    const content = readCli('costs/cost-reporter.ts');
    // Oldest record is at index 0 — shift() removes it
    expect(content).toContain('pendingRecords.shift()');
  });

  it('cost-reporter MAX_PENDING guard also applies in reportImmediate', () => {
    const content = readCli('costs/cost-reporter.ts');
    // Both addRecord and reportImmediate fallback path should cap the buffer
    const guardCount = (content.match(/pendingRecords\.length\s*>=\s*MAX_PENDING/g) || []).length;
    expect(guardCount).toBeGreaterThanOrEqual(2);
  });
});

// ============================================================================
// session messages query — .limit()
// ============================================================================

describe('session messages query — result limit', () => {
  it('session [id] page applies .limit() to session_messages query', () => {
    const content = readWeb('app/dashboard/sessions/[id]/page.tsx');
    expect(content).toContain('.limit(');
  });

  it('dashboard home page applies .limit() to sessions query', () => {
    const content = readWeb('app/dashboard/page.tsx');
    expect(content).toContain('.limit(');
  });

  it('dashboard home page applies .limit() to today cost_records query', () => {
    const content = readWeb('app/dashboard/page.tsx');
    // Should have at least two .limit() calls: sessions and cost_records
    const matches = content.match(/\.limit\(/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });
});

// ============================================================================
// rate limiter — no setInterval leak in tests
// ============================================================================

describe('rate-limiter — test environment safety', () => {
  it('rateLimit.ts guards setInterval with NODE_ENV !== test check', () => {
    const content = readWeb('lib/rateLimit.ts');
    expect(content).toContain("process.env.NODE_ENV !== 'test'");
  });
});

// ============================================================================
// Phase 1.6.13 bundle ratchet — dynamic import guards
//
// WHY these tests exist: Dynamic imports are the mechanism that keeps heavy
// libraries (cmdk, ActivityGraph, CloudTasksPanel, OnboardingModal, OtelSettings,
// SupportModal, FeedbackDialog) out of the first-load JS bundle. If someone
// reverts these to static imports, the bundle grows by ~165 kB gzipped and
// CI's size-limit check at 700 KB will fail. But size-limit only runs in CI,
// not locally. These source-level regression tests provide instant local
// feedback that the dynamic import pattern is still in place.
// ============================================================================

describe('Phase 1.6.13 — dynamic imports in dashboard-shell.tsx', () => {
  it('CommandPalette is dynamic (cmdk library deferred)', () => {
    const content = readWeb('app/dashboard/dashboard-shell.tsx');
    expect(content).toContain('dynamic(');
    expect(content).toContain("'@/components/dashboard/command-palette'");
    // Must NOT be a static import
    expect(content).not.toMatch(/^import\s+\{[^}]*CommandPalette[^}]*\}\s+from/m);
  });

  it('OnboardingModal is dynamic (first-time only UX deferred)', () => {
    const content = readWeb('app/dashboard/dashboard-shell.tsx');
    expect(content).toContain("'@/components/dashboard/onboarding-modal'");
    expect(content).not.toMatch(/^import\s+\{[^}]*OnboardingModal[^}]*\}\s+from/m);
  });

  it('OnboardingBanner is dynamic (first-time only UX deferred)', () => {
    const content = readWeb('app/dashboard/dashboard-shell.tsx');
    expect(content).toContain("'@/components/dashboard/onboarding-banner'");
    expect(content).not.toMatch(/^import\s+\{[^}]*OnboardingBanner[^}]*\}\s+from/m);
  });
});

describe('Phase 1.6.13 — dynamic imports in dashboard-realtime.tsx', () => {
  it('ActivityGraph is dynamic (below-fold Pro+ component deferred)', () => {
    const content = readWeb('app/dashboard/dashboard-realtime.tsx');
    expect(content).toContain('dynamic(');
    expect(content).toContain("'@/components/activity-graph'");
    expect(content).not.toMatch(/^import\s+\{[^}]*ActivityGraph[^}]*\}\s+from/m);
  });

  it('CloudTasksPanel is dynamic (Power-only component deferred)', () => {
    const content = readWeb('app/dashboard/dashboard-realtime.tsx');
    expect(content).toContain("'@/components/cloud-tasks'");
    expect(content).not.toMatch(/^import\s+\{[^}]*CloudTasksPanel[^}]*\}\s+from/m);
  });
});

describe('Phase 1.6.13 — dynamic imports in settings-client.tsx', () => {
  it('OtelSettings is dynamic (Power-only 506-line component deferred)', () => {
    const content = readWeb('app/dashboard/settings/settings-client.tsx');
    // dynamic() or dynamic<Props>() are both valid forms
    expect(content).toMatch(/dynamic[<(]/);
    expect(content).toContain("'@/components/dashboard/otel-settings'");
    expect(content).not.toMatch(/^import\s+\{[^}]*OtelSettings[^}]*\}\s+from/m);
  });
});

describe('Phase 1.6.13 — dynamic imports in settings-support.tsx', () => {
  it('SupportModal is dynamic (on-demand modal deferred)', () => {
    const content = readWeb('app/dashboard/settings/_components/settings-support.tsx');
    expect(content).toContain('dynamic(');
    expect(content).toContain("'@/components/dashboard/support-modal'");
    expect(content).not.toMatch(/^import\s+\{[^}]*SupportModal[^}]*\}\s+from/m);
  });

  it('FeedbackDialog is dynamic (on-demand modal deferred)', () => {
    const content = readWeb('app/dashboard/settings/_components/settings-support.tsx');
    expect(content).toContain("'@/components/dashboard/feedback-dialog'");
    expect(content).not.toMatch(/^import\s+\{[^}]*FeedbackDialog[^}]*\}\s+from/m);
  });
});
