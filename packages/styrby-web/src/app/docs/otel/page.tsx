import type { Metadata } from "next";
import { PrevNext } from "../prev-next";
import { getPrevNext } from "../nav";

export const metadata: Metadata = {
  title: "OTEL Metrics Export",
  description:
    "Export Styrby session metrics to Grafana Cloud, Datadog, Honeycomb, or New Relic via OpenTelemetry.",
};

/**
 * OTEL Metrics Export documentation page.
 *
 * Covers setup for all four supported providers plus custom OTLP endpoints.
 * Power tier feature.
 */
export default function OtelDocsPage() {
  const { prev, next } = getPrevNext("/docs/otel");

  return (
    <article>
      <h1 className="text-3xl font-bold tracking-tight text-zinc-50">
        OTEL Metrics Export
      </h1>
      <p className="mt-3 text-zinc-400">
        Export session metrics to your existing observability platform.
        Styrby sends data using the OpenTelemetry OTLP/HTTP protocol, so it
        works with any OTLP-compatible backend. Power tier feature.
      </p>

      {/* What gets exported */}
      <h2 className="mt-10 text-xl font-semibold text-zinc-100">
        Exported Metrics
      </h2>
      <p className="mt-3 text-zinc-400">
        After each session, Styrby exports these 7 metrics to your configured
        endpoint:
      </p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm text-left text-zinc-400">
          <thead className="text-xs uppercase text-zinc-500 border-b border-zinc-800">
            <tr>
              <th className="py-2 pr-4">Metric</th>
              <th className="py-2 pr-4">Type</th>
              <th className="py-2">Attributes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            <tr><td className="py-2 pr-4 font-mono text-zinc-300">styrby.session.duration_ms</td><td className="py-2 pr-4">Gauge</td><td className="py-2">agent, model, status</td></tr>
            <tr><td className="py-2 pr-4 font-mono text-zinc-300">styrby.tokens.input</td><td className="py-2 pr-4">Sum</td><td className="py-2">agent, model</td></tr>
            <tr><td className="py-2 pr-4 font-mono text-zinc-300">styrby.tokens.output</td><td className="py-2 pr-4">Sum</td><td className="py-2">agent, model</td></tr>
            <tr><td className="py-2 pr-4 font-mono text-zinc-300">styrby.tokens.cache_read</td><td className="py-2 pr-4">Sum</td><td className="py-2">agent, model</td></tr>
            <tr><td className="py-2 pr-4 font-mono text-zinc-300">styrby.tokens.cache_write</td><td className="py-2 pr-4">Sum</td><td className="py-2">agent, model</td></tr>
            <tr><td className="py-2 pr-4 font-mono text-zinc-300">styrby.cost.usd</td><td className="py-2 pr-4">Sum</td><td className="py-2">agent, model</td></tr>
            <tr><td className="py-2 pr-4 font-mono text-zinc-300">styrby.errors.count</td><td className="py-2 pr-4">Sum</td><td className="py-2">agent, error_source</td></tr>
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-zinc-500 text-sm">
        All metrics include{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
          service.name
        </code>{" "}
        as a resource attribute (defaults to &quot;styrby-cli&quot;).
      </p>

      {/* Two ways to configure */}
      <h2 className="mt-10 text-xl font-semibold text-zinc-100">
        Configuration
      </h2>
      <p className="mt-3 text-zinc-400">
        There are two ways to configure OTEL export. Both produce the same
        result.
      </p>

      <h3 className="mt-6 text-lg font-medium text-zinc-200">
        Option A: Web Dashboard (recommended)
      </h3>
      <ol className="mt-3 list-decimal list-inside space-y-2 text-zinc-400">
        <li>Go to <strong className="text-zinc-300">Settings</strong> in the web dashboard</li>
        <li>Scroll to the <strong className="text-zinc-300">OTEL Metrics Export</strong> section</li>
        <li>Select your provider preset (Grafana Cloud, Datadog, Honeycomb, New Relic, or Custom)</li>
        <li>Paste your endpoint URL and authentication credentials</li>
        <li>Click <strong className="text-zinc-300">Save</strong></li>
        <li>Copy the generated environment variables from the preview panel</li>
        <li>Add them to your shell profile (<code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">~/.zshrc</code> or <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">~/.bashrc</code>)</li>
      </ol>

      <h3 className="mt-6 text-lg font-medium text-zinc-200">
        Option B: Environment Variables (direct)
      </h3>
      <p className="mt-3 text-zinc-400">
        Set these in your shell profile or{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">.env</code>{" "}
        file:
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-300 border border-zinc-800">
{`export STYRBY_OTEL_ENABLED=true
export STYRBY_OTEL_ENDPOINT="https://your-endpoint/v1/metrics"
export STYRBY_OTEL_HEADERS='{"Authorization":"Bearer your-key"}'
export STYRBY_OTEL_SERVICE="styrby-cli"
export STYRBY_OTEL_TIMEOUT_MS="5000"`}
      </pre>

      {/* Grafana Cloud */}
      <h2 className="mt-12 text-xl font-semibold text-zinc-100">
        Grafana Cloud
      </h2>
      <p className="mt-3 text-zinc-400">
        Grafana Cloud accepts OTLP/HTTP data at a per-stack gateway endpoint.
        You need your stack&apos;s instance ID and an API token with the
        &quot;metrics:write&quot; scope.
      </p>
      <h3 className="mt-6 text-lg font-medium text-zinc-200">Steps</h3>
      <ol className="mt-3 list-decimal list-inside space-y-2 text-zinc-400">
        <li>Sign in at <strong className="text-zinc-300">grafana.com</strong> and open your stack</li>
        <li>Go to <strong className="text-zinc-300">My Account &rarr; Access Policies</strong> (left sidebar under Security)</li>
        <li>Click <strong className="text-zinc-300">Create access policy</strong></li>
        <li>Give it a name like &quot;Styrby Metrics&quot;, select the <strong className="text-zinc-300">metrics:write</strong> scope, and choose your Grafana Cloud stack</li>
        <li>Click <strong className="text-zinc-300">Create</strong>, then <strong className="text-zinc-300">Add token</strong></li>
        <li>Copy the token (you will not see it again)</li>
        <li>Note your <strong className="text-zinc-300">Instance ID</strong> (shown at the top of the Access Policies page, or under your stack details)</li>
        <li>Create the Base64 credentials: <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">echo -n &quot;INSTANCE_ID:API_TOKEN&quot; | base64</code></li>
        <li>Find your OTLP gateway zone from your stack URL (e.g., <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">prod-us-east-0</code>)</li>
      </ol>
      <h3 className="mt-6 text-lg font-medium text-zinc-200">
        Environment Variables
      </h3>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-300 border border-zinc-800">
{`export STYRBY_OTEL_ENABLED=true
export STYRBY_OTEL_ENDPOINT="https://otlp-gateway-prod-us-east-0.grafana.net/otlp/v1/metrics"
export STYRBY_OTEL_HEADERS='{"Authorization":"Basic <BASE64_INSTANCE_ID:API_TOKEN>"}'`}
      </pre>
      <p className="mt-3 text-zinc-500 text-sm">
        Replace the zone (<code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">prod-us-east-0</code>) with your
        stack&apos;s zone, and the Base64 string with the value from step 8.
      </p>

      {/* Datadog */}
      <h2 className="mt-12 text-xl font-semibold text-zinc-100">Datadog</h2>
      <p className="mt-3 text-zinc-400">
        Datadog accepts OTLP metrics directly at their intake API. No Datadog
        Agent or Collector required. You need a Datadog API key.
      </p>
      <h3 className="mt-6 text-lg font-medium text-zinc-200">Steps</h3>
      <ol className="mt-3 list-decimal list-inside space-y-2 text-zinc-400">
        <li>Sign in at <strong className="text-zinc-300">app.datadoghq.com</strong></li>
        <li>Go to <strong className="text-zinc-300">Organization Settings &rarr; API Keys</strong> (bottom of the left sidebar)</li>
        <li>Click <strong className="text-zinc-300">New Key</strong>, name it &quot;Styrby Metrics&quot;</li>
        <li>Copy the key value</li>
        <li>Note your Datadog site domain (e.g., <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">datadoghq.com</code> for US1, <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">datadoghq.eu</code> for EU, <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">us3.datadoghq.com</code> for US3, etc.)</li>
      </ol>
      <h3 className="mt-6 text-lg font-medium text-zinc-200">
        Environment Variables
      </h3>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-300 border border-zinc-800">
{`export STYRBY_OTEL_ENABLED=true
export STYRBY_OTEL_ENDPOINT="https://api.datadoghq.com/api/intake/otlp/v1/metrics"
export STYRBY_OTEL_HEADERS='{"DD-API-KEY":"<YOUR_DATADOG_API_KEY>"}'`}
      </pre>
      <p className="mt-3 text-zinc-500 text-sm">
        If your Datadog account is in EU, replace{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">api.datadoghq.com</code> with{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">api.datadoghq.eu</code>. For US3, use{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">api.us3.datadoghq.com</code>. For US5, use{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">api.us5.datadoghq.com</code>.
      </p>

      {/* Honeycomb */}
      <h2 className="mt-12 text-xl font-semibold text-zinc-100">Honeycomb</h2>
      <p className="mt-3 text-zinc-400">
        Honeycomb accepts OTLP metrics natively. You need a Honeycomb Ingest API
        key. Metrics appear under the dataset you specify (or default to
        &quot;styrby-cli&quot;).
      </p>
      <h3 className="mt-6 text-lg font-medium text-zinc-200">Steps</h3>
      <ol className="mt-3 list-decimal list-inside space-y-2 text-zinc-400">
        <li>Sign in at <strong className="text-zinc-300">ui.honeycomb.io</strong></li>
        <li>Click the gear icon in the lower-left corner to open <strong className="text-zinc-300">Environment Settings</strong></li>
        <li>Go to <strong className="text-zinc-300">API Keys</strong></li>
        <li>Click <strong className="text-zinc-300">Create API Key</strong></li>
        <li>Name it &quot;Styrby Metrics&quot; and check <strong className="text-zinc-300">Can create datasets</strong></li>
        <li>Copy the key (you will not see it again after this page)</li>
      </ol>
      <h3 className="mt-6 text-lg font-medium text-zinc-200">
        Environment Variables
      </h3>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-300 border border-zinc-800">
{`export STYRBY_OTEL_ENABLED=true
export STYRBY_OTEL_ENDPOINT="https://api.honeycomb.io/v1/metrics"
export STYRBY_OTEL_HEADERS='{"X-Honeycomb-Team":"<YOUR_API_KEY>"}'`}
      </pre>
      <p className="mt-3 text-zinc-500 text-sm">
        For EU accounts, replace{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">api.honeycomb.io</code> with{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">api.eu1.honeycomb.io</code>.
        To set a custom dataset name, add{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">&quot;X-Honeycomb-Dataset&quot;:&quot;your-dataset&quot;</code>{" "}
        to the headers JSON.
      </p>

      {/* New Relic */}
      <h2 className="mt-12 text-xl font-semibold text-zinc-100">New Relic</h2>
      <p className="mt-3 text-zinc-400">
        New Relic accepts OTLP/HTTP at their dedicated ingest endpoint. You
        need your account&apos;s <strong className="text-zinc-300">license key</strong> (not the
        REST API key or User API key).
      </p>
      <h3 className="mt-6 text-lg font-medium text-zinc-200">Steps</h3>
      <ol className="mt-3 list-decimal list-inside space-y-2 text-zinc-400">
        <li>Sign in at <strong className="text-zinc-300">one.newrelic.com</strong></li>
        <li>Click your account name in the bottom-left corner</li>
        <li>Go to <strong className="text-zinc-300">Administration &rarr; API Keys</strong></li>
        <li>Find your <strong className="text-zinc-300">INGEST - LICENSE</strong> key (or click <strong className="text-zinc-300">Create a key</strong> with type &quot;Ingest - License&quot;)</li>
        <li>Click the three-dot menu next to the key and select <strong className="text-zinc-300">Copy key</strong></li>
      </ol>
      <h3 className="mt-6 text-lg font-medium text-zinc-200">
        Environment Variables
      </h3>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-300 border border-zinc-800">
{`export STYRBY_OTEL_ENABLED=true
export STYRBY_OTEL_ENDPOINT="https://otlp.nr-data.net/v1/metrics"
export STYRBY_OTEL_HEADERS='{"api-key":"<YOUR_LICENSE_KEY>"}'`}
      </pre>
      <p className="mt-3 text-zinc-500 text-sm">
        For EU accounts, replace{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">otlp.nr-data.net</code> with{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">otlp.eu01.nr-data.net</code>.
        Use the <strong>license key</strong> (starts with a long hex string), not the User or REST API key.
      </p>

      {/* Custom endpoint */}
      <h2 className="mt-12 text-xl font-semibold text-zinc-100">
        Custom OTLP Endpoint
      </h2>
      <p className="mt-3 text-zinc-400">
        Any backend that accepts OTLP/HTTP JSON at a{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">/v1/metrics</code>{" "}
        path will work. This includes self-hosted OpenTelemetry Collectors,
        Prometheus with the OTLP receiver, Jaeger, SigNoz, and others.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-300 border border-zinc-800">
{`export STYRBY_OTEL_ENABLED=true
export STYRBY_OTEL_ENDPOINT="https://your-collector:4318/v1/metrics"
export STYRBY_OTEL_HEADERS='{"Authorization":"Bearer your-token"}'`}
      </pre>

      {/* Verification */}
      <h2 className="mt-12 text-xl font-semibold text-zinc-100">
        Verifying the Integration
      </h2>
      <p className="mt-3 text-zinc-400">
        After adding the environment variables to your shell profile:
      </p>
      <ol className="mt-3 list-decimal list-inside space-y-2 text-zinc-400">
        <li>Open a new terminal (or run <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">source ~/.zshrc</code>)</li>
        <li>Start a Styrby session: <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">styrby</code></li>
        <li>Send a prompt, wait for the agent to respond, then stop the session</li>
        <li>Check your observability platform for metrics with <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">service.name = styrby-cli</code></li>
      </ol>
      <p className="mt-3 text-zinc-400">
        If metrics do not appear, check for warnings in the Styrby CLI output.
        The exporter logs connection errors but does not interrupt your session.
        Common issues:
      </p>
      <ul className="mt-3 list-disc list-inside space-y-2 text-zinc-400">
        <li><strong className="text-zinc-300">401 Unauthorized</strong> - Check that your API key or token is correct and has write permissions</li>
        <li><strong className="text-zinc-300">Connection timeout</strong> - Verify the endpoint URL is reachable from your machine. Increase <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">STYRBY_OTEL_TIMEOUT_MS</code> if behind a slow proxy</li>
        <li><strong className="text-zinc-300">No data in dashboard</strong> - It can take 1-2 minutes for metrics to appear. Check that you are looking at the correct service name and time range</li>
      </ul>

      {/* Building dashboards */}
      <h2 className="mt-12 text-xl font-semibold text-zinc-100">
        Building a Dashboard
      </h2>
      <p className="mt-3 text-zinc-400">
        Once metrics are flowing, create a dashboard with panels for:
      </p>
      <ul className="mt-3 list-disc list-inside space-y-2 text-zinc-400">
        <li><strong className="text-zinc-300">Daily AI spend</strong> - Sum of <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">styrby.cost.usd</code> grouped by day</li>
        <li><strong className="text-zinc-300">Token usage by agent</strong> - <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">styrby.tokens.input</code> + <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">styrby.tokens.output</code> grouped by <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">agent</code> attribute</li>
        <li><strong className="text-zinc-300">Session duration trend</strong> - Average of <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">styrby.session.duration_ms</code> over time</li>
        <li><strong className="text-zinc-300">Cache hit ratio</strong> - <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">styrby.tokens.cache_read</code> / (<code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">styrby.tokens.input</code> + <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">styrby.tokens.cache_read</code>)</li>
        <li><strong className="text-zinc-300">Error rate</strong> - <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">styrby.errors.count</code> as a time series, alert when it spikes</li>
      </ul>
      <p className="mt-3 text-zinc-400">
        Set alerts on <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">styrby.cost.usd</code> to get paged
        when daily spend exceeds your threshold. This works alongside
        Styrby&apos;s built-in budget alerts for defense-in-depth cost control.
      </p>

      <PrevNext prev={prev} next={next} />
    </article>
  );
}
