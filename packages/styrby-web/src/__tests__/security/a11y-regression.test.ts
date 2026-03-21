/**
 * Accessibility Regression Tests
 *
 * Protects against reintroduction of accessibility violations fixed on
 * 2026-03-21. Each test reads actual source files and asserts that the
 * accessibility fix is present (ARIA attributes, skip links, contrast-safe
 * color classes, etc.). Fast, dependency-free, and CI-safe.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';

// __dirname = packages/styrby-web/src/__tests__/security
//   ../      = __tests__
//   ../../   = src   (where all source files live)
const WEB_SRC = resolve(__dirname, '../../');

function read(relPath: string): string {
  return readFileSync(resolve(WEB_SRC, relPath), 'utf-8');
}

// ============================================================================
// Skip-to-content link
// ============================================================================

describe('skip-to-content link', () => {
  it('layout.tsx contains "Skip to main content" anchor', () => {
    const content = read('app/layout.tsx');
    expect(content).toContain('Skip to main content');
  });

  it('layout.tsx skip link targets #main-content', () => {
    const content = read('app/layout.tsx');
    expect(content).toContain('#main-content');
    expect(content).toContain('main-content');
  });

  it('layout.tsx skip link uses sr-only with focus:not-sr-only for visibility', () => {
    const content = read('app/layout.tsx');
    // The skip link must be visually hidden but appear on keyboard focus
    expect(content).toContain('sr-only');
    expect(content).toContain('focus:not-sr-only');
  });
});

// ============================================================================
// Navigation ARIA labels
// ============================================================================

describe('navigation ARIA labels', () => {
  it('landing navbar has aria-label attribute', () => {
    const content = read('components/landing/navbar.tsx');
    expect(content).toContain('aria-label');
  });

  it('landing navbar aria-label describes navigation purpose', () => {
    const content = read('components/landing/navbar.tsx');
    // Should label the nav element so screen readers announce it correctly
    expect(content).toMatch(/aria-label="[^"]*[Nn]av[^"]*"/);
  });
});

// ============================================================================
// Live region for cost ticker
// ============================================================================

describe('cost-ticker live region', () => {
  it('cost-ticker has aria-live attribute for screen reader announcements', () => {
    const content = read('components/cost-ticker.tsx');
    expect(content).toContain('aria-live');
  });

  it('cost-ticker uses aria-atomic with aria-live', () => {
    const content = read('components/cost-ticker.tsx');
    // aria-atomic ensures the whole value is read, not just the changed portion
    expect(content).toContain('aria-atomic');
  });

  it('cost-ticker aria-live value is polite (not assertive)', () => {
    const content = read('components/cost-ticker.tsx');
    // Cost updates are informational — polite interrupts at natural pause points
    expect(content).toContain('aria-live="polite"');
  });
});

// ============================================================================
// useFocusTrap hook
// ============================================================================

describe('useFocusTrap hook', () => {
  it('useFocusTrap.ts exists in hooks directory', () => {
    expect(() => read('hooks/useFocusTrap.ts')).not.toThrow();
  });

  it('useFocusTrap exports a function', () => {
    const content = read('hooks/useFocusTrap.ts');
    expect(content).toMatch(/export\s+(default\s+)?function\s+useFocusTrap/);
  });
});

// ============================================================================
// Color contrast — no text-zinc-600
// ============================================================================

/**
 * Recursively collect all .tsx files under a directory, skipping
 * the provided ignored subdirectory names.
 */
function collectTsxFiles(dir: string, ignoreDirs: Set<string>): string[] {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir).map(String);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : String(entry);
    if (ignoreDirs.has(name)) continue;
    const full = join(dir, name);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      results.push(...collectTsxFiles(full, ignoreDirs));
    } else if (name.endsWith('.tsx')) {
      results.push(full);
    }
  }
  return results;
}

describe('color contrast — text-zinc-600 eliminated', () => {
  it('no non-UI source file uses text-zinc-600 (contrast violation)', () => {
    // Scan all .tsx files except shadcn/ui components (those are vendor)
    const IGNORE_DIRS = new Set(['ui', 'node_modules', '.next', '__tests__', 'dist']);
    const files = collectTsxFiles(WEB_SRC, IGNORE_DIRS);

    expect(files.length).toBeGreaterThan(0); // Sanity check: found files

    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      if (content.includes('text-zinc-600')) {
        violations.push(file.replace(WEB_SRC + '/', ''));
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `text-zinc-600 found in ${violations.length} file(s) (contrast violation — use text-zinc-400 or higher):\n` +
          violations.map((f) => `  - ${f}`).join('\n')
      );
    }
  });
});

// ============================================================================
// Error message accessibility
// ============================================================================

describe('error messages — role="alert"', () => {
  it('login page error display has role="alert"', () => {
    const content = read('app/login/page.tsx');
    expect(content).toContain('role="alert"');
  });

  it('signup page error display has role="alert" or aria-live', () => {
    const content = read('app/signup/page.tsx');
    // Either pattern is acceptable for error announcements
    const hasAlert = content.includes('role="alert"');
    const hasAriaLive = content.includes('aria-live');
    expect(hasAlert || hasAriaLive).toBe(true);
  });
});
