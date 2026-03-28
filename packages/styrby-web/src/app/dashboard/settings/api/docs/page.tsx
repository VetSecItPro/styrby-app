/**
 * API Documentation Page
 *
 * Static documentation for the Styrby API v1.
 * Covers authentication, rate limits, endpoints, and error handling.
 */

import Link from 'next/link';

// ---------------------------------------------------------------------------
// Code Block Component
// ---------------------------------------------------------------------------

function CodeBlock({ language, code }: { language: string; code: string }) {
  return (
    <div className="relative rounded-lg bg-zinc-800 border border-zinc-700 overflow-hidden">
      <div className="absolute top-0 right-0 px-2 py-1 text-xs text-zinc-500">
        {language}
      </div>
      <pre className="p-4 overflow-x-auto text-sm text-zinc-300">
        <code>{code}</code>
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section Component
// ---------------------------------------------------------------------------

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="mb-12">
      <h2 className="text-xl font-semibold text-zinc-100 mb-4 scroll-mt-8">{title}</h2>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Endpoint Component
// ---------------------------------------------------------------------------

function Endpoint({
  method,
  path,
  description,
  params,
  response,
}: {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  description: string;
  params?: { name: string; type: string; description: string; required?: boolean }[];
  response: string;
}) {
  const methodColors = {
    GET: 'bg-green-500/10 text-green-400',
    POST: 'bg-blue-500/10 text-blue-400',
    DELETE: 'bg-red-500/10 text-red-400',
  };

  return (
    <div className="rounded-xl bg-zinc-900 border border-zinc-800 overflow-hidden mb-6">
      <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-3">
        <span
          className={`px-2 py-0.5 rounded text-xs font-semibold ${methodColors[method]}`}
        >
          {method}
        </span>
        <code className="text-sm text-zinc-300">{path}</code>
      </div>
      <div className="p-4">
        <p className="text-sm text-zinc-400 mb-4">{description}</p>

        {params && params.length > 0 && (
          <div className="mb-4">
            <h4 className="text-sm font-medium text-zinc-300 mb-2">Parameters</h4>
            <div className="space-y-2">
              {params.map((param) => (
                <div key={param.name} className="flex items-start gap-2">
                  <code className="text-xs bg-zinc-800 px-1.5 py-0.5 rounded text-orange-400">
                    {param.name}
                  </code>
                  <span className="text-xs text-zinc-500">{param.type}</span>
                  {param.required && (
                    <span className="text-xs text-red-400">required</span>
                  )}
                  <span className="text-xs text-zinc-400">{param.description}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <h4 className="text-sm font-medium text-zinc-300 mb-2">Response</h4>
          <CodeBlock language="json" code={response} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page Component
// ---------------------------------------------------------------------------

export default function ApiDocsPage() {
  return (
    <div className="min-h-screen bg-zinc-950">
      {/* Header */}
      <header className="border-b border-zinc-800 bg-zinc-900/50">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            <div className="flex items-center gap-4">
              <Link href="/dashboard" className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center">
                  <span className="text-lg font-bold text-white">S</span>
                </div>
                <span className="font-semibold text-zinc-100">Styrby</span>
              </Link>
            </div>

            <nav className="flex items-center gap-6">
              <Link
                href="/dashboard"
                className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
              >
                Dashboard
              </Link>
              <Link
                href="/sessions"
                className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
              >
                Sessions
              </Link>
              <Link
                href="/costs"
                className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
              >
                Costs
              </Link>
              <Link href="/settings" className="text-sm font-medium text-orange-500">
                Settings
              </Link>
            </nav>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center gap-3 mb-2">
          <Link
            href="/settings"
            className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            Settings
          </Link>
          <span className="text-zinc-500">/</span>
          <Link
            href="/settings/api"
            className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            API Keys
          </Link>
          <span className="text-zinc-500">/</span>
          <span className="text-sm text-zinc-300">Documentation</span>
        </div>
        <h1 className="text-2xl font-bold text-zinc-100 mb-2">API Documentation</h1>
        <p className="text-zinc-400 mb-8">
          The Styrby API provides read-only access to your sessions, costs, and machines.
        </p>

        {/* Table of Contents */}
        <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4 mb-8">
          <h3 className="text-sm font-medium text-zinc-300 mb-3">Contents</h3>
          <nav className="space-y-1">
            <a href="#authentication" className="block text-sm text-orange-400 hover:text-orange-300">
              Authentication
            </a>
            <a href="#rate-limits" className="block text-sm text-orange-400 hover:text-orange-300">
              Rate Limits
            </a>
            <a href="#errors" className="block text-sm text-orange-400 hover:text-orange-300">
              Error Handling
            </a>
            <a href="#sessions" className="block text-sm text-orange-400 hover:text-orange-300">
              Sessions Endpoints
            </a>
            <a href="#costs" className="block text-sm text-orange-400 hover:text-orange-300">
              Costs Endpoints
            </a>
            <a href="#machines" className="block text-sm text-orange-400 hover:text-orange-300">
              Machines Endpoints
            </a>
          </nav>
        </div>

        {/* Authentication */}
        <Section id="authentication" title="Authentication">
          <p className="text-sm text-zinc-400 mb-4">
            All API requests require authentication using an API key. Include your key in the
            Authorization header:
          </p>
          <CodeBlock
            language="bash"
            code={`curl -H "Authorization: Bearer sk_live_your_api_key_here" \\
  https://styrby.app/api/v1/sessions`}
          />
          <div className="mt-4 rounded-lg bg-yellow-500/10 border border-yellow-500/30 px-4 py-3">
            <p className="text-sm text-yellow-400">
              Keep your API key secret. Do not expose it in client-side code or public
              repositories. If compromised, revoke it immediately and create a new one.
            </p>
          </div>
        </Section>

        {/* Rate Limits */}
        <Section id="rate-limits" title="Rate Limits">
          <p className="text-sm text-zinc-400 mb-4">
            API requests are rate limited to 100 requests per minute per API key. Rate limit
            information is included in response headers:
          </p>
          <div className="rounded-lg bg-zinc-800 border border-zinc-700 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-700">
                  <th className="px-4 py-2 text-left text-zinc-300">Header</th>
                  <th className="px-4 py-2 text-left text-zinc-300">Description</th>
                </tr>
              </thead>
              <tbody className="text-zinc-400">
                <tr className="border-b border-zinc-700">
                  <td className="px-4 py-2 font-mono text-xs">X-RateLimit-Limit</td>
                  <td className="px-4 py-2">Maximum requests per window (100)</td>
                </tr>
                <tr className="border-b border-zinc-700">
                  <td className="px-4 py-2 font-mono text-xs">X-RateLimit-Remaining</td>
                  <td className="px-4 py-2">Remaining requests in current window</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 font-mono text-xs">X-RateLimit-Reset</td>
                  <td className="px-4 py-2">Unix timestamp when the window resets</td>
                </tr>
              </tbody>
            </table>
          </div>
        </Section>

        {/* Errors */}
        <Section id="errors" title="Error Handling">
          <p className="text-sm text-zinc-400 mb-4">
            The API uses standard HTTP status codes and returns JSON error responses:
          </p>
          <div className="rounded-lg bg-zinc-800 border border-zinc-700 overflow-hidden mb-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-700">
                  <th className="px-4 py-2 text-left text-zinc-300">Status</th>
                  <th className="px-4 py-2 text-left text-zinc-300">Description</th>
                </tr>
              </thead>
              <tbody className="text-zinc-400">
                <tr className="border-b border-zinc-700">
                  <td className="px-4 py-2 font-mono text-xs">200</td>
                  <td className="px-4 py-2">Success</td>
                </tr>
                <tr className="border-b border-zinc-700">
                  <td className="px-4 py-2 font-mono text-xs">400</td>
                  <td className="px-4 py-2">Bad request (invalid parameters)</td>
                </tr>
                <tr className="border-b border-zinc-700">
                  <td className="px-4 py-2 font-mono text-xs">401</td>
                  <td className="px-4 py-2">Unauthorized (invalid or missing API key)</td>
                </tr>
                <tr className="border-b border-zinc-700">
                  <td className="px-4 py-2 font-mono text-xs">403</td>
                  <td className="px-4 py-2">Forbidden (insufficient permissions)</td>
                </tr>
                <tr className="border-b border-zinc-700">
                  <td className="px-4 py-2 font-mono text-xs">404</td>
                  <td className="px-4 py-2">Not found</td>
                </tr>
                <tr className="border-b border-zinc-700">
                  <td className="px-4 py-2 font-mono text-xs">429</td>
                  <td className="px-4 py-2">Rate limit exceeded</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 font-mono text-xs">500</td>
                  <td className="px-4 py-2">Internal server error</td>
                </tr>
              </tbody>
            </table>
          </div>
          <CodeBlock
            language="json"
            code={`{
  "error": "Invalid API key",
  "code": "UNAUTHORIZED"
}`}
          />
        </Section>

        {/* Sessions Endpoints */}
        <Section id="sessions" title="Sessions Endpoints">
          <Endpoint
            method="GET"
            path="/api/v1/sessions"
            description="List sessions for your account. Supports pagination and filtering."
            params={[
              { name: 'limit', type: 'number', description: 'Max results (1-100, default: 20)' },
              { name: 'offset', type: 'number', description: 'Skip N results (default: 0)' },
              { name: 'status', type: 'string', description: 'Filter by status (running, stopped, etc.)' },
              { name: 'agent_type', type: 'string', description: 'Filter by agent (claude, codex, gemini)' },
              { name: 'archived', type: 'boolean', description: 'Include archived sessions (default: false)' },
            ]}
            response={`{
  "sessions": [
    {
      "id": "uuid",
      "agent_type": "claude",
      "model": "claude-sonnet-4",
      "title": "Refactoring auth module",
      "status": "stopped",
      "total_cost_usd": 0.023456,
      "message_count": 42,
      "created_at": "2026-02-01T10:00:00Z"
    }
  ],
  "pagination": {
    "total": 156,
    "limit": 20,
    "offset": 0,
    "hasMore": true
  }
}`}
          />

          <Endpoint
            method="GET"
            path="/api/v1/sessions/:id"
            description="Get details for a single session."
            response={`{
  "session": {
    "id": "uuid",
    "agent_type": "claude",
    "model": "claude-sonnet-4",
    "title": "Refactoring auth module",
    "summary": "Refactored authentication...",
    "project_path": "/path/to/project",
    "git_branch": "main",
    "status": "stopped",
    "total_cost_usd": 0.023456,
    "total_input_tokens": 15000,
    "total_output_tokens": 5000,
    "message_count": 42,
    "created_at": "2026-02-01T10:00:00Z"
  }
}`}
          />

          <Endpoint
            method="GET"
            path="/api/v1/sessions/:id/messages"
            description="List messages for a session. Note: Message content is E2E encrypted."
            params={[
              { name: 'limit', type: 'number', description: 'Max results (1-200, default: 50)' },
              { name: 'offset', type: 'number', description: 'Skip N results (default: 0)' },
              { name: 'type', type: 'string', description: 'Filter by message type' },
            ]}
            response={`{
  "messages": [
    {
      "id": "uuid",
      "sequence_number": 1,
      "message_type": "user_prompt",
      "content_encrypted": "base64...",
      "encryption_nonce": "base64...",
      "input_tokens": 100,
      "output_tokens": 0,
      "created_at": "2026-02-01T10:00:00Z"
    }
  ],
  "pagination": {
    "total": 42,
    "limit": 50,
    "offset": 0,
    "hasMore": false
  }
}`}
          />
        </Section>

        {/* Costs Endpoints */}
        <Section id="costs" title="Costs Endpoints">
          <Endpoint
            method="GET"
            path="/api/v1/costs"
            description="Get cost summary aggregated by period (daily, weekly, or monthly)."
            params={[
              {
                name: 'period',
                type: 'string',
                description: 'Aggregation period: daily, weekly, monthly (default: monthly)',
              },
            ]}
            response={`{
  "summary": {
    "period": "monthly",
    "totalCostUsd": 45.67,
    "totalInputTokens": 1500000,
    "totalOutputTokens": 500000,
    "totalCacheTokens": 200000,
    "sessionCount": 156
  },
  "breakdown": [
    {
      "date": "2026-01",
      "costUsd": 23.45,
      "inputTokens": 750000,
      "outputTokens": 250000,
      "cacheTokens": 100000
    }
  ]
}`}
          />

          <Endpoint
            method="GET"
            path="/api/v1/costs/breakdown"
            description="Get cost breakdown by agent type."
            params={[
              { name: 'days', type: 'number', description: 'Look back N days (1-365, default: 30)' },
            ]}
            response={`{
  "breakdown": [
    {
      "agentType": "claude",
      "costUsd": 35.50,
      "inputTokens": 1200000,
      "outputTokens": 400000,
      "cacheTokens": 150000,
      "sessionCount": 120,
      "percentage": 77.5
    },
    {
      "agentType": "codex",
      "costUsd": 10.17,
      "inputTokens": 300000,
      "outputTokens": 100000,
      "cacheTokens": 50000,
      "sessionCount": 36,
      "percentage": 22.5
    }
  ],
  "total": {
    "costUsd": 45.67,
    "inputTokens": 1500000,
    "outputTokens": 500000,
    "cacheTokens": 200000,
    "sessionCount": 156
  },
  "period": {
    "days": 30,
    "startDate": "2026-01-07",
    "endDate": "2026-02-06"
  }
}`}
          />
        </Section>

        {/* Machines Endpoints */}
        <Section id="machines" title="Machines Endpoints">
          <Endpoint
            method="GET"
            path="/api/v1/machines"
            description="List connected machines (CLI instances)."
            params={[
              {
                name: 'online_only',
                type: 'boolean',
                description: 'Filter to only online machines (default: false)',
              },
            ]}
            response={`{
  "machines": [
    {
      "id": "uuid",
      "name": "MacBook Pro",
      "platform": "darwin",
      "platformVersion": "14.0.0",
      "architecture": "arm64",
      "hostname": "macbook.local",
      "cliVersion": "1.2.3",
      "isOnline": true,
      "lastSeenAt": "2026-02-06T10:00:00Z",
      "createdAt": "2025-12-01T10:00:00Z"
    }
  ],
  "count": 3
}`}
          />
        </Section>

        {/* Back link */}
        <div className="mt-12 pt-8 border-t border-zinc-800">
          <Link
            href="/settings/api"
            className="inline-flex items-center gap-2 text-sm text-orange-400 hover:text-orange-300 transition-colors"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Back to API Keys
          </Link>
        </div>
      </main>
    </div>
  );
}
