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
