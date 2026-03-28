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
      <h1 className="text-3xl font-bold tracking-tight text-zinc-50">
        API Reference
      </h1>
      <p className="mt-3 text-zinc-400">
        Programmatic access to your Styrby data. Available on the Power tier.
      </p>

      {/* Auth */}
      <h2 className="mt-10 text-xl font-semibold text-zinc-100">
        Authentication
      </h2>
      <p className="mt-2 text-sm text-zinc-400">
        Generate an API key in the dashboard under Settings &gt; API Keys. Pass
        it as a Bearer token in the{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">Authorization</code>{" "}
        header.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm font-mono text-zinc-300 ring-1 ring-zinc-800">
        <code>{`Authorization: Bearer styrby_abc123...`}</code>
      </pre>
      <p className="mt-2 text-sm text-zinc-500">
        API keys are prefixed with{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">styrby_</code>.
        They are hashed with bcrypt (cost factor 12) before storage. Styrby
        cannot retrieve your key after creation. Store it securely. Keys can
        optionally expire; set an expiration in days when creating the key.
      </p>

      {/* Base URL */}
      <h2 className="mt-10 text-xl font-semibold text-zinc-100">Base URL</h2>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm font-mono text-zinc-300 ring-1 ring-zinc-800">
        <code>https://styrbyapp.com/api/v1</code>
      </pre>

      {/* GET /sessions */}
      <h2 className="mt-10 text-xl font-semibold text-zinc-100">
        GET /sessions
      </h2>
      <p className="mt-2 text-sm text-zinc-400">
        Returns a paginated list of your sessions, newest first. Archived
        sessions are excluded by default.
      </p>
      <h3 className="mt-4 text-base font-medium text-zinc-200">Query Parameters</h3>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-left">
              <th className="pb-2 pr-4 font-medium text-zinc-300">Param</th>
              <th className="pb-2 pr-4 font-medium text-zinc-300">Type</th>
              <th className="pb-2 font-medium text-zinc-300">Description</th>
            </tr>
          </thead>
          <tbody className="text-zinc-400">
            <tr className="border-b border-zinc-800/50">
              <td className="py-2 pr-4 font-mono text-xs text-zinc-300">agent_type</td>
              <td className="py-2 pr-4 text-xs">string</td>
              <td className="py-2 text-xs">Filter by agent type: claude, codex, gemini, opencode, or aider.</td>
            </tr>
            <tr className="border-b border-zinc-800/50">
              <td className="py-2 pr-4 font-mono text-xs text-zinc-300">status</td>
              <td className="py-2 pr-4 text-xs">string</td>
              <td className="py-2 text-xs">Filter by status: starting, running, idle, paused, stopped, error, expired.</td>
            </tr>
            <tr className="border-b border-zinc-800/50">
              <td className="py-2 pr-4 font-mono text-xs text-zinc-300">limit</td>
              <td className="py-2 pr-4 text-xs">number</td>
              <td className="py-2 text-xs">Results per page. Default 20, max 100.</td>
            </tr>
            <tr className="border-b border-zinc-800/50">
              <td className="py-2 pr-4 font-mono text-xs text-zinc-300">offset</td>
              <td className="py-2 pr-4 text-xs">number</td>
              <td className="py-2 text-xs">Pagination offset. Default 0.</td>
            </tr>
            <tr>
              <td className="py-2 pr-4 font-mono text-xs text-zinc-300">archived</td>
              <td className="py-2 pr-4 text-xs">boolean</td>
              <td className="py-2 text-xs">Include archived sessions. Default false.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <pre className="mt-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm font-mono text-zinc-300 ring-1 ring-zinc-800">
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
      <h2 className="mt-10 text-xl font-semibold text-zinc-100">
        GET /costs
      </h2>
      <p className="mt-2 text-sm text-zinc-400">
        Returns aggregated cost data for a time period. Choose daily (last 30
        days), weekly (last 12 weeks), or monthly (last 12 months) aggregation.
      </p>
      <h3 className="mt-4 text-base font-medium text-zinc-200">Query Parameters</h3>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-left">
              <th className="pb-2 pr-4 font-medium text-zinc-300">Param</th>
              <th className="pb-2 pr-4 font-medium text-zinc-300">Type</th>
              <th className="pb-2 font-medium text-zinc-300">Description</th>
            </tr>
          </thead>
          <tbody className="text-zinc-400">
            <tr>
              <td className="py-2 pr-4 font-mono text-xs text-zinc-300">period</td>
              <td className="py-2 pr-4 text-xs">string</td>
              <td className="py-2 text-xs">Aggregation period: daily, weekly, or monthly. Default monthly.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm font-mono text-zinc-300 ring-1 ring-zinc-800">
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
      <h2 className="mt-10 text-xl font-semibold text-zinc-100">
        GET /costs/breakdown
      </h2>
      <p className="mt-2 text-sm text-zinc-400">
        Returns cost breakdown grouped by agent type for a trailing window.
      </p>
      <h3 className="mt-4 text-base font-medium text-zinc-200">Query Parameters</h3>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-left">
              <th className="pb-2 pr-4 font-medium text-zinc-300">Param</th>
              <th className="pb-2 pr-4 font-medium text-zinc-300">Type</th>
              <th className="pb-2 font-medium text-zinc-300">Description</th>
            </tr>
          </thead>
          <tbody className="text-zinc-400">
            <tr>
              <td className="py-2 pr-4 font-mono text-xs text-zinc-300">days</td>
              <td className="py-2 pr-4 text-xs">number</td>
              <td className="py-2 text-xs">Trailing days to include. Default 30, max 365.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm font-mono text-zinc-300 ring-1 ring-zinc-800">
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
      <h2 className="mt-10 text-xl font-semibold text-zinc-100">
        GET /machines
      </h2>
      <p className="mt-2 text-sm text-zinc-400">
        Returns all paired machines for your account.
      </p>
      <h3 className="mt-4 text-base font-medium text-zinc-200">Query Parameters</h3>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-left">
              <th className="pb-2 pr-4 font-medium text-zinc-300">Param</th>
              <th className="pb-2 pr-4 font-medium text-zinc-300">Type</th>
              <th className="pb-2 font-medium text-zinc-300">Description</th>
            </tr>
          </thead>
          <tbody className="text-zinc-400">
            <tr>
              <td className="py-2 pr-4 font-mono text-xs text-zinc-300">online_only</td>
              <td className="py-2 pr-4 text-xs">boolean</td>
              <td className="py-2 text-xs">Filter to only currently online machines. Default false.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm font-mono text-zinc-300 ring-1 ring-zinc-800">
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

      {/* Rate Limits */}
      <h2 className="mt-10 text-xl font-semibold text-zinc-100">
        Rate Limits
      </h2>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-left">
              <th className="pb-2 pr-4 font-medium text-zinc-300">Endpoint group</th>
              <th className="pb-2 pr-4 font-medium text-zinc-300">Limit</th>
              <th className="pb-2 font-medium text-zinc-300">Window</th>
            </tr>
          </thead>
          <tbody className="text-zinc-400">
            <tr>
              <td className="py-2 pr-4 text-xs">All v1 endpoints</td>
              <td className="py-2 pr-4 text-xs">100 requests</td>
              <td className="py-2 text-xs">Per minute, per API key</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Error Codes */}
      <h2 className="mt-10 text-xl font-semibold text-zinc-100">
        Error Codes
      </h2>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-left">
              <th className="pb-2 pr-4 font-medium text-zinc-300">HTTP</th>
              <th className="pb-2 pr-4 font-medium text-zinc-300">Description</th>
            </tr>
          </thead>
          <tbody className="text-zinc-400">
            <tr className="border-b border-zinc-800/50">
              <td className="py-2 pr-4 text-xs">400</td>
              <td className="py-2 text-xs">Missing or malformed query parameters.</td>
            </tr>
            <tr className="border-b border-zinc-800/50">
              <td className="py-2 pr-4 text-xs">401</td>
              <td className="py-2 text-xs">Missing or invalid API key.</td>
            </tr>
            <tr className="border-b border-zinc-800/50">
              <td className="py-2 pr-4 text-xs">403</td>
              <td className="py-2 text-xs">API access requires Power tier.</td>
            </tr>
            <tr className="border-b border-zinc-800/50">
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
      <p className="mt-3 text-sm text-zinc-400">
        All error responses use the same shape:
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm font-mono text-zinc-300 ring-1 ring-zinc-800">
        <code>{`{
  "error": "Rate limit exceeded. Try again in 42 seconds."
}`}</code>
      </pre>

      <PrevNext prev={prev} next={next} />
    </article>
  );
}
