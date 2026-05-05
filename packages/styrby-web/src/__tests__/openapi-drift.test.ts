/**
 * OpenAPI Drift Test (SEC-FOLLOWUP-1)
 *
 * WHY this test exists:
 *   The /api/v1/* surface is consumed by the styrby-cli, mobile clients, and
 *   third-party API-key holders via `openapi.yaml`. If a developer ships a new
 *   route, an HTTP-method change, or a schema tweak without re-running
 *   `npm run generate-openapi`, downstream consumers regress silently.
 *
 *   This suite enforces three invariants:
 *
 *   1. Re-running the generator IN-MEMORY produces YAML byte-identical to the
 *      committed `openapi.yaml`. Catches "edited the registry, forgot to
 *      regenerate."
 *
 *   2. Every `route.ts` under `src/app/api/v1/` has a registered path entry.
 *      Catches "shipped a new route, forgot to register it."
 *
 *   3. Every HTTP verb exported from a v1 `route.ts` (export const GET / POST
 *      / etc., or `export async function GET`) is registered for that path.
 *      Catches "added a PATCH handler to an existing route, forgot to register
 *      the new method."
 *
 * Pattern after `__tests__/security/rpc-contract-sync.test.ts`.
 *
 * @module __tests__/openapi-drift
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, join, relative } from 'path';
import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { parse as yamlParse } from 'yaml';
import { generateYaml } from '../../scripts/generate-openapi';
import { registry } from '../lib/api/openapi/v1-registry';
import { buildOpenApiDocument } from '../lib/api/openapi/build';

// ─── Path roots ───────────────────────────────────────────────────────────────

const WEB_ROOT = resolve(__dirname, '../..');
const V1_DIR = resolve(WEB_ROOT, 'src/app/api/v1');
const COMMITTED_YAML = resolve(WEB_ROOT, 'openapi.yaml');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Recursively collect every `route.ts` under a directory.
 *
 * @param dir - Absolute directory to walk.
 * @returns Absolute paths of every route file found.
 */
function collectRouteFiles(dir: string): string[] {
  const out: string[] = [];
  function walk(d: string): void {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      const s = statSync(full);
      if (s.isDirectory()) walk(full);
      else if (entry === 'route.ts') out.push(full);
    }
  }
  walk(dir);
  return out;
}

/**
 * Convert a route file path into its OpenAPI path.
 *
 * Examples:
 *   /src/app/api/v1/sessions/route.ts            → /api/v1/sessions
 *   /src/app/api/v1/sessions/[id]/route.ts       → /api/v1/sessions/{id}
 *   /src/app/api/v1/contexts/[group_id]/route.ts → /api/v1/contexts/{group_id}
 *
 * @param filePath - Absolute path to a route.ts file.
 * @returns OpenAPI path string.
 */
function filePathToApiPath(filePath: string): string {
  const rel = relative(resolve(WEB_ROOT, 'src/app'), filePath)
    .replace(/\\/g, '/')
    .replace(/\/route\.ts$/, '');
  // Convert [foo] dynamic segments to {foo}.
  return '/' + rel.replace(/\[([^\]]+)\]/g, '{$1}');
}

const HTTP_VERBS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;
type HttpVerb = (typeof HTTP_VERBS)[number];

/**
 * Extract HTTP verb exports from a route file.
 *
 * Recognises BOTH patterns:
 *   - `export const POST = ...`
 *   - `export async function POST(...)`
 *
 * Strips block comments first so JSDoc `@example` snippets do not produce
 * false positives.
 *
 * @param filePath - Absolute path to the route file.
 * @returns Array of HTTP verbs the file exports.
 */
function extractExportedVerbs(filePath: string): HttpVerb[] {
  let src = readFileSync(filePath, 'utf-8');
  // Strip block comments.
  src = src.replace(/\/\*[\s\S]*?\*\//g, '');
  // Strip line comments.
  src = src.replace(/\/\/[^\n]*/g, '');

  const found = new Set<HttpVerb>();
  for (const verb of HTTP_VERBS) {
    const re = new RegExp(
      `export\\s+(?:const\\s+${verb}\\s*=|async\\s+function\\s+${verb}\\b|function\\s+${verb}\\b)`,
    );
    if (re.test(src)) found.add(verb);
  }
  return [...found];
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('OpenAPI drift — committed openapi.yaml stays in lock-step with the v1 registry', () => {
  it('re-running the generator produces YAML byte-identical to the committed copy', () => {
    const fresh = generateYaml();
    const committed = readFileSync(COMMITTED_YAML, 'utf-8');

    if (fresh !== committed) {
      // Provide a focused diff hint so the failure is actionable.
      const freshLines = fresh.split('\n');
      const committedLines = committed.split('\n');
      const maxLen = Math.max(freshLines.length, committedLines.length);
      const diffs: string[] = [];
      for (let i = 0; i < maxLen && diffs.length < 10; i++) {
        if (freshLines[i] !== committedLines[i]) {
          diffs.push(
            `  L${i + 1}\n    committed: ${JSON.stringify(committedLines[i] ?? '<EOF>')}\n    fresh:     ${JSON.stringify(freshLines[i] ?? '<EOF>')}`,
          );
        }
      }
      throw new Error(
        '\n\nopenapi.yaml is out of sync with the v1 registry.\n\n' +
          (diffs.length > 0 ? `First mismatches:\n${diffs.join('\n')}\n\n` : '') +
          `Fix: run \`pnpm --filter styrby-web generate-openapi\` and commit ` +
          `the updated \`openapi.yaml\`.\n`,
      );
    }
    expect(fresh).toBe(committed);
  });

  // Build a structural index of the committed spec for the next two tests.
  const yamlText = readFileSync(COMMITTED_YAML, 'utf-8');
  const spec = yamlParse(yamlText) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const specPaths = new Set(Object.keys(spec.paths ?? {}));

  // Index registered methods by path. Use the in-memory document (rather than
  // re-parsing YAML) to keep this independent of YAML formatting quirks.
  const liveDoc = buildOpenApiDocument(
    new OpenApiGeneratorV31(registry.definitions),
  ) as { paths: Record<string, Record<string, unknown>> };
  const liveMethodsByPath = new Map<string, Set<string>>();
  for (const [p, ops] of Object.entries(liveDoc.paths)) {
    liveMethodsByPath.set(
      p,
      new Set(Object.keys(ops).map((m) => m.toUpperCase())),
    );
  }

  const routeFiles = collectRouteFiles(V1_DIR);

  it('every v1 route file is registered in the OpenAPI spec', () => {
    expect(routeFiles.length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const file of routeFiles) {
      const apiPath = filePathToApiPath(file);
      if (!specPaths.has(apiPath)) {
        missing.push(`  ${apiPath}  (file: ${relative(WEB_ROOT, file)})`);
      }
    }

    if (missing.length > 0) {
      throw new Error(
        '\n\nThe following v1 routes are NOT registered in the OpenAPI spec:\n\n' +
          missing.join('\n') +
          '\n\nFix: add a `registry.registerPath(...)` entry in ' +
          '`src/lib/api/openapi/v1-registry.ts` for each path above, then run ' +
          '`pnpm --filter styrby-web generate-openapi`.\n',
      );
    }
  });

  it('every exported HTTP verb has a matching registry entry for its path', () => {
    const violations: string[] = [];

    for (const file of routeFiles) {
      const apiPath = filePathToApiPath(file);
      const exported = extractExportedVerbs(file);
      const registered = liveMethodsByPath.get(apiPath) ?? new Set();

      for (const verb of exported) {
        if (!registered.has(verb)) {
          violations.push(
            `  ${verb} ${apiPath}  (file: ${relative(WEB_ROOT, file)})`,
          );
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        '\n\nThe following exported HTTP verbs are NOT registered in the ' +
          'OpenAPI spec:\n\n' +
          violations.join('\n') +
          '\n\nFix: add the missing method(s) to the matching ' +
          '`registry.registerPath(...)` call in v1-registry.ts and regenerate.\n',
      );
    }
  });
});
