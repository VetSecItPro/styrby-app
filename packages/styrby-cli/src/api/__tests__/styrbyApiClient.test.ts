/**
 * Unit tests for StyrbyApiClient (Strategy C — Phase 3).
 *
 * WHY fetchImpl injection (not global vi.fn() of fetch): the client accepts
 * a `fetchImpl` config field exactly so tests can substitute a deterministic
 * mock without leaking into other suites that might use real fetch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_BASE_URL,
  StyrbyApiClient,
  StyrbyApiError,
} from '../styrbyApiClient.js';

// Sentry is initialised in src/index.ts on the real CLI path. Tests should
// never reach a real Sentry transport; mock the entire module to assert
// breadcrumbs without network traffic.
vi.mock('@sentry/node', () => ({
  addBreadcrumb: vi.fn(),
}));

import * as Sentry from '@sentry/node';

// Helpers ---------------------------------------------------------------------

interface MockResponseInit {
  status?: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

function mockJson(init: MockResponseInit = {}): Response {
  const status = init.status ?? 200;
  const body = init.body !== undefined ? JSON.stringify(init.body) : init.text ?? '';
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function makeFetch(responses: Array<MockResponseInit | Error>): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fakeFetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    const next = responses[i++];
    if (next === undefined) {
      throw new Error(`makeFetch: no more responses queued at call ${i}`);
    }
    if (next instanceof Error) {
      throw next;
    }
    return mockJson(next);
  }) as typeof fetch;
  return { fetch: fakeFetch, calls };
}

// Tests -----------------------------------------------------------------------

describe('StyrbyApiClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor + URL handling', () => {
    it('defaults to production base URL', () => {
      const client = new StyrbyApiClient({ apiKey: 'sk_test' });
      // Indirect: a request goes to the prod URL.
      const { fetch: fakeFetch, calls } = makeFetch([{ status: 200, body: { ok: true } }]);
      // Need a fresh client wired with the fake fetch to inspect URL.
      const c2 = new StyrbyApiClient({ apiKey: 'sk_test', fetchImpl: fakeFetch });
      return c2.otpSend({ email: 'a@b.com' }).then(() => {
        expect(calls[0].url.startsWith(DEFAULT_BASE_URL)).toBe(true);
        // Quiets unused warning on first client.
        expect(client).toBeInstanceOf(StyrbyApiClient);
      });
    });

    it('strips trailing slash from baseUrl', async () => {
      const { fetch: fakeFetch, calls } = makeFetch([{ status: 200, body: { ok: true } }]);
      const c = new StyrbyApiClient({ baseUrl: 'https://example.com/', fetchImpl: fakeFetch });
      await c.otpSend({ email: 'a@b.com' });
      expect(calls[0].url).toBe('https://example.com/api/v1/auth/otp/send');
    });

    it('encodes path segments with special characters', async () => {
      const { fetch: fakeFetch, calls } = makeFetch([{ status: 200, body: { session: {} } }]);
      const c = new StyrbyApiClient({ apiKey: 'sk_test', fetchImpl: fakeFetch });
      await c.getSession('id with space/and-slash');
      expect(calls[0].url).toContain('id%20with%20space%2Fand-slash');
    });

    it('appends defined query params and skips undefined ones', async () => {
      const { fetch: fakeFetch, calls } = makeFetch([{ status: 200, body: { sessions: [], pagination: { total: 0, limit: 20, offset: 0, hasMore: false } } }]);
      const c = new StyrbyApiClient({ apiKey: 'sk_test', fetchImpl: fakeFetch });
      await c.listSessions({ limit: 50, status: 'running' });
      const url = new URL(calls[0].url);
      expect(url.searchParams.get('limit')).toBe('50');
      expect(url.searchParams.get('status')).toBe('running');
      expect(url.searchParams.has('agent_type')).toBe(false);
      expect(url.searchParams.has('archived')).toBe(false);
    });
  });

  describe('headers', () => {
    it('attaches Authorization on authenticated calls', async () => {
      const { fetch: fakeFetch, calls } = makeFetch([{ status: 200, body: { count: 0, machines: [] } }]);
      const c = new StyrbyApiClient({ apiKey: 'styrby_abc', fetchImpl: fakeFetch });
      await c.listMachines();
      const headers = calls[0].init.headers as Headers;
      expect(headers.get('Authorization')).toBe('Bearer styrby_abc');
    });

    it('throws clearly when an authenticated call has no apiKey', async () => {
      const c = new StyrbyApiClient({ fetchImpl: makeFetch([]).fetch });
      await expect(c.listMachines()).rejects.toThrow(/apiKey is required/);
    });

    it('omits Authorization on auth bootstrap calls', async () => {
      const { fetch: fakeFetch, calls } = makeFetch([{ status: 200, body: { ok: true } }]);
      const c = new StyrbyApiClient({ fetchImpl: fakeFetch });
      await c.otpSend({ email: 'a@b.com' });
      const headers = calls[0].init.headers as Headers;
      expect(headers.has('Authorization')).toBe(false);
    });

    it('attaches Idempotency-Key when supplied', async () => {
      const { fetch: fakeFetch, calls } = makeFetch([{ status: 201, body: { id: 't1', name: 'n', created_at: 't' } }]);
      const c = new StyrbyApiClient({ apiKey: 'sk', fetchImpl: fakeFetch });
      await c.createTemplate({ name: 'n', content: 'c' }, { idempotencyKey: 'key-123' });
      const headers = calls[0].init.headers as Headers;
      expect(headers.get('Idempotency-Key')).toBe('key-123');
    });
  });

  describe('error handling', () => {
    it('throws StyrbyApiError with status + parsed message on 4xx', async () => {
      const { fetch: fakeFetch } = makeFetch([{ status: 400, body: { error: 'name is required' } }]);
      const c = new StyrbyApiClient({ apiKey: 'sk', fetchImpl: fakeFetch, maxAttempts: 1 });
      const err = await c.createTemplate({ name: '', content: 'c' }).catch((e) => e);
      expect(err).toBeInstanceOf(StyrbyApiError);
      expect(err.status).toBe(400);
      expect(err.message).toBe('name is required');
      expect(err.code).toBeUndefined();
    });

    it('parses { error: CODE, message: text } shape into code + message', async () => {
      const { fetch: fakeFetch } = makeFetch([
        { status: 400, body: { error: 'VALIDATION_ERROR', message: 'provider must be github or google' } },
      ]);
      const c = new StyrbyApiClient({ fetchImpl: fakeFetch, maxAttempts: 1 });
      const err = await c.oauthStart({ provider: 'github', redirect_to: 'http://x' }).catch((e) => e);
      expect(err.code).toBe('VALIDATION_ERROR');
      expect(err.message).toBe('provider must be github or google');
    });

    it('treats short ALL_CAPS error as code when no message field present', async () => {
      const { fetch: fakeFetch } = makeFetch([{ status: 401, body: { error: 'AUTH_FAILED' } }]);
      const c = new StyrbyApiClient({ fetchImpl: fakeFetch, maxAttempts: 1 });
      const err = await c.otpVerify({ email: 'a@b.com', otp: '000000' }).catch((e) => e);
      expect(err.code).toBe('AUTH_FAILED');
      expect(err.status).toBe(401);
    });

    it('uses status 0 for transport failures', async () => {
      const { fetch: fakeFetch } = makeFetch([new TypeError('fetch failed')]);
      const c = new StyrbyApiClient({ apiKey: 'sk', fetchImpl: fakeFetch, maxAttempts: 1 });
      const err = await c.listMachines().catch((e) => e);
      expect(err).toBeInstanceOf(StyrbyApiError);
      expect(err.status).toBe(0);
    });
  });

  describe('retry policy', () => {
    it('retries 5xx on retryable verbs and eventually returns success', async () => {
      const { fetch: fakeFetch } = makeFetch([
        { status: 503, body: { error: 'Service Unavailable' } },
        { status: 503, body: { error: 'Service Unavailable' } },
        { status: 200, body: { count: 0, machines: [] } },
      ]);
      const c = new StyrbyApiClient({
        apiKey: 'sk',
        fetchImpl: fakeFetch,
        maxAttempts: 3,
        // Speed up backoff so the test stays fast.
        timeoutMs: 5_000,
      });
      // Force backoff to ~0ms by patching sleep via setTimeout shim.
      vi.useFakeTimers();
      const promise = c.listMachines();
      await vi.runAllTimersAsync();
      const result = await promise;
      expect(result.count).toBe(0);
    });

    it('does NOT retry single-use auth verbs (oauthCallback)', async () => {
      const { fetch: fakeFetch, calls } = makeFetch([
        { status: 503, body: { error: 'INTERNAL_ERROR' } },
      ]);
      const c = new StyrbyApiClient({ fetchImpl: fakeFetch, maxAttempts: 3 });
      await expect(c.oauthCallback({ code: 'x', state: 'y' })).rejects.toBeInstanceOf(StyrbyApiError);
      expect(calls).toHaveLength(1);
    });

    it('does NOT retry POST without Idempotency-Key', async () => {
      const { fetch: fakeFetch, calls } = makeFetch([
        { status: 503, body: { error: 'transient' } },
      ]);
      const c = new StyrbyApiClient({ apiKey: 'sk', fetchImpl: fakeFetch, maxAttempts: 3 });
      await expect(c.writeAuditEvent({ action: 'x' })).rejects.toBeInstanceOf(StyrbyApiError);
      expect(calls).toHaveLength(1);
    });

    it('DOES retry POST when Idempotency-Key is provided', async () => {
      const { fetch: fakeFetch, calls } = makeFetch([
        { status: 503, body: { error: 'transient' } },
        { status: 201, body: { id: 'a', created_at: 't' } },
      ]);
      const c = new StyrbyApiClient({ apiKey: 'sk', fetchImpl: fakeFetch, maxAttempts: 3 });
      vi.useFakeTimers();
      const promise = c.writeAuditEvent({ action: 'x' }, { idempotencyKey: 'k1' });
      await vi.runAllTimersAsync();
      const result = await promise;
      expect(calls).toHaveLength(2);
      expect(result.id).toBe('a');
    });

    it('does NOT retry 4xx (client errors are not transient)', async () => {
      const { fetch: fakeFetch, calls } = makeFetch([
        { status: 400, body: { error: 'name is required' } },
      ]);
      const c = new StyrbyApiClient({ apiKey: 'sk', fetchImpl: fakeFetch, maxAttempts: 3 });
      await expect(c.listMachines()).rejects.toBeInstanceOf(StyrbyApiError);
      expect(calls).toHaveLength(1);
    });
  });

  describe('upsertContext', () => {
    it('reports inserted=true on 201, false on 200', async () => {
      const { fetch: fakeFetch } = makeFetch([
        { status: 201, body: { id: 'x', session_group_id: 'g', version: 1, created_at: 't', updated_at: 't' } },
      ]);
      const c1 = new StyrbyApiClient({ apiKey: 'sk', fetchImpl: fakeFetch });
      const r1 = await c1.upsertContext({ session_group_id: 'g', summary_markdown: 'm' });
      expect(r1.inserted).toBe(true);
      expect(r1.version).toBe(1);

      const { fetch: fakeFetch2 } = makeFetch([
        { status: 200, body: { id: 'x', session_group_id: 'g', version: 2, created_at: 't', updated_at: 't' } },
      ]);
      const c2 = new StyrbyApiClient({ apiKey: 'sk', fetchImpl: fakeFetch2 });
      const r2 = await c2.upsertContext({ session_group_id: 'g', summary_markdown: 'm' });
      expect(r2.inserted).toBe(false);
      expect(r2.version).toBe(2);
    });
  });

  describe('exportCostsCsv', () => {
    it('returns CSV body as text', async () => {
      const csv = 'date,cost\n2026-04-30,1.23\n';
      const fakeFetch = (async () => new Response(csv, { status: 200, headers: { 'content-type': 'text/csv' } })) as typeof fetch;
      const c = new StyrbyApiClient({ apiKey: 'sk', fetchImpl: fakeFetch });
      const result = await c.exportCostsCsv({ period: 'month' });
      expect(result).toBe(csv);
    });
  });

  describe('withApiKey', () => {
    it('returns a new client carrying the new key but same baseUrl/fetchImpl', async () => {
      const { fetch: fakeFetch, calls } = makeFetch([{ status: 200, body: { count: 0, machines: [] } }]);
      const original = new StyrbyApiClient({ baseUrl: 'https://x.test', fetchImpl: fakeFetch });
      const upgraded = original.withApiKey('styrby_minted');
      await upgraded.listMachines();
      expect(calls[0].url.startsWith('https://x.test')).toBe(true);
      expect((calls[0].init.headers as Headers).get('Authorization')).toBe('Bearer styrby_minted');
    });
  });

  describe('observability', () => {
    it('emits a Sentry breadcrumb on success with status + outcome', async () => {
      const { fetch: fakeFetch } = makeFetch([{ status: 200, body: { count: 0, machines: [] } }]);
      const c = new StyrbyApiClient({ apiKey: 'sk', fetchImpl: fakeFetch });
      await c.listMachines();
      expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'styrby-api',
          message: 'GET /api/v1/machines',
          level: 'info',
          data: expect.objectContaining({ status: 200, outcome: 'ok', attempt: 1 }),
        }),
      );
    });

    it('emits a warning breadcrumb on error', async () => {
      const { fetch: fakeFetch } = makeFetch([{ status: 401, body: { error: 'AUTH_FAILED' } }]);
      const c = new StyrbyApiClient({ apiKey: 'sk', fetchImpl: fakeFetch, maxAttempts: 1 });
      await c.listMachines().catch(() => undefined);
      expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'warning',
          data: expect.objectContaining({ outcome: 'error', status: 401 }),
        }),
      );
    });
  });

  describe('registerMachine', () => {
    it('returns isNew=true on 201, false on 200', async () => {
      const { fetch: fakeFetch } = makeFetch([
        { status: 201, body: { machine_id: 'm1', name: 'mac', is_new: true, created_at: 't' } },
      ]);
      const c1 = new StyrbyApiClient({ apiKey: 'sk', fetchImpl: fakeFetch });
      const r1 = await c1.registerMachine({ machine_fingerprint: '0123456789abcdef', name: 'mac' });
      expect(r1.isNew).toBe(true);
      expect(r1.is_new).toBe(true);
      expect(r1.machine_id).toBe('m1');

      const { fetch: fakeFetch2 } = makeFetch([
        { status: 200, body: { machine_id: 'm1', name: 'mac', is_new: false, created_at: 't' } },
      ]);
      const c2 = new StyrbyApiClient({ apiKey: 'sk', fetchImpl: fakeFetch2 });
      const r2 = await c2.registerMachine({ machine_fingerprint: '0123456789abcdef', name: 'mac' });
      expect(r2.isNew).toBe(false);
      expect(r2.is_new).toBe(false);
    });

    it('forwards Idempotency-Key when supplied', async () => {
      const { fetch: fakeFetch, calls } = makeFetch([
        { status: 201, body: { machine_id: 'm1', name: 'mac', is_new: true, created_at: 't' } },
      ]);
      const c = new StyrbyApiClient({ apiKey: 'sk', fetchImpl: fakeFetch });
      await c.registerMachine(
        { machine_fingerprint: '0123456789abcdef', name: 'mac' },
        { idempotencyKey: 'reg-1' },
      );
      const headers = calls[0].init.headers as Headers;
      expect(headers.get('Idempotency-Key')).toBe('reg-1');
    });

    it('does NOT retry POST without Idempotency-Key (preserves singular registration)', async () => {
      const { fetch: fakeFetch, calls } = makeFetch([{ status: 503, body: { error: 'transient' } }]);
      const c = new StyrbyApiClient({ apiKey: 'sk', fetchImpl: fakeFetch, maxAttempts: 3 });
      await expect(
        c.registerMachine({ machine_fingerprint: '0123456789abcdef', name: 'mac' }),
      ).rejects.toBeInstanceOf(StyrbyApiError);
      expect(calls).toHaveLength(1);
    });
  });

  describe('createSessionGroup', () => {
    it('posts to /api/v1/sessions/groups with optional name', async () => {
      const { fetch: fakeFetch, calls } = makeFetch([
        { status: 201, body: { group_id: 'g1', name: 'My Group', created_at: 't' } },
      ]);
      const c = new StyrbyApiClient({ apiKey: 'sk', fetchImpl: fakeFetch });
      const r = await c.createSessionGroup({ name: 'My Group' });
      expect(r.group_id).toBe('g1');
      expect(calls[0].url).toContain('/api/v1/sessions/groups');
      expect(calls[0].init.method).toBe('POST');
      expect(JSON.parse(calls[0].init.body as string)).toEqual({ name: 'My Group' });
    });

    it('accepts an empty input (server defaults name to empty string)', async () => {
      const { fetch: fakeFetch, calls } = makeFetch([
        { status: 201, body: { group_id: 'g1', name: '', created_at: 't' } },
      ]);
      const c = new StyrbyApiClient({ apiKey: 'sk', fetchImpl: fakeFetch });
      const r = await c.createSessionGroup();
      expect(r.name).toBe('');
      expect(JSON.parse(calls[0].init.body as string)).toEqual({});
    });
  });

  describe('listTemplates', () => {
    it('returns the templates array and count', async () => {
      const { fetch: fakeFetch } = makeFetch([
        {
          status: 200,
          body: {
            templates: [
              {
                id: 't1',
                name: 'Default',
                description: null,
                content: 'hello {{var}}',
                variables: [],
                is_default: true,
                created_at: 't',
                updated_at: 't',
              },
            ],
            count: 1,
          },
        },
      ]);
      const c = new StyrbyApiClient({ apiKey: 'sk', fetchImpl: fakeFetch });
      const r = await c.listTemplates();
      expect(r.count).toBe(1);
      expect(r.templates[0].is_default).toBe(true);
    });
  });

  describe('getTemplate / updateTemplate / deleteTemplate', () => {
    it('GET /api/v1/templates/[id] returns the row', async () => {
      const row = {
        id: 't1', name: 'n', description: null, content: 'c',
        variables: [], is_default: false, created_at: 'ts', updated_at: 'ts',
      };
      const { fetch: fakeFetch, calls } = makeFetch([{ status: 200, body: { template: row } }]);
      const c = new StyrbyApiClient({ apiKey: 'sk', fetchImpl: fakeFetch });
      const r = await c.getTemplate('t1');
      expect(r.template.id).toBe('t1');
      expect(calls[0].url).toContain('/api/v1/templates/t1');
      expect(calls[0].init.method).toBe('GET');
    });

    it('PATCH sends only the supplied fields and forwards Idempotency-Key', async () => {
      const updated = { id: 't1', name: 'new', description: null, content: 'c', variables: [], is_default: false, created_at: 'ts', updated_at: 'ts2' };
      const { fetch: fakeFetch, calls } = makeFetch([{ status: 200, body: { template: updated } }]);
      const c = new StyrbyApiClient({ apiKey: 'sk', fetchImpl: fakeFetch });
      const r = await c.updateTemplate('t1', { name: 'new' }, { idempotencyKey: 'patch-1' });
      expect(r.template.name).toBe('new');
      expect(calls[0].init.method).toBe('PATCH');
      expect(JSON.parse(calls[0].init.body as string)).toEqual({ name: 'new' });
      expect((calls[0].init.headers as Headers).get('Idempotency-Key')).toBe('patch-1');
    });

    it('DELETE returns deleted+id', async () => {
      const { fetch: fakeFetch, calls } = makeFetch([{ status: 200, body: { deleted: true, id: 't1' } }]);
      const c = new StyrbyApiClient({ apiKey: 'sk', fetchImpl: fakeFetch });
      const r = await c.deleteTemplate('t1');
      expect(r.deleted).toBe(true);
      expect(r.id).toBe('t1');
      expect(calls[0].init.method).toBe('DELETE');
    });

    it('GET /api/v1/templates/[id] surfaces 404 as StyrbyApiError', async () => {
      const { fetch: fakeFetch } = makeFetch([{ status: 404, body: { error: 'Not found' } }]);
      const c = new StyrbyApiClient({ apiKey: 'sk', fetchImpl: fakeFetch, maxAttempts: 1 });
      const err = await c.getTemplate('t-missing').catch((e) => e);
      expect(err).toBeInstanceOf(StyrbyApiError);
      expect(err.status).toBe(404);
    });
  });

  describe('getContext', () => {
    it('GET /api/v1/contexts/[group] returns the row', async () => {
      const row = {
        id: 'c1', session_group_id: 'g1', summary_markdown: '...', file_refs: [],
        recent_messages: [], token_budget: 4000, version: 1, created_at: 'ts', updated_at: 'ts',
      };
      const { fetch: fakeFetch, calls } = makeFetch([{ status: 200, body: { context: row } }]);
      const c = new StyrbyApiClient({ apiKey: 'sk', fetchImpl: fakeFetch });
      const r = await c.getContext('g1');
      expect(r.context.version).toBe(1);
      expect(calls[0].url).toContain('/api/v1/contexts/g1');
    });
  });

  describe('listSessionGroups', () => {
    it('GET /api/v1/sessions/groups returns groups + count', async () => {
      const groups = [
        { id: 'g1', name: 'A', active_agent_session_id: null, created_at: 't', updated_at: 't' },
      ];
      const { fetch: fakeFetch } = makeFetch([{ status: 200, body: { groups, count: 1 } }]);
      const c = new StyrbyApiClient({ apiKey: 'sk', fetchImpl: fakeFetch });
      const r = await c.listSessionGroups();
      expect(r.count).toBe(1);
      expect(r.groups[0].id).toBe('g1');
    });
  });

  describe('searchAuditLog', () => {
    it('forwards filters as query params', async () => {
      const { fetch: fakeFetch, calls } = makeFetch([{ status: 200, body: { events: [], count: 0 } }]);
      const c = new StyrbyApiClient({ apiKey: 'sk', fetchImpl: fakeFetch });
      await c.searchAuditLog({
        action: 'mcp_approval_decided',
        resource_id: '00000000-0000-0000-0000-000000000001',
        limit: 10,
      });
      const url = new URL(calls[0].url);
      expect(url.searchParams.get('action')).toBe('mcp_approval_decided');
      expect(url.searchParams.get('resource_id')).toBe('00000000-0000-0000-0000-000000000001');
      expect(url.searchParams.get('limit')).toBe('10');
      expect(url.searchParams.has('resource_type')).toBe(false);
      expect(url.searchParams.has('since')).toBe(false);
    });

    it('returns events array', async () => {
      const events = [
        { id: 'e1', action: 'mcp_approval_decided', resource_type: 'mcp_approval',
          resource_id: 'a1', metadata: {}, created_at: 't' },
      ];
      const { fetch: fakeFetch } = makeFetch([{ status: 200, body: { events, count: 1 } }]);
      const c = new StyrbyApiClient({ apiKey: 'sk', fetchImpl: fakeFetch });
      const r = await c.searchAuditLog({ action: 'mcp_approval_decided' });
      expect(r.count).toBe(1);
      expect(r.events[0].id).toBe('e1');
    });
  });

  describe('exchangeSupabaseJwt', () => {
    it('POSTs to /api/v1/auth/exchange with Bearer Supabase JWT and returns mint result', async () => {
      const { fetch: fakeFetch, calls } = makeFetch([
        { status: 200, body: { styrby_api_key: 'styrby_minted_xyz', expires_at: '2027-04-30T00:00:00Z', user_id: 'u-1' } },
      ]);
      const c = new StyrbyApiClient({ fetchImpl: fakeFetch });
      const r = await c.exchangeSupabaseJwt('eyJ.fake.supabase.jwt');
      expect(r.styrby_api_key).toBe('styrby_minted_xyz');
      expect(r.user_id).toBe('u-1');
      expect(calls[0].url).toContain('/api/v1/auth/exchange');
      expect(calls[0].init.method).toBe('POST');
      const headers = calls[0].init.headers as Headers;
      expect(headers.get('Authorization')).toBe('Bearer eyJ.fake.supabase.jwt');
    });

    it('surfaces 401 AUTH_FAILED as StyrbyApiError', async () => {
      const { fetch: fakeFetch } = makeFetch([{ status: 401, body: { error: 'AUTH_FAILED' } }]);
      const c = new StyrbyApiClient({ fetchImpl: fakeFetch });
      const err = await c.exchangeSupabaseJwt('expired-jwt').catch((e) => e);
      expect(err).toBeInstanceOf(StyrbyApiError);
      expect(err.status).toBe(401);
      expect(err.code).toBe('AUTH_FAILED');
    });

    it('does NOT attach a styrby_* Bearer header when one is configured (only Supabase JWT)', async () => {
      // Even if a previously-minted styrby_* key exists in this client, the
      // exchange endpoint expects the SUPABASE JWT — we must not overwrite it.
      const { fetch: fakeFetch, calls } = makeFetch([
        { status: 200, body: { styrby_api_key: 'styrby_new', expires_at: 't', user_id: 'u' } },
      ]);
      const c = new StyrbyApiClient({ apiKey: 'styrby_old', fetchImpl: fakeFetch });
      await c.exchangeSupabaseJwt('supabase-jwt');
      const headers = calls[0].init.headers as Headers;
      expect(headers.get('Authorization')).toBe('Bearer supabase-jwt');
      // Sanity: the client's own styrby_* key was NOT used as Bearer here.
      expect(headers.get('Authorization')).not.toContain('styrby_old');
    });
  });

  describe('updateSession', () => {
    it('PATCHes /api/v1/sessions/[id] with body and returns the updated row', async () => {
      const { fetch: fakeFetch, calls } = makeFetch([
        {
          status: 200,
          body: { id: 's-1', session_group_id: 'g-1', updated_at: '2026-04-30T00:00:00Z' },
        },
      ]);
      const c = new StyrbyApiClient({ apiKey: 'sk', fetchImpl: fakeFetch });
      const r = await c.updateSession('s-1', { session_group_id: 'g-1' });

      expect(r.id).toBe('s-1');
      expect(r.session_group_id).toBe('g-1');
      expect(calls[0].init.method).toBe('PATCH');
      expect(calls[0].url).toContain('/api/v1/sessions/s-1');
      expect(calls[0].init.body).toBe(JSON.stringify({ session_group_id: 'g-1' }));
    });

    it('passes null session_group_id (detach) through to the server', async () => {
      const { fetch: fakeFetch, calls } = makeFetch([
        {
          status: 200,
          body: { id: 's-1', session_group_id: null, updated_at: '2026-04-30T00:00:00Z' },
        },
      ]);
      const c = new StyrbyApiClient({ apiKey: 'sk', fetchImpl: fakeFetch });
      const r = await c.updateSession('s-1', { session_group_id: null });

      expect(r.session_group_id).toBeNull();
      expect(calls[0].init.body).toBe(JSON.stringify({ session_group_id: null }));
    });

    it('attaches Idempotency-Key when supplied', async () => {
      const { fetch: fakeFetch, calls } = makeFetch([
        { status: 200, body: { id: 's', session_group_id: null, updated_at: 't' } },
      ]);
      const c = new StyrbyApiClient({ apiKey: 'sk', fetchImpl: fakeFetch });
      await c.updateSession('s', { session_group_id: null }, { idempotencyKey: 'idem-up-1' });
      const headers = calls[0].init.headers as Headers;
      expect(headers.get('Idempotency-Key')).toBe('idem-up-1');
    });
  });

  describe('getNotificationPreferences', () => {
    it('GETs /api/v1/notification_preferences and returns the preferences row', async () => {
      const row = {
        id: 'p-1',
        push_enabled: true,
        push_permission_requests: true,
        push_session_errors: true,
        push_budget_alerts: true,
        push_session_complete: false,
        email_enabled: true,
        email_weekly_summary: true,
        email_budget_alerts: true,
        quiet_hours_enabled: false,
        quiet_hours_start: null,
        quiet_hours_end: null,
        quiet_hours_timezone: 'UTC',
        priority_threshold: 3,
        priority_rules: [],
        push_agent_finished: true,
        push_budget_threshold: true,
        push_weekly_summary: true,
        weekly_digest_email: true,
        push_predictive_alert: true,
        created_at: 't',
        updated_at: 't',
      };
      const { fetch: fakeFetch, calls } = makeFetch([
        { status: 200, body: { preferences: row } },
      ]);
      const c = new StyrbyApiClient({ apiKey: 'sk', fetchImpl: fakeFetch });
      const r = await c.getNotificationPreferences();

      expect(r.preferences).toBeDefined();
      expect(r.preferences?.push_enabled).toBe(true);
      expect(r.preferences?.priority_threshold).toBe(3);
      expect(calls[0].init.method).toBe('GET');
      expect(calls[0].url).toContain('/api/v1/notification_preferences');
    });

    it('returns preferences=null when the row has not been created yet', async () => {
      const { fetch: fakeFetch } = makeFetch([
        { status: 200, body: { preferences: null } },
      ]);
      const c = new StyrbyApiClient({ apiKey: 'sk', fetchImpl: fakeFetch });
      const r = await c.getNotificationPreferences();

      expect(r.preferences).toBeNull();
    });
  });

  describe('recordCost', () => {
    it('POSTs /api/v1/cost-records with body and returns { id, recorded_at }', async () => {
      const { fetch: fakeFetch, calls } = makeFetch([
        {
          status: 201,
          body: { id: 'c-1', recorded_at: '2026-04-30T12:00:00Z' },
        },
      ]);
      const c = new StyrbyApiClient({ apiKey: 'sk', fetchImpl: fakeFetch });
      const r = await c.recordCost({
        session_id: '00000000-0000-0000-0000-000000000001',
        agent_type: 'claude',
        model: 'claude-sonnet-4',
        input_tokens: 1000,
        output_tokens: 500,
        cost_usd: 0.125,
      });

      expect(r.id).toBe('c-1');
      expect(r.recorded_at).toBe('2026-04-30T12:00:00Z');
      expect(calls[0].init.method).toBe('POST');
      expect(calls[0].url).toContain('/api/v1/cost-records');
    });

    it('attaches Idempotency-Key when supplied', async () => {
      const { fetch: fakeFetch, calls } = makeFetch([
        { status: 201, body: { id: 'c-2', recorded_at: 't' } },
      ]);
      const c = new StyrbyApiClient({ apiKey: 'sk', fetchImpl: fakeFetch });
      await c.recordCost(
        {
          session_id: '00000000-0000-0000-0000-000000000001',
          agent_type: 'claude',
          model: 'claude-sonnet-4',
          input_tokens: 100,
          output_tokens: 50,
          cost_usd: 0.01,
        },
        { idempotencyKey: 'idem-cost-1' },
      );
      const headers = calls[0].init.headers as Headers;
      expect(headers.get('Idempotency-Key')).toBe('idem-cost-1');
    });

    it('surfaces 404 (cross-user session) as StyrbyApiError', async () => {
      const { fetch: fakeFetch } = makeFetch([
        { status: 404, body: { error: 'Not found' } },
      ]);
      const c = new StyrbyApiClient({ apiKey: 'sk', fetchImpl: fakeFetch, maxAttempts: 1 });
      const err = await c
        .recordCost({
          session_id: '00000000-0000-0000-0000-000000000001',
          agent_type: 'claude',
          model: 'claude-sonnet-4',
          input_tokens: 1,
          output_tokens: 1,
          cost_usd: 0,
        })
        .catch((e) => e);

      expect(err).toBeInstanceOf(StyrbyApiError);
      expect(err.status).toBe(404);
    });
  });

  describe('deleteSessionCheckpoint', () => {
    it('throws synchronously when neither name nor checkpointId is provided', async () => {
      const c = new StyrbyApiClient({ apiKey: 'sk', fetchImpl: makeFetch([]).fetch });
      await expect(c.deleteSessionCheckpoint('s1', {})).rejects.toThrow(/name or checkpointId/);
    });

    it('passes the selector as a query param', async () => {
      const { fetch: fakeFetch, calls } = makeFetch([{ status: 200, body: { deleted: true } }]);
      const c = new StyrbyApiClient({ apiKey: 'sk', fetchImpl: fakeFetch });
      await c.deleteSessionCheckpoint('s1', { name: 'before-merge' });
      const url = new URL(calls[0].url);
      expect(url.searchParams.get('name')).toBe('before-merge');
      expect(calls[0].init.method).toBe('DELETE');
    });
  });
});
