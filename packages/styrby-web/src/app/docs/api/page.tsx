import type { Metadata } from "next";
import { PrevNext } from "../prev-next";
import { getPrevNext } from "../nav";

export const metadata: Metadata = {
  title: "API Reference",
  description: "Styrby REST API: authentication, endpoints, request/response examples, and rate limits.",
};

/**
 * API Reference page. Covers auth, endpoints, examples, rate limits, errors.
 */
export default function APIReferencePage() {
  const { prev, next } = getPrevNext("/docs/api");

  return (
    <article>
      <h1 className="text-3xl font-bold tracking-tight text-foreground">
        API Reference
      </h1>
      <p className="mt-3 text-muted-foreground">
        Programmatic access to your Styrby data. Available on the Pro or Growth tier.
      </p>

      {/* Auth */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="authentication">
        Authentication
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Generate an API key in the dashboard under Settings &gt; API Keys. Pass
        it as a Bearer token in the{" "}
        <code className="rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground/75">Authorization</code>{" "}
        header.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-card p-4 text-sm font-mono text-foreground/75 ring-1 ring-border">
        <code>{`Authorization: Bearer styrby_abc123...`}</code>
      </pre>
      <p className="mt-2 text-sm text-muted-foreground/70">
        API keys are prefixed with{" "}
        <code className="rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground/75">styrby_</code>.
        They are hashed with bcrypt (cost factor 12) before storage. Styrby
        cannot retrieve your key after creation. Store it securely. Keys can
        optionally expire; set an expiration in days when creating the key.
      </p>

      {/* Base URL */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="base-url">Base URL</h2>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-card p-4 text-sm font-mono text-foreground/75 ring-1 ring-border">
        <code>https://styrbyapp.com/api/v1</code>
      </pre>

      {/* GET /sessions */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="get-sessions">
        GET /sessions
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Returns a paginated list of your sessions, newest first. Archived
        sessions are excluded by default.
      </p>
      <h3 className="mt-4 text-base font-medium text-foreground/90 scroll-mt-20" id="query-parameters">Query Parameters</h3>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="pb-2 pr-4 font-medium text-foreground/75">Param</th>
              <th className="pb-2 pr-4 font-medium text-foreground/75">Type</th>
              <th className="pb-2 font-medium text-foreground/75">Description</th>
            </tr>
          </thead>
          <tbody className="text-muted-foreground">
            <tr className="border-b border-border/50">
              <td className="py-2 pr-4 font-mono text-xs text-foreground/75">agent_type</td>
              <td className="py-2 pr-4 text-xs">string</td>
              <td className="py-2 text-xs">Filter by agent type. Currently accepts <code className="rounded bg-secondary px-1 py-0.5">claude</code>, <code className="rounded bg-secondary px-1 py-0.5">codex</code>, <code className="rounded bg-secondary px-1 py-0.5">gemini</code>. Other agents are tracked in sessions but the filter values are not yet enabled.</td>
            </tr>
            <tr className="border-b border-border/50">
              <td className="py-2 pr-4 font-mono text-xs text-foreground/75">status</td>
              <td className="py-2 pr-4 text-xs">string</td>
              <td className="py-2 text-xs">Filter by status: starting, running, idle, paused, stopped, error, expired.</td>
            </tr>
            <tr className="border-b border-border/50">
              <td className="py-2 pr-4 font-mono text-xs text-foreground/75">limit</td>
              <td className="py-2 pr-4 text-xs">number</td>
              <td className="py-2 text-xs">Results per page. Default 20, max 100.</td>
            </tr>
            <tr className="border-b border-border/50">
              <td className="py-2 pr-4 font-mono text-xs text-foreground/75">offset</td>
              <td className="py-2 pr-4 text-xs">number</td>
              <td className="py-2 text-xs">Pagination offset. Default 0.</td>
            </tr>
            <tr>
              <td className="py-2 pr-4 font-mono text-xs text-foreground/75">archived</td>
              <td className="py-2 pr-4 text-xs">boolean</td>
              <td className="py-2 text-xs">Include archived sessions. Default false.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <pre className="mt-4 overflow-x-auto rounded-lg bg-card p-4 text-sm font-mono text-foreground/75 ring-1 ring-border">
        <code>{`curl -H "Authorization: Bearer styrby_abc123" \\
  "https://styrbyapp.com/api/v1/sessions?agent_type=claude&limit=5"

# Response
{
  "sessions": [
    {
      "id": "ses_8f3k2m9x",
      "agent_type": "claude",
      "model": "claude-sonnet-4-20250514",
      "title": "Refactor auth module",
      "status": "stopped",
      "total_input_tokens": 12840,
      "total_output_tokens": 3210,
      "total_cache_tokens": 8400,
      "total_cost_usd": 0.042,
      "started_at": "2026-03-22T14:30:00Z",
      "ended_at": "2026-03-22T14:45:12Z",
      "created_at": "2026-03-22T14:30:00Z"
    }
  ],
  "pagination": {
    "total": 142,
    "limit": 5,
    "offset": 0,
    "hasMore": true
  }
}`}</code>
      </pre>

      {/* GET /costs */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="get-costs">
        GET /costs
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Returns aggregated cost data for a time period. Choose daily (last 30
        days), weekly (last 12 weeks), or monthly (last 12 months) aggregation.
      </p>
      <h3 className="mt-4 text-base font-medium text-foreground/90 scroll-mt-20" id="query-parameters-2">Query Parameters</h3>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="pb-2 pr-4 font-medium text-foreground/75">Param</th>
              <th className="pb-2 pr-4 font-medium text-foreground/75">Type</th>
              <th className="pb-2 font-medium text-foreground/75">Description</th>
            </tr>
          </thead>
          <tbody className="text-muted-foreground">
            <tr>
              <td className="py-2 pr-4 font-mono text-xs text-foreground/75">period</td>
              <td className="py-2 pr-4 text-xs">string</td>
              <td className="py-2 text-xs">Aggregation period: daily, weekly, or monthly. Default monthly.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-card p-4 text-sm font-mono text-foreground/75 ring-1 ring-border">
        <code>{`curl -H "Authorization: Bearer styrby_abc123" \\
  "https://styrbyapp.com/api/v1/costs?period=daily"

# Response
{
  "summary": {
    "period": "daily",
    "totalCostUsd": 18.73,
    "totalInputTokens": 284000,
    "totalOutputTokens": 62000,
    "totalCacheTokens": 190000,
    "sessionCount": 47
  },
  "breakdown": [
    {
      "date": "2026-03-22",
      "costUsd": 2.14,
      "inputTokens": 34000,
      "outputTokens": 8000,
      "cacheTokens": 22000
    }
  ]
}`}</code>
      </pre>

      {/* GET /costs/breakdown */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="get-costs-breakdown">
        GET /costs/breakdown
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Returns cost breakdown grouped by agent type for a trailing window.
      </p>
      <h3 className="mt-4 text-base font-medium text-foreground/90 scroll-mt-20" id="query-parameters-3">Query Parameters</h3>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="pb-2 pr-4 font-medium text-foreground/75">Param</th>
              <th className="pb-2 pr-4 font-medium text-foreground/75">Type</th>
              <th className="pb-2 font-medium text-foreground/75">Description</th>
            </tr>
          </thead>
          <tbody className="text-muted-foreground">
            <tr>
              <td className="py-2 pr-4 font-mono text-xs text-foreground/75">days</td>
              <td className="py-2 pr-4 text-xs">number</td>
              <td className="py-2 text-xs">Trailing days to include. Default 30, max 365.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-card p-4 text-sm font-mono text-foreground/75 ring-1 ring-border">
        <code>{`curl -H "Authorization: Bearer styrby_abc123" \\
  "https://styrbyapp.com/api/v1/costs/breakdown?days=30"

# Response
{
  "breakdown": [
    {
      "agentType": "claude",
      "costUsd": 15.42,
      "inputTokens": 220000,
      "outputTokens": 48000,
      "cacheTokens": 160000,
      "sessionCount": 38,
      "percentage": 82.3
    },
    {
      "agentType": "codex",
      "costUsd": 3.31,
      "inputTokens": 64000,
      "outputTokens": 14000,
      "cacheTokens": 30000,
      "sessionCount": 9,
      "percentage": 17.7
    }
  ],
  "total": {
    "costUsd": 18.73,
    "inputTokens": 284000,
    "outputTokens": 62000,
    "cacheTokens": 190000,
    "sessionCount": 47
  }
}`}</code>
      </pre>

      {/* GET /machines */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="get-machines">
        GET /machines
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Returns all paired machines for your account.
      </p>
      <h3 className="mt-4 text-base font-medium text-foreground/90 scroll-mt-20" id="query-parameters-4">Query Parameters</h3>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="pb-2 pr-4 font-medium text-foreground/75">Param</th>
              <th className="pb-2 pr-4 font-medium text-foreground/75">Type</th>
              <th className="pb-2 font-medium text-foreground/75">Description</th>
            </tr>
          </thead>
          <tbody className="text-muted-foreground">
            <tr>
              <td className="py-2 pr-4 font-mono text-xs text-foreground/75">online_only</td>
              <td className="py-2 pr-4 text-xs">boolean</td>
              <td className="py-2 text-xs">Filter to only currently online machines. Default false.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-card p-4 text-sm font-mono text-foreground/75 ring-1 ring-border">
        <code>{`curl -H "Authorization: Bearer styrby_abc123" \\
  "https://styrbyapp.com/api/v1/machines"

# Response
{
  "machines": [
    {
      "id": "mch_abc123",
      "name": "macbook-pro",
      "platform": "darwin",
      "hostname": "macbook-pro.local",
      "cliVersion": "0.1.0-beta.7",
      "isOnline": true,
      "lastSeenAt": "2026-03-22T15:42:00Z",
      "createdAt": "2026-03-10T09:00:00Z"
    }
  ],
  "count": 1
}`}</code>
      </pre>

      {/* GET /sessions/:id */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="get-sessions-id">
        GET /sessions/:id
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Returns a single session by UUID. The path parameter must be a valid
        UUID; otherwise the endpoint returns 400.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-card p-4 text-sm font-mono text-foreground/75 ring-1 ring-border">
        <code>{`curl -H "Authorization: Bearer styrby_abc123" \\
  "https://styrbyapp.com/api/v1/sessions/8f3k2m9x-1234-5678-9abc-def012345678"

# Errors
# 400 { "error": "Invalid session ID" }
# 404 { "error": "Session not found" }`}</code>
      </pre>

      {/* GET /sessions/:id/messages */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="get-sessions-id-messages">
        GET /sessions/:id/messages
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Lists messages for a session. Message bodies are end-to-end encrypted
        and returned as ciphertext. Decryption requires the per-machine private
        key, so this endpoint is mainly useful for metadata, archival, and
        client-side decryption pipelines.
      </p>
      <h3 className="mt-4 text-base font-medium text-foreground/90 scroll-mt-20" id="messages-query-parameters">Query Parameters</h3>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="pb-2 pr-4 font-medium text-foreground/75">Param</th>
              <th className="pb-2 pr-4 font-medium text-foreground/75">Type</th>
              <th className="pb-2 font-medium text-foreground/75">Description</th>
            </tr>
          </thead>
          <tbody className="text-muted-foreground">
            <tr className="border-b border-border/50">
              <td className="py-2 pr-4 font-mono text-xs text-foreground/75">limit</td>
              <td className="py-2 pr-4 text-xs">number</td>
              <td className="py-2 text-xs">Results per page. Default 50, max 200.</td>
            </tr>
            <tr className="border-b border-border/50">
              <td className="py-2 pr-4 font-mono text-xs text-foreground/75">offset</td>
              <td className="py-2 pr-4 text-xs">number</td>
              <td className="py-2 text-xs">Pagination offset. Default 0.</td>
            </tr>
            <tr>
              <td className="py-2 pr-4 font-mono text-xs text-foreground/75">type</td>
              <td className="py-2 pr-4 text-xs">string</td>
              <td className="py-2 text-xs">
                Filter by message type. One of:{" "}
                <code className="rounded bg-secondary px-1 py-0.5">user_prompt</code>,{" "}
                <code className="rounded bg-secondary px-1 py-0.5">agent_response</code>,{" "}
                <code className="rounded bg-secondary px-1 py-0.5">agent_thinking</code>,{" "}
                <code className="rounded bg-secondary px-1 py-0.5">permission_request</code>,{" "}
                <code className="rounded bg-secondary px-1 py-0.5">permission_response</code>,{" "}
                <code className="rounded bg-secondary px-1 py-0.5">tool_use</code>,{" "}
                <code className="rounded bg-secondary px-1 py-0.5">tool_result</code>,{" "}
                <code className="rounded bg-secondary px-1 py-0.5">error</code>,{" "}
                <code className="rounded bg-secondary px-1 py-0.5">system</code>.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* GET / POST /sessions/:id/checkpoints */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="sessions-id-checkpoints">
        GET / POST /sessions/:id/checkpoints
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Lists or creates named checkpoints inside a session timeline. POST
        requires the Power tier and rejects names longer than 80 characters or
        outside the <code className="rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground/75">[a-zA-Z0-9 \-_.]</code>{" "}
        character class. Names must be unique within a session.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-card p-4 text-sm font-mono text-foreground/75 ring-1 ring-border">
        <code>{`# List
curl -H "Authorization: Bearer styrby_abc123" \\
  "https://styrbyapp.com/api/v1/sessions/<id>/checkpoints"

# Create
curl -X POST -H "Authorization: Bearer styrby_abc123" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "before-refactor",
    "description": "auth module rewrite, message 142",
    "messageSequenceNumber": 142
  }' \\
  "https://styrbyapp.com/api/v1/sessions/<id>/checkpoints"

# Errors
# 400 { "error": <Zod validation message> }
# 403 { "error": "Power tier required" }
# 409 { "error": "Checkpoint name already exists" }`}</code>
      </pre>

      {/* GET /costs/export */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="get-costs-export">
        GET /costs/export
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Streams raw cost records as CSV for accounting and reconciliation. Power
        tier only. Throttled to 1 request per hour per API key (export is
        expensive); the standard 100 req/min ceiling still applies for everything
        else.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-card p-4 text-sm font-mono text-foreground/75 ring-1 ring-border">
        <code>{`curl -H "Authorization: Bearer styrby_abc123" \\
  "https://styrbyapp.com/api/v1/costs/export?days=90" \\
  -o styrby-costs.csv

# Response: text/csv with header
# date, session_id, agent_type, model, input_tokens,
# output_tokens, cache_tokens, cost_usd

# Errors
# 403 { "error": "Power tier required" }
# 429 { "error": "RATE_LIMITED" }`}</code>
      </pre>

      {/* Rate Limits */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="rate-limits">
        Rate Limits
      </h2>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="pb-2 pr-4 font-medium text-foreground/75">Endpoint group</th>
              <th className="pb-2 pr-4 font-medium text-foreground/75">Limit</th>
              <th className="pb-2 font-medium text-foreground/75">Window</th>
            </tr>
          </thead>
          <tbody className="text-muted-foreground">
            <tr className="border-b border-border/50">
              <td className="py-2 pr-4 text-xs">All v1 endpoints (default)</td>
              <td className="py-2 pr-4 text-xs">100 requests</td>
              <td className="py-2 text-xs">Per minute, per API key</td>
            </tr>
            <tr>
              <td className="py-2 pr-4 text-xs">GET /costs/export</td>
              <td className="py-2 pr-4 text-xs">1 request</td>
              <td className="py-2 text-xs">Per hour, per API key</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Error Codes */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="error-codes">
        Error Codes
      </h2>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="pb-2 pr-4 font-medium text-foreground/75">HTTP</th>
              <th className="pb-2 pr-4 font-medium text-foreground/75">Description</th>
            </tr>
          </thead>
          <tbody className="text-muted-foreground">
            <tr className="border-b border-border/50">
              <td className="py-2 pr-4 text-xs">400</td>
              <td className="py-2 text-xs">Missing or malformed query parameters.</td>
            </tr>
            <tr className="border-b border-border/50">
              <td className="py-2 pr-4 text-xs">401</td>
              <td className="py-2 text-xs">Missing or invalid API key.</td>
            </tr>
            <tr className="border-b border-border/50">
              <td className="py-2 pr-4 text-xs">403</td>
              <td className="py-2 text-xs">API access requires a Pro or Growth subscription.</td>
            </tr>
            <tr className="border-b border-border/50">
              <td className="py-2 pr-4 text-xs">429</td>
              <td className="py-2 text-xs">Too many requests. Retry after the indicated delay.</td>
            </tr>
            <tr>
              <td className="py-2 pr-4 text-xs">500</td>
              <td className="py-2 text-xs">Server error. Retry with exponential backoff.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-sm text-muted-foreground">
        All error responses use the same shape:
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-card p-4 text-sm font-mono text-foreground/75 ring-1 ring-border">
        <code>{`{
  "error": "Rate limit exceeded. Try again in 42 seconds."
}`}</code>
      </pre>

      <PrevNext prev={prev} next={next} />
    </article>
  );
}
