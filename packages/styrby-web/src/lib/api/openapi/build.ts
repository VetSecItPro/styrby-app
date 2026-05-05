/**
 * build.ts — assemble the OpenAPI document envelope.
 *
 * WHY split out: the generator script and the drift test both need to produce
 * an identical document. Centralising the info/servers metadata here means
 * one source of truth — drift can never come from a discrepancy between the
 * test and the script's envelope.
 *
 * @module lib/api/openapi/build
 */

import type { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';

/**
 * Build the full OpenAPI document from a configured generator.
 *
 * @param generator - Generator instance bound to the v1 registry definitions.
 * @returns OpenAPI 3.1 document object.
 */
export function buildOpenApiDocument(generator: OpenApiGeneratorV31): object {
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Styrby API',
      version: '1.0.0',
      description:
        'Styrby v1 API. Bearer-token authenticated except where noted ' +
        '(/auth/* endpoints are pre-auth). All authenticated endpoints are ' +
        'subject to per-key rate limits surfaced in `X-RateLimit-*` headers.',
      license: {
        name: 'Proprietary - All Rights Reserved (VetSecItPro)',
      },
    },
    servers: [
      {
        url: 'https://styrby.com',
        description: 'Production',
      },
    ],
  });
}
