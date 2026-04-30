/**
 * Styrby API Client (Strategy C — Phase 3)
 *
 * Typed HTTP client for `/api/v1/*` endpoints. The CLI uses this in place of
 * direct Supabase Postgres access. Auth is per-user `styrby_*` API key in the
 * `Authorization: Bearer` header — no project anon key embedded.
 *
 * WHY a class wrapper (not raw fetch in callsites):
 *  - Single retry/backoff policy applied uniformly across idempotent verbs
 *  - Single `apiKey` source — no chance of leaking via misplaced fetch calls
 *  - Single error type (`StyrbyApiError`) so callers do one catch shape
 *  - Single observability hook — every call leaves a Sentry breadcrumb
 *  - Type-safe per-method signatures matching the route contracts
 *
 * Auth methods (`oauthStart`, `oauthCallback`, `otpSend`, `otpVerify`) are the
 * bootstrap path — they do NOT require an API key. Every other method does.
 *
 * @module api/styrbyApiClient
 */

import * as Sentry from '@sentry/node';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Production base URL for `/api/v1/*`. Callers override via constructor for
 * sandbox / local-dev. Trailing slash is intentionally absent — paths are
 * appended with a leading slash.
 */
export const DEFAULT_BASE_URL = 'https://styrbyapp.com';

/**
 * Maximum retry attempts for retryable errors (5xx, network). The first call
 * counts as attempt 1; total retries = MAX_ATTEMPTS - 1. WHY 3: covers a single
 * transient blip without amplifying load on a degraded server.
 */
const MAX_ATTEMPTS = 3;

/**
 * Base backoff in milliseconds. Each retry waits `BASE_BACKOFF_MS * 2^(attempt-1)`
 * — 250ms, 500ms, 1000ms — capped at MAX_BACKOFF_MS.
 */
const BASE_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 5_000;

/**
 * Per-request timeout. Beyond this, the AbortController fires and we treat the
 * call as a network failure. WHY 30s: matches typical Vercel function timeout
 * for /api/v1 routes; covers cold starts without holding the daemon indefinitely.
 */
const REQUEST_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by every `StyrbyApiClient` method on non-2xx responses or transport
 * failures. Carries the HTTP status (0 for network/timeout) plus the parsed
 * error payload so callers can branch on `status` and `code`.
 */
export class StyrbyApiError extends Error {
  /**
   * HTTP status. `0` indicates a transport-level failure (network, timeout,
   * abort) where no response was received. WHY 0: lets callers `if (err.status === 0)`
   * to distinguish "server said no" from "we never reached the server".
   */
  readonly status: number;

  /**
   * Server-provided error code when present (e.g. `'AUTH_FAILED'`,
   * `'RATE_LIMITED'`, `'VALIDATION_ERROR'`). Undefined for transport failures
   * or endpoints that return only `{ error: string }`.
   */
  readonly code?: string;

  /**
   * Optional `retryAfter` seconds from the server, surfaced verbatim from
   * 429 responses. Callers can use this to schedule a respectful retry.
   */
  readonly retryAfter?: number;

  /** Raw response body for debugging. Never logged automatically. */
  readonly body?: unknown;

  constructor(status: number, message: string, opts?: { code?: string; retryAfter?: number; body?: unknown }) {
    super(message);
    this.name = 'StyrbyApiError';
    this.status = status;
    this.code = opts?.code;
    this.retryAfter = opts?.retryAfter;
    this.body = opts?.body;
  }
}

// ---------------------------------------------------------------------------
// Public response types — mirror /api/v1 route contracts
// ---------------------------------------------------------------------------

export interface AuthOAuthStartResponse {
  authorization_url: string;
  state: string;
}

export interface AuthCredentialResponse {
  styrby_api_key: string;
  expires_at: string;
}

export interface AccountResponse {
  user_id: string;
  email: string;
  tier: string;
  created_at: string;
  mfa_enrolled: boolean;
  key_expires_at: string | null;
}

export interface AuditEventInput {
  action: string;
  resource_type?: string;
  resource_id?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditEventResponse {
  id: string;
  created_at: string;
}

export interface BroadcastInput {
  channel: string;
  event: string;
  payload: Record<string, unknown>;
}

export interface BroadcastResponse {
  delivered: boolean;
}

export interface ContextFileRef {
  path: string;
  lastTouchedAt: string;
  relevance: number;
}

export interface ContextRecentMessage {
  role: string;
  preview: string;
}

export interface ContextUpsertInput {
  session_group_id: string;
  summary_markdown: string;
  file_refs?: ContextFileRef[];
  recent_messages?: ContextRecentMessage[];
  token_budget?: number;
}

export interface ContextUpsertResponse {
  id: string;
  session_group_id: string;
  version: number;
  created_at: string;
  updated_at: string;
  /** True when the upsert created a new row (HTTP 201), false on update (HTTP 200). */
  inserted: boolean;
}

export interface TemplateVariable {
  name: string;
  description?: string;
  defaultValue?: string;
}

export interface TemplateCreateInput {
  name: string;
  content: string;
  description?: string;
  variables?: TemplateVariable[];
  is_default?: boolean;
}

export interface TemplateCreateResponse {
  id: string;
  name: string;
  created_at: string;
}

export interface MachineSummary {
  id: string;
  name: string;
  platform: string;
  platformVersion: string;
  architecture: string;
  hostname: string;
  cliVersion: string;
  isOnline: boolean;
  lastSeenAt: string;
  createdAt: string;
}

export interface MachinesResponse {
  machines: MachineSummary[];
  count: number;
}

export interface MachineRegisterInput {
  machine_fingerprint: string;
  name: string;
  platform?: 'darwin' | 'linux' | 'win32';
  platform_version?: string;
  architecture?: 'arm64' | 'x64' | 'x86';
  hostname?: string;
  cli_version?: string;
}

export interface MachineRegisterResponse {
  machine_id: string;
  name: string;
  /** True when the row was newly inserted; false on re-pair (matched by
   * (user_id, machine_fingerprint) and updated). */
  is_new: boolean;
  created_at: string;
}

export interface SessionGroupCreateInput {
  /** Optional human label, max 255 chars. Defaults to '' on the server. */
  name?: string;
}

export interface SessionGroupCreateResponse {
  group_id: string;
  name: string;
  created_at: string;
}

export interface TemplateSummary {
  id: string;
  name: string;
  description: string | null;
  content: string;
  variables: unknown;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface TemplatesListResponse {
  templates: TemplateSummary[];
  count: number;
}

export interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  content: string;
  variables: unknown;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface TemplateUpdateInput {
  name?: string;
  content?: string;
  /** null clears, undefined leaves alone. */
  description?: string | null;
  variables?: TemplateVariable[];
  is_default?: boolean;
}

export interface ContextRow {
  id: string;
  session_group_id: string;
  summary_markdown: string;
  file_refs: unknown;
  recent_messages: unknown;
  token_budget: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface SessionGroupSummary {
  id: string;
  name: string;
  active_agent_session_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionGroupsListResponse {
  groups: SessionGroupSummary[];
  count: number;
}

export interface AuditSearchQuery {
  /** Required — single audit_action enum value to filter on. */
  action: string;
  resource_id?: string;
  resource_type?: string;
  /** 1-100, default 50. */
  limit?: number;
  /** ISO 8601 timestamp; only rows after this. */
  since?: string;
}

export interface AuditEventRow {
  id: string;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  metadata: unknown;
  created_at: string;
}

export interface AuditSearchResponse {
  events: AuditEventRow[];
  count: number;
}

export type SessionStatus = 'starting' | 'running' | 'idle' | 'paused' | 'stopped' | 'error' | 'expired';

export interface SessionListQuery {
  limit?: number;
  offset?: number;
  status?: SessionStatus;
  agent_type?: string;
  archived?: boolean;
}

export interface SessionSummary {
  id: string;
  /** Parent session group when the session is part of a multi-agent group; null otherwise. */
  session_group_id?: string | null;
  agent_type: string;
  model: string | null;
  title: string | null;
  summary: string | null;
  project_path: string | null;
  git_branch: string | null;
  tags: string[] | null;
  is_archived: boolean;
  status: SessionStatus;
  started_at: string | null;
  ended_at: string | null;
  last_activity_at: string | null;
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_tokens: number;
  message_count: number;
  created_at: string;
}

export interface Pagination {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface SessionListResponse {
  sessions: SessionSummary[];
  pagination: Pagination;
}

export interface SessionCheckpoint {
  id: string;
  session_id: string;
  name: string;
  message_index: number;
  notes?: string | null;
  created_at: string;
}

export interface CostsSummaryResponse {
  summary: {
    period: string;
    totalCostUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheTokens: number;
    sessionCount: number;
  };
  breakdown: Array<{
    date: string;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number;
  }>;
}

export interface CostsBreakdownResponse {
  breakdown: Array<{
    agentType: string;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number;
    sessionCount: number;
    percentage: number;
  }>;
  total: {
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number;
    sessionCount: number;
  };
}

// ---------------------------------------------------------------------------
// Client config + internal types
// ---------------------------------------------------------------------------

/**
 * Constructor options for `StyrbyApiClient`.
 *
 * `apiKey` is optional so the client can be used for the bootstrap auth flow
 * (oauthStart, otpSend, etc) before a key has been minted. After bootstrap,
 * pass the minted `styrby_*` key to a new client (or call `withApiKey`).
 */
export interface StyrbyApiClientConfig {
  /** Per-user `styrby_*` API key. Required for every method except auth bootstrap. */
  apiKey?: string;
  /** Override the base URL. Defaults to production `https://styrbyapp.com`. */
  baseUrl?: string;
  /** Inject an alternative fetch implementation (used in tests). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Override the default request timeout (ms). */
  timeoutMs?: number;
  /** Override the default max retry attempts. */
  maxAttempts?: number;
}

/**
 * Internal request descriptor. Verbs that mutate state (`POST`/`PATCH`/`DELETE`)
 * default to `retryable: false` unless the call is idempotency-keyed. Reads are
 * always retryable. Each method passes the right value explicitly.
 */
interface InternalRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /**
   * Whether transient failures (5xx, network) should be retried with backoff.
   * Strict default: only set to true for verbs that are server-side idempotent.
   */
  retryable: boolean;
  /** When true, omits the Authorization header (auth bootstrap calls). */
  unauthenticated?: boolean;
  /**
   * Optional Idempotency-Key value forwarded to the server. The server caches
   * the response for 24h, so retries return the same row without duplicating writes.
   */
  idempotencyKey?: string;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Typed HTTP client for the Styrby v1 API. Construct one per `apiKey` and
 * reuse across calls — instances are cheap, hold no sockets, and are safe
 * to share across the daemon's request lifetime.
 */
export class StyrbyApiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;

  constructor(config: StyrbyApiClientConfig = {}) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = config.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.maxAttempts = config.maxAttempts ?? MAX_ATTEMPTS;
  }

  /**
   * Returns a new client with the given API key, preserving baseUrl/fetchImpl.
   * WHY a fresh instance (not a setter): the apiKey is `readonly` to stop
   * a leaked client from being mutated post-creation. The bootstrap flow uses
   * this to upgrade an unauthenticated client into an authenticated one.
   */
  withApiKey(apiKey: string): StyrbyApiClient {
    return new StyrbyApiClient({
      apiKey,
      baseUrl: this.baseUrl,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      maxAttempts: this.maxAttempts,
    });
  }

  // -------------------------------------------------------------------------
  // Auth bootstrap (no API key required)
  // -------------------------------------------------------------------------

  oauthStart(input: { provider: 'github' | 'google'; redirect_to: string }): Promise<AuthOAuthStartResponse> {
    return this.request<AuthOAuthStartResponse>({
      method: 'POST',
      path: '/api/v1/auth/oauth/start',
      body: input,
      retryable: true,
      unauthenticated: true,
    });
  }

  oauthCallback(input: { code: string; state: string }): Promise<AuthCredentialResponse> {
    return this.request<AuthCredentialResponse>({
      method: 'POST',
      path: '/api/v1/auth/oauth/callback',
      body: input,
      // WHY not retryable: OAuth `code` is single-use. A retry after a 5xx that
      // actually consumed the code would 401 with AUTH_FAILED. Caller must
      // re-run the full flow on transient failures.
      retryable: false,
      unauthenticated: true,
    });
  }

  otpSend(input: { email: string }): Promise<{ ok: true }> {
    return this.request<{ ok: true }>({
      method: 'POST',
      path: '/api/v1/auth/otp/send',
      body: input,
      retryable: true,
      unauthenticated: true,
    });
  }

  otpVerify(input: { email: string; otp: string }): Promise<AuthCredentialResponse> {
    return this.request<AuthCredentialResponse>({
      method: 'POST',
      path: '/api/v1/auth/otp/verify',
      body: input,
      // WHY not retryable: OTP codes are single-use, like OAuth codes above.
      retryable: false,
      unauthenticated: true,
    });
  }

  /**
   * Exchange a valid Supabase Auth access token for a fresh `styrby_*` API key.
   *
   * Bridge endpoint introduced in H41 Phase 5: lets the existing CLI auth
   * bootstrap (which mints a Supabase JWT via `supabase.auth.signInWithOtp` /
   * `signInWithOAuth`) acquire a styrby_* key for use with /api/v1/* without
   * having to re-prompt the user. The Supabase JWT remains valid for Realtime
   * subscriptions until Phase 5b replaces that surface.
   *
   * The Supabase JWT is sent in the Authorization header (Bearer <jwt>); the
   * server validates it via `supabase.auth.getUser(jwt)` and mints a key
   * scoped to that user.
   *
   * WHY not retryable: minting is server-side idempotent in the sense that it
   * doesn't conflict on repeat (each call inserts a fresh row), but a retry
   * after a 5xx that succeeded would mint a SECOND key — wasteful and
   * confusing in the user's key list. Caller treats failures as terminal.
   */
  async exchangeSupabaseJwt(supabaseAccessToken: string): Promise<AuthCredentialResponse & { user_id: string }> {
    // The exchange endpoint is unauthenticated wrt our styrby_* key (caller
    // doesn't have one yet), but it DOES require the Supabase JWT in the
    // Authorization header. We fall outside the standard request() helper's
    // header builder because that helper attaches `Bearer <styrby_*>` instead.
    const url = this.buildUrl('/api/v1/auth/exchange');
    const headers = new Headers();
    headers.set('Accept', 'application/json');
    headers.set('Authorization', `Bearer ${supabaseAccessToken}`);

    const response = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers,
    });

    if (!response.ok) {
      const body = await this.safeReadJson(response);
      this.breadcrumb(
        { method: 'POST', path: '/api/v1/auth/exchange', retryable: false, unauthenticated: true },
        response.status,
        1,
        'error',
      );
      throw this.errorFromResponse(response.status, body);
    }

    const body = (await this.safeReadJson(response)) as AuthCredentialResponse & { user_id: string };
    this.breadcrumb(
      { method: 'POST', path: '/api/v1/auth/exchange', retryable: false, unauthenticated: true },
      response.status,
      1,
      'ok',
    );
    return body;
  }

  // -------------------------------------------------------------------------
  // Account
  // -------------------------------------------------------------------------

  getAccount(): Promise<AccountResponse> {
    return this.request<AccountResponse>({
      method: 'GET',
      path: '/api/v1/account',
      retryable: true,
    });
  }

  // -------------------------------------------------------------------------
  // Audit log (high-volume; idempotency-keyed for safe retry)
  // -------------------------------------------------------------------------

  writeAuditEvent(event: AuditEventInput, opts?: { idempotencyKey?: string }): Promise<AuditEventResponse> {
    return this.request<AuditEventResponse>({
      method: 'POST',
      path: '/api/v1/audit',
      body: event,
      // WHY retryable=true only when an Idempotency-Key is supplied: without
      // the key, a retry after a 5xx that succeeded server-side would write
      // a duplicate row. With the key, the server replays the cached response.
      retryable: Boolean(opts?.idempotencyKey),
      idempotencyKey: opts?.idempotencyKey,
    });
  }

  // -------------------------------------------------------------------------
  // Broadcast (best-effort; never retried)
  // -------------------------------------------------------------------------

  broadcast(input: BroadcastInput): Promise<BroadcastResponse> {
    return this.request<BroadcastResponse>({
      method: 'POST',
      path: '/api/v1/broadcast',
      body: input,
      // WHY retryable=false: the server documents broadcast as best-effort.
      // delivered:false on a soft failure is NOT a 5xx — it's a successful
      // 200 response with the boolean flag. Real 5xx here means our process
      // failed, but mobile will catch up via poll, so retrying just adds load.
      retryable: false,
    });
  }

  // -------------------------------------------------------------------------
  // Context memory (idempotency-keyed; upsert returns 200 vs 201)
  // -------------------------------------------------------------------------

  async upsertContext(
    input: ContextUpsertInput,
    opts?: { idempotencyKey?: string },
  ): Promise<ContextUpsertResponse> {
    const { status, body } = await this.requestRaw<Omit<ContextUpsertResponse, 'inserted'>>({
      method: 'POST',
      path: '/api/v1/contexts',
      body: input,
      retryable: Boolean(opts?.idempotencyKey),
      idempotencyKey: opts?.idempotencyKey,
    });
    return { ...body, inserted: status === 201 };
  }

  // -------------------------------------------------------------------------
  // Templates
  // -------------------------------------------------------------------------

  createTemplate(
    input: TemplateCreateInput,
    opts?: { idempotencyKey?: string },
  ): Promise<TemplateCreateResponse> {
    return this.request<TemplateCreateResponse>({
      method: 'POST',
      path: '/api/v1/templates',
      body: input,
      retryable: Boolean(opts?.idempotencyKey),
      idempotencyKey: opts?.idempotencyKey,
    });
  }

  // -------------------------------------------------------------------------
  // Machines
  // -------------------------------------------------------------------------

  listMachines(): Promise<MachinesResponse> {
    return this.request<MachinesResponse>({
      method: 'GET',
      path: '/api/v1/machines',
      retryable: true,
    });
  }

  async registerMachine(
    input: MachineRegisterInput,
    opts?: { idempotencyKey?: string },
  ): Promise<MachineRegisterResponse & { isNew: boolean }> {
    // The server returns 201 on first registration, 200 on re-pair. We surface
    // both via the response body's is_new field; isNew is also derivable from
    // the HTTP status, so we expose both in case future callers want either.
    const { status, body } = await this.requestRaw<MachineRegisterResponse>({
      method: 'POST',
      path: '/api/v1/machines',
      body: input,
      // WHY retryable when keyed: machines.upsert is inherently idempotent on
      // (user_id, machine_fingerprint), and the idempotency middleware caches
      // the exact 201/200 response so retries don't see is_new flip mid-flight.
      retryable: Boolean(opts?.idempotencyKey),
      idempotencyKey: opts?.idempotencyKey,
    });
    return { ...body, isNew: status === 201 };
  }

  createSessionGroup(
    input: SessionGroupCreateInput = {},
    opts?: { idempotencyKey?: string },
  ): Promise<SessionGroupCreateResponse> {
    return this.request<SessionGroupCreateResponse>({
      method: 'POST',
      path: '/api/v1/sessions/groups',
      body: input,
      // WHY retryable only with key: bare retries would create duplicate
      // groups; with the key, the server replays the cached response.
      retryable: Boolean(opts?.idempotencyKey),
      idempotencyKey: opts?.idempotencyKey,
    });
  }

  listTemplates(): Promise<TemplatesListResponse> {
    return this.request<TemplatesListResponse>({
      method: 'GET',
      path: '/api/v1/templates',
      retryable: true,
    });
  }

  getTemplate(id: string): Promise<{ template: TemplateRow }> {
    return this.request<{ template: TemplateRow }>({
      method: 'GET',
      path: `/api/v1/templates/${encodeURIComponent(id)}`,
      retryable: true,
    });
  }

  updateTemplate(
    id: string,
    input: TemplateUpdateInput,
    opts?: { idempotencyKey?: string },
  ): Promise<{ template: TemplateRow }> {
    return this.request<{ template: TemplateRow }>({
      method: 'PATCH',
      path: `/api/v1/templates/${encodeURIComponent(id)}`,
      body: input,
      // WHY retryable only with key: PATCH is logically idempotent (same body =
      // same result), but a network retry between client and server might race
      // with another caller's PATCH. Idempotency-Key replays the cached response.
      retryable: Boolean(opts?.idempotencyKey),
      idempotencyKey: opts?.idempotencyKey,
    });
  }

  deleteTemplate(id: string): Promise<{ deleted: true; id: string }> {
    return this.request<{ deleted: true; id: string }>({
      method: 'DELETE',
      path: `/api/v1/templates/${encodeURIComponent(id)}`,
      // WHY retryable=true: DELETE is idempotent at the server (already-gone
      // returns 404, which the caller can treat as success-equivalent if they
      // want — but we don't auto-retry 404s, only 5xx).
      retryable: true,
    });
  }

  getContext(groupId: string): Promise<{ context: ContextRow }> {
    return this.request<{ context: ContextRow }>({
      method: 'GET',
      path: `/api/v1/contexts/${encodeURIComponent(groupId)}`,
      retryable: true,
    });
  }

  listSessionGroups(): Promise<SessionGroupsListResponse> {
    return this.request<SessionGroupsListResponse>({
      method: 'GET',
      path: '/api/v1/sessions/groups',
      retryable: true,
    });
  }

  /**
   * Set the active session within a group (focus transition).
   *
   * Used by the CLI's multi-agent orchestrator (Phase 4-step3) to commit a
   * focus change when the focused session ends and another running session
   * needs to take over. Mirror of the legacy /api/sessions/groups/[id]/focus
   * endpoint but authenticated via styrby_* Bearer token.
   *
   * WHY retryable=true: the update is idempotent (same group + same session_id
   * → same end-state, no duplicate side-effects). A retry after a 5xx that
   * succeeded server-side simply re-applies the same value.
   */
  setSessionGroupFocus(
    groupId: string,
    sessionId: string,
  ): Promise<{ group_id: string; active_agent_session_id: string }> {
    return this.request<{ group_id: string; active_agent_session_id: string }>({
      method: 'POST',
      path: `/api/v1/sessions/groups/${encodeURIComponent(groupId)}/focus`,
      body: { session_id: sessionId },
      retryable: true,
    });
  }

  searchAuditLog(query: AuditSearchQuery): Promise<AuditSearchResponse> {
    return this.request<AuditSearchResponse>({
      method: 'GET',
      path: '/api/v1/audit',
      query: {
        action: query.action,
        resource_id: query.resource_id,
        resource_type: query.resource_type,
        limit: query.limit,
        since: query.since,
      },
      retryable: true,
    });
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  listSessions(query: SessionListQuery = {}): Promise<SessionListResponse> {
    return this.request<SessionListResponse>({
      method: 'GET',
      path: '/api/v1/sessions',
      query: {
        limit: query.limit,
        offset: query.offset,
        status: query.status,
        agent_type: query.agent_type,
        archived: query.archived === undefined ? undefined : String(query.archived),
      },
      retryable: true,
    });
  }

  getSession(sessionId: string): Promise<{ session: SessionSummary }> {
    return this.request<{ session: SessionSummary }>({
      method: 'GET',
      path: `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
      retryable: true,
    });
  }

  listSessionMessages(sessionId: string, query: { limit?: number; offset?: number } = {}): Promise<unknown> {
    return this.request<unknown>({
      method: 'GET',
      path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
      query: { limit: query.limit, offset: query.offset },
      retryable: true,
    });
  }

  listSessionCheckpoints(sessionId: string): Promise<{ checkpoints: SessionCheckpoint[] }> {
    return this.request<{ checkpoints: SessionCheckpoint[] }>({
      method: 'GET',
      path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/checkpoints`,
      retryable: true,
    });
  }

  createSessionCheckpoint(
    sessionId: string,
    input: { name: string; message_index: number; notes?: string },
    opts?: { idempotencyKey?: string },
  ): Promise<{ checkpoint: SessionCheckpoint }> {
    return this.request<{ checkpoint: SessionCheckpoint }>({
      method: 'POST',
      path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/checkpoints`,
      body: input,
      retryable: Boolean(opts?.idempotencyKey),
      idempotencyKey: opts?.idempotencyKey,
    });
  }

  async deleteSessionCheckpoint(
    sessionId: string,
    selector: { name?: string; checkpointId?: string },
  ): Promise<{ deleted: true }> {
    if (!selector.name && !selector.checkpointId) {
      // WHY async-rejected (not sync throw): the method is typed Promise<...>;
      // callers expect to handle errors via .catch / try/await. A sync throw
      // would force them to wrap the call site in a separate try, splitting
      // the error path. Single uniform rejection.
      throw new Error('deleteSessionCheckpoint requires either name or checkpointId');
    }
    return this.request<{ deleted: true }>({
      method: 'DELETE',
      path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/checkpoints`,
      query: { name: selector.name, checkpointId: selector.checkpointId },
      // WHY retryable=true: DELETE is idempotent — second delete returns the
      // same outcome (already-gone counts as success at this layer).
      retryable: true,
    });
  }

  deleteSessionGroup(groupId: string): Promise<{ deleted: boolean; id: string }> {
    return this.request<{ deleted: boolean; id: string }>({
      method: 'DELETE',
      path: `/api/v1/sessions/groups/${encodeURIComponent(groupId)}`,
      retryable: true,
    });
  }

  // -------------------------------------------------------------------------
  // Costs
  // -------------------------------------------------------------------------

  getCostsSummary(query: { period?: string } = {}): Promise<CostsSummaryResponse> {
    return this.request<CostsSummaryResponse>({
      method: 'GET',
      path: '/api/v1/costs',
      query: { period: query.period },
      retryable: true,
    });
  }

  getCostsBreakdown(query: { period?: string } = {}): Promise<CostsBreakdownResponse> {
    return this.request<CostsBreakdownResponse>({
      method: 'GET',
      path: '/api/v1/costs/breakdown',
      query: { period: query.period },
      retryable: true,
    });
  }

  /**
   * Costs export returns CSV text (not JSON). Caller writes the string to disk
   * or pipes to stdout. Other endpoints all return JSON via `request`.
   */
  async exportCostsCsv(query: { period?: string } = {}): Promise<string> {
    const url = this.buildUrl('/api/v1/costs/export', { period: query.period });
    const response = await this.fetchWithTimeout(url, {
      method: 'GET',
      headers: this.buildHeaders({ unauthenticated: false, contentType: false }),
    });
    if (!response.ok) {
      const body = await this.safeReadJson(response);
      throw this.errorFromResponse(response.status, body);
    }
    Sentry.addBreadcrumb({
      category: 'styrby-api',
      level: 'info',
      message: 'GET /api/v1/costs/export',
      data: { status: response.status },
    });
    return await response.text();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private buildUrl(path: string, query?: Record<string, string | number | boolean | undefined>): string {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private buildHeaders(opts: { unauthenticated?: boolean; contentType?: boolean; idempotencyKey?: string }): Headers {
    const headers = new Headers();
    headers.set('Accept', 'application/json');
    if (opts.contentType !== false) {
      headers.set('Content-Type', 'application/json');
    }
    if (!opts.unauthenticated) {
      // WHY throw here (not earlier): auth-bootstrap methods explicitly pass
      // unauthenticated=true. Any other path that lacks an apiKey is a coding
      // bug we want surfaced loudly rather than silently 401'd.
      if (!this.apiKey) {
        throw new Error('StyrbyApiClient: apiKey is required for this endpoint');
      }
      headers.set('Authorization', `Bearer ${this.apiKey}`);
    }
    if (opts.idempotencyKey) {
      headers.set('Idempotency-Key', opts.idempotencyKey);
    }
    return headers;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private async safeReadJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return undefined;
    }
  }

  /**
   * Construct a `StyrbyApiError` from a non-2xx response. Server contract
   * across v1 routes is a JSON object with `error` (string or code) and
   * occasionally `message` and `retryAfter`. We accept both shapes.
   */
  private errorFromResponse(status: number, body: unknown): StyrbyApiError {
    let message = `Styrby API request failed with status ${status}`;
    let code: string | undefined;
    let retryAfter: number | undefined;

    if (body && typeof body === 'object') {
      const obj = body as Record<string, unknown>;
      if (typeof obj.error === 'string') {
        // Some routes return `{ error: 'CODE_NAME', message: 'human text' }`.
        // Others return `{ error: 'human text' }`. Treat short ALL_CAPS as code.
        if (typeof obj.message === 'string') {
          code = obj.error;
          message = obj.message;
        } else if (/^[A-Z_][A-Z0-9_]+$/.test(obj.error)) {
          code = obj.error;
          message = obj.error;
        } else {
          message = obj.error;
        }
      }
      if (typeof obj.retryAfter === 'number') {
        retryAfter = obj.retryAfter;
      }
    }

    return new StyrbyApiError(status, message, { code, retryAfter, body });
  }

  /** Whether a status code or transport error should be retried. */
  private isRetryableStatus(status: number): boolean {
    return status === 0 || status === 429 || (status >= 500 && status < 600);
  }

  /** Backoff delay (ms) for the given attempt number (1-based). Honours `Retry-After` when present. */
  private backoffMs(attempt: number, retryAfter: number | undefined): number {
    if (retryAfter !== undefined && retryAfter > 0) {
      // Server's hint is in seconds; cap so a misbehaving server can't pin us indefinitely.
      return Math.min(retryAfter * 1000, MAX_BACKOFF_MS);
    }
    const exp = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
    // Add up-to-25% jitter so concurrent clients don't synchronise their retries.
    const jitter = Math.random() * exp * 0.25;
    return Math.min(exp + jitter, MAX_BACKOFF_MS);
  }

  /**
   * JSON request helper used by every typed method. Returns the parsed body,
   * discarding the status code. Use `requestRaw` when status matters (e.g. 200 vs 201).
   */
  private async request<T>(req: InternalRequest): Promise<T> {
    const { body } = await this.requestRaw<T>(req);
    return body;
  }

  /**
   * Same as `request` but exposes the HTTP status alongside the body. Used by
   * `upsertContext` to distinguish first-insert (201) from update (200).
   */
  private async requestRaw<T>(req: InternalRequest): Promise<{ status: number; body: T }> {
    const url = this.buildUrl(req.path, req.query);
    const init: RequestInit = {
      method: req.method,
      headers: this.buildHeaders({
        unauthenticated: req.unauthenticated,
        idempotencyKey: req.idempotencyKey,
      }),
    };
    if (req.body !== undefined) {
      init.body = JSON.stringify(req.body);
    }

    let lastError: StyrbyApiError | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let response: Response;
      try {
        response = await this.fetchWithTimeout(url, init);
      } catch (err) {
        // Network / timeout / abort — treat as status 0.
        lastError = new StyrbyApiError(0, err instanceof Error ? err.message : 'Network error', { body: err });
        if (!req.retryable || attempt === this.maxAttempts) {
          this.breadcrumb(req, 0, attempt, 'transport-error');
          throw lastError;
        }
        await this.sleep(this.backoffMs(attempt, undefined));
        continue;
      }

      if (response.ok) {
        const json = (await this.safeReadJson(response)) as T;
        this.breadcrumb(req, response.status, attempt, 'ok');
        return { status: response.status, body: json };
      }

      const errBody = await this.safeReadJson(response);
      const apiError = this.errorFromResponse(response.status, errBody);
      lastError = apiError;

      if (!req.retryable || !this.isRetryableStatus(response.status) || attempt === this.maxAttempts) {
        this.breadcrumb(req, response.status, attempt, 'error');
        throw apiError;
      }

      await this.sleep(this.backoffMs(attempt, apiError.retryAfter));
    }

    // Unreachable — the loop returns or throws on every path. This satisfies TS.
    throw lastError ?? new StyrbyApiError(0, 'StyrbyApiClient: exhausted retries with no error');
  }

  private breadcrumb(req: InternalRequest, status: number, attempt: number, outcome: 'ok' | 'error' | 'transport-error'): void {
    Sentry.addBreadcrumb({
      category: 'styrby-api',
      level: outcome === 'ok' ? 'info' : 'warning',
      message: `${req.method} ${req.path}`,
      data: {
        status,
        attempt,
        outcome,
        // WHY only path (not query/body): values may include user identifiers,
        // OTPs, or session group IDs. Sentry breadcrumbs are auto-attached to
        // every error; minimise PII exposure. GDPR Art 5(1)(c) data minimisation.
      },
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
