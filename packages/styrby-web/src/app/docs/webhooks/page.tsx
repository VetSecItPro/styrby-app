import type { Metadata } from "next";
import { PrevNext } from "../prev-next";
import { getPrevNext } from "../nav";

export const metadata: Metadata = {
  title: "Webhooks",
  description: "Styrby webhook events, payload format, signature verification, and retry policy.",
};

/**
 * Webhooks documentation page.
 */
export default function WebhooksPage() {
  const { prev, next } = getPrevNext("/docs/webhooks");

  return (
    <article>
      <h1 className="text-3xl font-bold tracking-tight text-zinc-50">
        Webhooks
      </h1>
      <p className="mt-3 text-zinc-400">
        Get HTTP event callbacks when events happen in your Styrby account.
        Available on Pro (3 webhooks) and Power (10 webhooks) tiers. Not
        available on Free.
      </p>

      {/* Available Events */}
      <h2 className="mt-10 text-xl font-semibold text-zinc-100">
        Available Events
      </h2>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-left">
              <th className="pb-2 pr-4 font-medium text-zinc-300">Event</th>
              <th className="pb-2 font-medium text-zinc-300">Fired when</th>
            </tr>
          </thead>
          <tbody className="text-zinc-400">
            <tr className="border-b border-zinc-800/50">
              <td className="py-2 pr-4 font-mono text-xs text-zinc-300">session.started</td>
              <td className="py-2 text-xs">An agent session begins.</td>
            </tr>
            <tr className="border-b border-zinc-800/50">
              <td className="py-2 pr-4 font-mono text-xs text-zinc-300">session.completed</td>
              <td className="py-2 text-xs">An agent session transitions to stopped, error, or expired.</td>
            </tr>
            <tr className="border-b border-zinc-800/50">
              <td className="py-2 pr-4 font-mono text-xs text-zinc-300">budget.exceeded</td>
              <td className="py-2 text-xs">A budget alert threshold is crossed.</td>
            </tr>
            <tr>
              <td className="py-2 pr-4 font-mono text-xs text-zinc-300">permission.requested</td>
              <td className="py-2 text-xs">An agent requests a tool call that needs approval.</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Setup */}
      <h2 className="mt-10 text-xl font-semibold text-zinc-100">
        Setting Up a Webhook
      </h2>
      <p className="mt-2 text-sm text-zinc-400">
        Go to Settings &gt; Webhooks in the dashboard. Click &quot;Add
        Endpoint&quot; and provide:
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-6 text-sm text-zinc-400">
        <li>
          <strong className="text-zinc-300">Name:</strong> A label for this
          webhook (max 100 characters).
        </li>
        <li>
          <strong className="text-zinc-300">URL:</strong> Your HTTPS endpoint.
          Must return 2xx within 10 seconds. Internal IPs and localhost are
          blocked.
        </li>
        <li>
          <strong className="text-zinc-300">Events:</strong> Select which events
          to subscribe to (at least one required).
        </li>
      </ul>
      <p className="mt-2 text-sm text-zinc-400">
        After creation, the signing secret is shown once. Store it securely; it
        cannot be retrieved again. If lost, delete and recreate the webhook.
      </p>

      {/* Payload Format */}
      <h2 className="mt-10 text-xl font-semibold text-zinc-100">
        Payload Format
      </h2>
      <p className="mt-2 text-sm text-zinc-400">
        All webhook payloads are JSON. The shape of the{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">data</code>{" "}
        object varies by event type.
      </p>
      <h3 className="mt-4 text-base font-medium text-zinc-200">session.started</h3>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm font-mono text-zinc-300 ring-1 ring-zinc-800">
        <code>{`{
  "event": "session.started",
  "timestamp": "2026-03-22T14:30:00Z",
  "data": {
    "session_id": "ses_8f3k2m9x",
    "agent_type": "claude",
    "model": "claude-sonnet-4-20250514",
    "project_path": "/home/user/my-project",
    "machine_id": "mch_abc123",
    "started_at": "2026-03-22T14:30:00Z"
  }
}`}</code>
      </pre>
      <h3 className="mt-4 text-base font-medium text-zinc-200">session.completed</h3>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm font-mono text-zinc-300 ring-1 ring-zinc-800">
        <code>{`{
  "event": "session.completed",
  "timestamp": "2026-03-22T14:45:12Z",
  "data": {
    "session_id": "ses_8f3k2m9x",
    "agent_type": "claude",
    "model": "claude-sonnet-4-20250514",
    "status": "stopped",
    "started_at": "2026-03-22T14:30:00Z",
    "ended_at": "2026-03-22T14:45:12Z",
    "total_cost_usd": 0.042,
    "total_input_tokens": 12840,
    "total_output_tokens": 3210,
    "message_count": 24
  }
}`}</code>
      </pre>
      <h3 className="mt-4 text-base font-medium text-zinc-200">budget.exceeded</h3>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm font-mono text-zinc-300 ring-1 ring-zinc-800">
        <code>{`{
  "event": "budget.exceeded",
  "timestamp": "2026-03-22T14:45:12Z",
  "data": {
    "alert_id": "bgt_xyz789",
    "alert_name": "Daily $10 limit",
    "current_spend_usd": 10.23,
    "threshold_usd": 10.00,
    "period": "daily",
    "action": "notify",
    "percentage_used": 102.3
  }
}`}</code>
      </pre>
      <h3 className="mt-4 text-base font-medium text-zinc-200">permission.requested</h3>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm font-mono text-zinc-300 ring-1 ring-zinc-800">
        <code>{`{
  "event": "permission.requested",
  "timestamp": "2026-03-22T14:32:00Z",
  "data": {
    "session_id": "ses_8f3k2m9x",
    "message_id": "msg_abc999",
    "agent_type": "claude",
    "model": "claude-sonnet-4-20250514",
    "project_path": "/home/user/my-project",
    "risk_level": "high",
    "tool_name": "Bash",
    "created_at": "2026-03-22T14:32:00Z"
  }
}`}</code>
      </pre>

      {/* Signature Verification */}
      <h2 className="mt-10 text-xl font-semibold text-zinc-100">
        Signature Verification
      </h2>
      <p className="mt-2 text-sm text-zinc-400">
        Every webhook request includes a{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
          X-Styrby-Signature
        </code>{" "}
        header. Verify it using HMAC-SHA256 with your signing secret.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm font-mono text-zinc-300 ring-1 ring-zinc-800">
        <code>{`import crypto from "crypto";

function verifyWebhook(
  payload: string,
  signatureHeader: string,
  secret: string
): boolean {
  // The header is formatted as "sha256=<hex>". Strip the prefix.
  const signature = signatureHeader.replace("sha256=", "");

  const expected = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}

// In your endpoint handler:
const isValid = verifyWebhook(
  rawBody,
  req.headers["x-styrby-signature"],
  process.env.STYRBY_WEBHOOK_SECRET
);

if (!isValid) {
  return res.status(401).json({ error: "Invalid signature" });
}`}</code>
      </pre>

      {/* Retry Policy */}
      <h2 className="mt-10 text-xl font-semibold text-zinc-100">
        Retry Policy
      </h2>
      <p className="mt-2 text-sm text-zinc-400">
        If your endpoint returns a non-2xx status or times out (30 seconds),
        Styrby retries with exponential backoff (3 total attempts):
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-6 text-sm text-zinc-400">
        <li>Attempt 1: immediate</li>
        <li>Retry 1: after 1 minute</li>
        <li>Retry 2: after 2 minutes (final attempt)</li>
      </ul>
      <p className="mt-2 text-sm text-zinc-400">
        After 3 total failed attempts, the delivery is marked as failed. You
        can view delivery history and retry failed events from the webhook
        detail page in Settings &gt; Webhooks.
      </p>

      <PrevNext prev={prev} next={next} />
    </article>
  );
}
