/**
 * generate-openapi.ts — emit `openapi.yaml` from the v1 registry.
 *
 * WHY this script exists (SEC-FOLLOWUP-1):
 *   The /api/v1/* surface needs a machine-readable contract for SDK
 *   generation, third-party API consumers, and Postman/Stoplight tooling.
 *   The registry under `src/lib/api/openapi/v1-registry.ts` is the source of
 *   truth; this script materialises it as YAML and the drift test
 *   (`src/__tests__/openapi-drift.test.ts`) verifies the committed YAML
 *   stays in lock-step with the registry.
 *
 * Usage:
 *   pnpm --filter styrby-web generate-openapi
 *
 * Output:
 *   packages/styrby-web/openapi.yaml — committed, consumed by SDK/docs tooling.
 *
 * @module scripts/generate-openapi
 */

import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { stringify as yamlStringify } from 'yaml';
import { registry } from '../src/lib/api/openapi/v1-registry';
import { buildOpenApiDocument } from '../src/lib/api/openapi/build';

/**
 * Generates the OpenAPI document from the registry and serialises to YAML.
 *
 * @returns YAML string ready to write to disk.
 */
export function generateYaml(): string {
  const doc = buildOpenApiDocument(new OpenApiGeneratorV31(registry.definitions));
  // WHY lineWidth: 0 — disable line wrapping so multi-line description strings
  // do not get reformatted across YAML versions / wrap-column changes. This
  // keeps the output deterministic for the drift test.
  return yamlStringify(doc, { lineWidth: 0 });
}

function main(): void {
  const yaml = generateYaml();
  const out = resolve(__dirname, '..', 'openapi.yaml');
  writeFileSync(out, yaml, 'utf-8');
  // eslint-disable-next-line no-console
  console.log(`Wrote ${out} (${yaml.split('\n').length} lines).`);
}

// CLI entry — only run when invoked directly, not when imported by the test.
if (require.main === module) {
  main();
}
