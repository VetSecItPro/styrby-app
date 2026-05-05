/**
 * OpenAPI v1 Registry — single source of truth for the /api/v1/* contract.
 *
 * WHY this file exists (SEC-FOLLOWUP-1):
 *   The /api/v1/* surface is consumed by the styrby-cli, mobile clients, and
 *   third-party API-key holders. Without a machine-readable contract, drift
 *   between the route handler and what callers expect can ship silently. This
 *   file mirrors the Zod schemas defined in each route's local
 *   `const ...Schema = z.object(...)` block (Next.js App Router forbids
 *   exporting non-handler symbols from a `route.ts`, so the schemas cannot
 *   simply be imported — they must be re-declared here under test discipline).
 *
 * Drift-detection: see `src/__tests__/openapi-drift.test.ts`. That suite
 *   asserts every v1 route file has a corresponding registry entry with
 *   matching exported HTTP verbs, and that re-running the generator produces
 *   an `openapi.yaml` byte-identical to the committed copy.
 *
 * To add a new endpoint:
 *   1. Land the route under `src/app/api/v1/.../route.ts`.
 *   2. Append a `registry.registerPath({...})` call below.
 *   3. Run `npm run generate-openapi` and commit `openapi.yaml`.
 *
 * @module lib/api/openapi/v1-registry
 */

import {
  OpenAPIRegistry,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

// ─── Registry ─────────────────────────────────────────────────────────────────

export const registry = new OpenAPIRegistry();

// ─── Reusable security scheme ─────────────────────────────────────────────────

/**
 * Bearer API-key security scheme. All API-key-protected endpoints reference
 * this by name. Keys carry the `styrby_*` prefix and are validated by
 * `withApiAuthAndRateLimit`.
 */
const apiKeyAuth = registry.registerComponent('securitySchemes', 'apiKeyBearer', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'styrby_<env>_<random>',
  description:
    'API key passed as `Authorization: Bearer <key>`. Issued from the dashboard. ' +
    'Subject to per-key rate limits returned in `X-RateLimit-*` response headers.',
});

// ─── Reusable response shapes ─────────────────────────────────────────────────

const ErrorResponse = registry.register(
  'ErrorResponse',
  z.object({
    error: z.string().openapi({ example: 'Validation failed' }),
    message: z.string().optional(),
  })
);

const PaginationMeta = registry.register(
  'PaginationMeta',
  z.object({
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
    hasMore: z.boolean(),
  })
);

// Common error responses applied to every authenticated endpoint.
const standardErrorResponses = {
  400: {
    description: 'Bad Request — validation failed or malformed body.',
    content: { 'application/json': { schema: ErrorResponse } },
  },
  401: {
    description: 'Unauthorized — missing or invalid API key.',
    content: { 'application/json': { schema: ErrorResponse } },
  },
  429: {
    description: 'Too Many Requests — rate limit exceeded.',
    content: { 'application/json': { schema: ErrorResponse } },
  },
  500: {
    description: 'Internal Server Error.',
    content: { 'application/json': { schema: ErrorResponse } },
  },
} as const;

// ─── Domain schemas (mirrored from route handlers) ────────────────────────────
// WHY duplicate from routes: Next.js App Router only permits HTTP-verb exports
// from `route.ts`. Re-declaration is unavoidable; drift is contained by the
// drift test which scans both sides for shape parity.

const SessionStatusEnum = z.enum([
  'starting',
  'running',
  'idle',
  'paused',
  'stopped',
  'error',
  'expired',
]);

const AgentTypeEnum = z.enum(['claude', 'codex', 'gemini']);

const SessionRow = registry.register(
  'Session',
  z.object({
    id: z.string().uuid(),
    agent_type: AgentTypeEnum,
    model: z.string().nullable(),
    title: z.string().nullable(),
    summary: z.string().nullable(),
    project_path: z.string().nullable(),
    git_branch: z.string().nullable(),
    tags: z.array(z.string()).nullable(),
    is_archived: z.boolean(),
    status: SessionStatusEnum,
    started_at: z.string().datetime().nullable(),
    ended_at: z.string().datetime().nullable(),
    last_activity_at: z.string().datetime().nullable(),
    total_cost_usd: z.number(),
    total_input_tokens: z.number().int(),
    total_output_tokens: z.number().int(),
    total_cache_tokens: z.number().int(),
    message_count: z.number().int(),
    created_at: z.string().datetime(),
  })
);

// ─── Path registrations ───────────────────────────────────────────────────────

// GET /api/v1/account
registry.registerPath({
  method: 'get',
  path: '/api/v1/account',
  summary: 'Account profile + key metadata for the bearer API key',
  tags: ['account'],
  security: [{ [apiKeyAuth.name]: [] }],
  responses: {
    200: {
      description: 'Account + key metadata.',
      content: {
        'application/json': {
          schema: z.object({
            user_id: z.string().uuid(),
            key_id: z.string(),
            scopes: z.array(z.string()),
            key_expires_at: z.string().datetime().nullable(),
          }),
        },
      },
    },
    ...standardErrorResponses,
  },
});

// POST /api/v1/audit
registry.registerPath({
  method: 'post',
  path: '/api/v1/audit',
  summary: 'Append an audit-log event for the authenticated user',
  tags: ['audit'],
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            action: z.string().min(1).max(100),
            resource_type: z.string().max(100).optional(),
            resource_id: z.string().max(255).optional(),
            metadata: z.record(z.unknown()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: 'Audit event recorded.' },
    ...standardErrorResponses,
  },
});

// GET /api/v1/audit
registry.registerPath({
  method: 'get',
  path: '/api/v1/audit',
  summary: 'List audit events for an action',
  tags: ['audit'],
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    query: z.object({
      action: z.string().min(1).max(100),
      resource_id: z.string().max(255).optional(),
      resource_type: z.string().max(100).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      since: z.string().datetime({ offset: true }).optional(),
    }),
  },
  responses: {
    200: {
      description: 'Matching audit events, newest first.',
      content: {
        'application/json': {
          schema: z.object({ events: z.array(z.record(z.unknown())) }),
        },
      },
    },
    ...standardErrorResponses,
  },
});

// POST /api/v1/auth/exchange
registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/exchange',
  summary: 'Exchange a session cookie for a short-lived API token',
  tags: ['auth'],
  responses: {
    200: { description: 'Token issued.' },
    401: standardErrorResponses[401],
    500: standardErrorResponses[500],
  },
});

// POST /api/v1/auth/oauth/start
registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/oauth/start',
  summary: 'Start an OAuth login flow (Google, GitHub)',
  tags: ['auth'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            provider: z.enum(['google', 'github']),
            redirect_to: z.string().url(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'OAuth provider URL to redirect the user to.',
      content: {
        'application/json': {
          schema: z.object({ url: z.string().url() }),
        },
      },
    },
    400: standardErrorResponses[400],
    500: standardErrorResponses[500],
  },
});

// POST /api/v1/auth/oauth/callback
registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/oauth/callback',
  summary: 'Complete OAuth login by exchanging a PKCE code',
  tags: ['auth'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            code: z.string().min(1),
            state: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Session established (cookies set).' },
    400: standardErrorResponses[400],
    500: standardErrorResponses[500],
  },
});

// POST /api/v1/auth/otp/send
registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/otp/send',
  summary: 'Send a one-time password to an email address',
  tags: ['auth'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({ email: z.string().email() }),
        },
      },
    },
  },
  responses: {
    200: { description: 'OTP dispatched.' },
    400: standardErrorResponses[400],
    429: standardErrorResponses[429],
    500: standardErrorResponses[500],
  },
});

// POST /api/v1/auth/otp/verify
registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/otp/verify',
  summary: 'Verify an emailed OTP and establish a session',
  tags: ['auth'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            email: z.string().email(),
            token: z.string().min(6).max(10),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Session established (cookies set).' },
    400: standardErrorResponses[400],
    401: standardErrorResponses[401],
    500: standardErrorResponses[500],
  },
});

// POST /api/v1/broadcast
registry.registerPath({
  method: 'post',
  path: '/api/v1/broadcast',
  summary: 'Broadcast a real-time message to the user channel',
  tags: ['realtime'],
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            channel: z.string().min(1).max(100),
            event: z.string().min(1).max(100),
            payload: z.record(z.unknown()),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Broadcast accepted.' },
    ...standardErrorResponses,
  },
});

// POST /api/v1/contexts
registry.registerPath({
  method: 'post',
  path: '/api/v1/contexts',
  summary: 'Create a context blob attached to a session group',
  tags: ['contexts'],
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            group_id: z.string().uuid(),
            kind: z.string().min(1).max(50),
            content: z.unknown(),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: 'Context created.' },
    ...standardErrorResponses,
  },
});

// GET /api/v1/contexts/{group_id}
registry.registerPath({
  method: 'get',
  path: '/api/v1/contexts/{group_id}',
  summary: 'List contexts for a session group',
  tags: ['contexts'],
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    params: z.object({ group_id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: 'Contexts for the group.',
      content: {
        'application/json': {
          schema: z.object({ contexts: z.array(z.record(z.unknown())) }),
        },
      },
    },
    404: {
      description: 'Group not found or not owned by caller.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    ...standardErrorResponses,
  },
});

// POST /api/v1/cost-records
registry.registerPath({
  method: 'post',
  path: '/api/v1/cost-records',
  summary: 'Append a cost record (token usage) for a session',
  tags: ['costs'],
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            session_id: z.string().uuid(),
            input_tokens: z.number().int().nonnegative(),
            output_tokens: z.number().int().nonnegative(),
            cache_tokens: z.number().int().nonnegative().optional(),
            model: z.string().min(1).max(100),
            cost_usd: z.number().nonnegative(),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: 'Cost record stored.' },
    404: {
      description: 'Session not found or not owned by caller.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    ...standardErrorResponses,
  },
});

// GET /api/v1/costs
registry.registerPath({
  method: 'get',
  path: '/api/v1/costs',
  summary: 'Aggregated cost summary by period',
  tags: ['costs'],
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    query: z.object({
      period: z.enum(['daily', 'weekly', 'monthly']).default('monthly'),
    }),
  },
  responses: {
    200: {
      description: 'Cost summary buckets.',
      content: {
        'application/json': {
          schema: z.object({
            period: z.enum(['daily', 'weekly', 'monthly']),
            buckets: z.array(
              z.object({
                bucket_start: z.string().datetime(),
                total_cost_usd: z.number(),
                total_input_tokens: z.number().int(),
                total_output_tokens: z.number().int(),
              })
            ),
          }),
        },
      },
    },
    ...standardErrorResponses,
  },
});

// GET /api/v1/costs/breakdown
registry.registerPath({
  method: 'get',
  path: '/api/v1/costs/breakdown',
  summary: 'Cost breakdown by agent/model over the last N days',
  tags: ['costs'],
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    query: z.object({
      days: z.coerce.number().int().min(1).max(365).default(30),
    }),
  },
  responses: {
    200: {
      description: 'Breakdown by agent and model.',
      content: {
        'application/json': {
          schema: z.object({
            by_agent: z.array(z.record(z.unknown())),
            by_model: z.array(z.record(z.unknown())),
          }),
        },
      },
    },
    ...standardErrorResponses,
  },
});

// GET /api/v1/costs/export
registry.registerPath({
  method: 'get',
  path: '/api/v1/costs/export',
  summary: 'Export raw cost records as CSV',
  tags: ['costs'],
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    query: z.object({
      days: z.coerce.number().int().min(1).max(365).default(30),
    }),
  },
  responses: {
    200: {
      description: 'CSV export of cost records.',
      content: {
        'text/csv': { schema: z.string() },
      },
    },
    ...standardErrorResponses,
  },
});

// GET /api/v1/machines
registry.registerPath({
  method: 'get',
  path: '/api/v1/machines',
  summary: 'List registered CLI machines',
  tags: ['machines'],
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    query: z.object({
      online_only: z.enum(['true', 'false']).default('false'),
    }),
  },
  responses: {
    200: {
      description: 'Machines registered to the user.',
      content: {
        'application/json': {
          schema: z.object({
            machines: z.array(z.record(z.unknown())),
          }),
        },
      },
    },
    ...standardErrorResponses,
  },
});

// POST /api/v1/machines
registry.registerPath({
  method: 'post',
  path: '/api/v1/machines',
  summary: 'Register a new CLI machine for the authenticated user',
  tags: ['machines'],
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            hostname: z.string().min(1).max(255),
            platform: z.string().min(1).max(50),
            cli_version: z.string().min(1).max(50),
            public_key: z.string().min(1),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: 'Machine registered.' },
    ...standardErrorResponses,
  },
});

// GET /api/v1/notification_preferences
registry.registerPath({
  method: 'get',
  path: '/api/v1/notification_preferences',
  summary: 'Read notification preferences for the user',
  tags: ['notifications'],
  security: [{ [apiKeyAuth.name]: [] }],
  responses: {
    200: {
      description: 'Notification preferences row.',
      content: {
        'application/json': { schema: z.record(z.unknown()) },
      },
    },
    ...standardErrorResponses,
  },
});

// GET /api/v1/sessions
registry.registerPath({
  method: 'get',
  path: '/api/v1/sessions',
  summary: 'List sessions for the authenticated user',
  tags: ['sessions'],
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).default(20),
      offset: z.coerce.number().int().min(0).default(0),
      status: SessionStatusEnum.optional(),
      agent_type: AgentTypeEnum.optional(),
      archived: z.enum(['true', 'false']).default('false'),
    }),
  },
  responses: {
    200: {
      description: 'Paginated session list.',
      content: {
        'application/json': {
          schema: z.object({
            sessions: z.array(SessionRow),
            pagination: PaginationMeta,
          }),
        },
      },
    },
    ...standardErrorResponses,
  },
});

// GET /api/v1/sessions/{id}
registry.registerPath({
  method: 'get',
  path: '/api/v1/sessions/{id}',
  summary: 'Fetch a single session by ID',
  tags: ['sessions'],
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: 'Session row.',
      content: { 'application/json': { schema: SessionRow } },
    },
    404: {
      description: 'Not found or not owned.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    ...standardErrorResponses,
  },
});

// PATCH /api/v1/sessions/{id}
registry.registerPath({
  method: 'patch',
  path: '/api/v1/sessions/{id}',
  summary: 'Update mutable fields on a session',
  tags: ['sessions'],
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            title: z.string().max(200).optional(),
            summary: z.string().optional(),
            tags: z.array(z.string().max(50)).max(20).optional(),
            is_archived: z.boolean().optional(),
            status: SessionStatusEnum.optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Updated session.',
      content: { 'application/json': { schema: SessionRow } },
    },
    404: {
      description: 'Not found or not owned.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    ...standardErrorResponses,
  },
});

// GET /api/v1/sessions/{id}/messages
registry.registerPath({
  method: 'get',
  path: '/api/v1/sessions/{id}/messages',
  summary: 'List messages in a session (E2E-encrypted payloads)',
  tags: ['sessions'],
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    query: z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
      type: z
        .enum([
          'user_prompt',
          'agent_response',
          'agent_thinking',
          'permission_request',
          'permission_response',
          'tool_use',
          'tool_result',
          'error',
          'system',
        ])
        .optional(),
    }),
  },
  responses: {
    200: {
      description: 'Paginated message list.',
      content: {
        'application/json': {
          schema: z.object({
            messages: z.array(z.record(z.unknown())),
            pagination: PaginationMeta,
          }),
        },
      },
    },
    ...standardErrorResponses,
  },
});

// POST /api/v1/sessions/{id}/summary
registry.registerPath({
  method: 'post',
  path: '/api/v1/sessions/{id}/summary',
  summary: 'Generate (or refresh) the AI-summary for a session',
  tags: ['sessions'],
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: 'Summary generated.',
      content: {
        'application/json': {
          schema: z.object({ summary: z.string() }),
        },
      },
    },
    404: {
      description: 'Session not found or not owned.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    502: {
      description: 'Upstream LLM error.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    ...standardErrorResponses,
  },
});

// GET /api/v1/sessions/{id}/checkpoints
registry.registerPath({
  method: 'get',
  path: '/api/v1/sessions/{id}/checkpoints',
  summary: 'List checkpoints for a session',
  tags: ['checkpoints'],
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: 'Checkpoints, newest first.',
      content: {
        'application/json': {
          schema: z.object({
            checkpoints: z.array(z.record(z.unknown())),
          }),
        },
      },
    },
    ...standardErrorResponses,
  },
});

// POST /api/v1/sessions/{id}/checkpoints
registry.registerPath({
  method: 'post',
  path: '/api/v1/sessions/{id}/checkpoints',
  summary: 'Create a named checkpoint at a message sequence position',
  tags: ['checkpoints'],
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            name: z
              .string()
              .min(1)
              .max(100)
              .regex(/^[a-zA-Z0-9 \-_.]+$/),
            description: z.string().nullable().optional(),
            messageSequenceNumber: z.number().int().nonnegative(),
            contextSnapshot: z
              .object({
                totalTokens: z.number().int().nonnegative().default(0),
                fileCount: z.number().int().nonnegative().default(0),
              })
              .optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: 'Checkpoint created.' },
    ...standardErrorResponses,
  },
});

// DELETE /api/v1/sessions/{id}/checkpoints
registry.registerPath({
  method: 'delete',
  path: '/api/v1/sessions/{id}/checkpoints',
  summary: 'Delete a named checkpoint',
  tags: ['checkpoints'],
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    query: z.object({ checkpoint_id: z.string().uuid() }),
  },
  responses: {
    204: { description: 'Deleted.' },
    404: {
      description: 'Checkpoint not found or not owned.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    ...standardErrorResponses,
  },
});

// POST /api/v1/sessions/groups
registry.registerPath({
  method: 'post',
  path: '/api/v1/sessions/groups',
  summary: 'Create a new agent session group',
  tags: ['session-groups'],
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().min(1).max(200),
            description: z.string().max(2000).optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: 'Group created.' },
    ...standardErrorResponses,
  },
});

// GET /api/v1/sessions/groups
registry.registerPath({
  method: 'get',
  path: '/api/v1/sessions/groups',
  summary: 'List session groups',
  tags: ['session-groups'],
  security: [{ [apiKeyAuth.name]: [] }],
  responses: {
    200: {
      description: 'Group list.',
      content: {
        'application/json': {
          schema: z.object({
            groups: z.array(z.record(z.unknown())),
          }),
        },
      },
    },
    ...standardErrorResponses,
  },
});

// DELETE /api/v1/sessions/groups/{id}
registry.registerPath({
  method: 'delete',
  path: '/api/v1/sessions/groups/{id}',
  summary: 'Delete a session group',
  tags: ['session-groups'],
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    204: { description: 'Deleted.' },
    404: {
      description: 'Group not found or not owned.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    ...standardErrorResponses,
  },
});

// POST /api/v1/sessions/groups/{id}/focus
registry.registerPath({
  method: 'post',
  path: '/api/v1/sessions/groups/{id}/focus',
  summary: 'Focus a session within a group (handoff target)',
  tags: ['session-groups'],
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            session_id: z.string().uuid(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Focus set.' },
    404: {
      description: 'Group or session not found.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    ...standardErrorResponses,
  },
});

// POST /api/v1/templates
registry.registerPath({
  method: 'post',
  path: '/api/v1/templates',
  summary: 'Create a prompt template',
  tags: ['templates'],
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().min(1).max(200),
            content: z.string().min(1),
            tags: z.array(z.string().max(50)).optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: 'Template created.' },
    ...standardErrorResponses,
  },
});

// GET /api/v1/templates
registry.registerPath({
  method: 'get',
  path: '/api/v1/templates',
  summary: 'List prompt templates',
  tags: ['templates'],
  security: [{ [apiKeyAuth.name]: [] }],
  responses: {
    200: {
      description: 'Templates list.',
      content: {
        'application/json': {
          schema: z.object({
            templates: z.array(z.record(z.unknown())),
          }),
        },
      },
    },
    ...standardErrorResponses,
  },
});

// GET /api/v1/templates/{id}
registry.registerPath({
  method: 'get',
  path: '/api/v1/templates/{id}',
  summary: 'Read a single template',
  tags: ['templates'],
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: 'Template row.',
      content: {
        'application/json': { schema: z.record(z.unknown()) },
      },
    },
    404: {
      description: 'Not found or not owned.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    ...standardErrorResponses,
  },
});

// PATCH /api/v1/templates/{id}
registry.registerPath({
  method: 'patch',
  path: '/api/v1/templates/{id}',
  summary: 'Update a prompt template',
  tags: ['templates'],
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().min(1).max(200).optional(),
            content: z.string().min(1).optional(),
            tags: z.array(z.string().max(50)).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Updated.' },
    404: {
      description: 'Not found or not owned.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    ...standardErrorResponses,
  },
});

// DELETE /api/v1/templates/{id}
registry.registerPath({
  method: 'delete',
  path: '/api/v1/templates/{id}',
  summary: 'Delete a prompt template',
  tags: ['templates'],
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    204: { description: 'Deleted.' },
    404: {
      description: 'Not found or not owned.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    ...standardErrorResponses,
  },
});
