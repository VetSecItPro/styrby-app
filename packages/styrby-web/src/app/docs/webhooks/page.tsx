import type { Metadata } from "next";
import { PrevNext } from "../prev-next";
import { getPrevNext } from "../nav";
import { CodeBlock } from "@/components/docs/CodeBlock";

export const metadata: Metadata = {
  title: "Webhooks",
  description: "Styrby webhook events, payload format, signature verification, and retry policy.",
};

/**
 * Webhooks documentation page.
 */
export default async function WebhooksPage() {
  const { prev, next } = getPrevNext("/docs/webhooks");

  return (
    <article>
      <h1 className="text-3xl font-bold tracking-tight text-foreground">
        Webhooks
      </h1>
      <p className="mt-3 text-muted-foreground">
        Get HTTP event callbacks when events happen in your Styrby account.
        Available on Pro (3 webhooks) and Power (10 webhooks) tiers. Not
        available on Free.
      </p>

      {/* Available Events */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="available-events">
        Available Events
      </h2>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="pb-2 pr-4 font-medium text-foreground/75">Event</th>
              <th className="pb-2 font-medium text-foreground/75">Fired when</th>
            </tr>
          </thead>
          <tbody className="text-muted-foreground">
            <tr className="border-b border-border/50">
              <td className="py-2 pr-4 font-mono text-xs text-foreground/75">session.started</td>
              <td className="py-2 text-xs">An agent session begins.</td>
            </tr>
            <tr className="border-b border-border/50">
              <td className="py-2 pr-4 font-mono text-xs text-foreground/75">session.completed</td>
              <td className="py-2 text-xs">An agent session transitions to stopped, error, or expired.</td>
            </tr>
            <tr className="border-b border-border/50">
              <td className="py-2 pr-4 font-mono text-xs text-foreground/75">budget.exceeded</td>
              <td className="py-2 text-xs">A budget alert threshold is crossed.</td>
            </tr>
            <tr>
              <td className="py-2 pr-4 font-mono text-xs text-foreground/75">permission.requested</td>
              <td className="py-2 text-xs">An agent requests a tool call that needs approval.</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Setup */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="setting-up-a-webhook">
        Setting Up a Webhook
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Go to Settings &gt; Webhooks in the dashboard. Click &quot;Add
        Endpoint&quot; and provide:
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-6 text-sm text-muted-foreground">
        <li>
          <strong className="text-foreground/75">Name:</strong> A label for this
          webhook (max 100 characters).
        </li>
        <li>
          <strong className="text-foreground/75">URL:</strong> Your HTTPS endpoint.
          Must return 2xx within 30 seconds. Internal IPs, localhost, link-local
          addresses, and cloud metadata services are blocked. DNS rebinding is
          mitigated by re-resolving the hostname before each delivery.
        </li>
        <li>
          <strong className="text-foreground/75">Events:</strong> Select which events
          to subscribe to (at least one required).
        </li>
      </ul>
      <p className="mt-2 text-sm text-muted-foreground">
        After creation, the signing secret is shown once. Store it securely; it
        cannot be retrieved again. If lost, delete and recreate the webhook.
      </p>

      {/* Payload Format */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="payload-format">
        Payload Format
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        All webhook payloads are JSON. The shape of the{" "}
        <code className="rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground/75">data</code>{" "}
        object varies by event type.
      </p>
      <h3 className="mt-4 text-base font-medium text-foreground/90 scroll-mt-20" id="session-started">session.started</h3>
      <CodeBlock
        lang="json"
        code={`{
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
}`}
      />
      <h3 className="mt-4 text-base font-medium text-foreground/90 scroll-mt-20" id="session-completed">session.completed</h3>
      <CodeBlock
        lang="json"
        code={`{
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
}`}
      />
      <h3 className="mt-4 text-base font-medium text-foreground/90 scroll-mt-20" id="budget-exceeded">budget.exceeded</h3>
      <CodeBlock
        lang="json"
        code={`{
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
}`}
      />
      <h3 className="mt-4 text-base font-medium text-foreground/90 scroll-mt-20" id="permission-requested">permission.requested</h3>
      <CodeBlock
        lang="json"
        code={`{
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
}`}
      />

      {/* Request Headers */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="request-headers">
        Request Headers
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Every webhook delivery is a{" "}
        <code className="rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground/75">POST</code>{" "}
        with the following headers. Use them to verify origin, deduplicate, and
        correlate with delivery logs.
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="pb-2 pr-4 font-medium text-foreground/75">Header</th>
              <th className="pb-2 font-medium text-foreground/75">Value</th>
            </tr>
          </thead>
          <tbody className="text-muted-foreground">
            <tr className="border-b border-border/50">
              <td className="py-2 pr-4 font-mono text-xs text-foreground/75">Content-Type</td>
              <td className="py-2 text-xs">application/json</td>
            </tr>
            <tr className="border-b border-border/50">
              <td className="py-2 pr-4 font-mono text-xs text-foreground/75">User-Agent</td>
              <td className="py-2 text-xs">Styrby-Webhook/1.0</td>
            </tr>
            <tr className="border-b border-border/50">
              <td className="py-2 pr-4 font-mono text-xs text-foreground/75">X-Styrby-Signature</td>
              <td className="py-2 text-xs">sha256=&lt;hex HMAC of raw body&gt;</td>
            </tr>
            <tr className="border-b border-border/50">
              <td className="py-2 pr-4 font-mono text-xs text-foreground/75">X-Styrby-Event</td>
              <td className="py-2 text-xs">Event type (e.g. session.completed)</td>
            </tr>
            <tr className="border-b border-border/50">
              <td className="py-2 pr-4 font-mono text-xs text-foreground/75">X-Styrby-Delivery-Id</td>
              <td className="py-2 text-xs">UUID of this delivery attempt; use for idempotency</td>
            </tr>
            <tr>
              <td className="py-2 pr-4 font-mono text-xs text-foreground/75">X-Styrby-Timestamp</td>
              <td className="py-2 text-xs">Unix seconds when the request was sent</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Signature Verification */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="signature-verification">
        Signature Verification
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        The{" "}
        <code className="rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground/75">
          X-Styrby-Signature
        </code>{" "}
        header carries an HMAC-SHA256 of the raw request body, prefixed with
        <code className="ml-1 rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground/75">sha256=</code>.
        Compute the same HMAC with your signing secret and compare with a
        constant-time check. Reject the request if the comparison fails.
      </p>
      <CodeBlock
        lang="typescript"
        code={`import crypto from "crypto";

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
}`}
      />

      {/* Retry Policy */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="retry-policy">
        Retry Policy
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        If your endpoint returns a non-2xx status or times out (30 seconds),
        Styrby retries with exponential backoff (3 total attempts):
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-6 text-sm text-muted-foreground">
        <li>Attempt 1: immediate</li>
        <li>Retry 1: after 1 minute</li>
        <li>Retry 2: after 2 minutes (final attempt)</li>
      </ul>
      <p className="mt-2 text-sm text-muted-foreground">
        After 3 total failed attempts, the delivery is marked as failed. You
        can view delivery history and retry failed events from the webhook
        detail page in Settings &gt; Webhooks.
      </p>

      {/* Idempotency */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="idempotency">
        Idempotency
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Retries reuse the same{" "}
        <code className="rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground/75">
          X-Styrby-Delivery-Id
        </code>
        . Manual retries from the dashboard issue a new delivery row with a new
        ID. Treat the delivery ID as the idempotency key on your end and store
        it for at least the retry window (3 minutes) to drop duplicates safely.
      </p>

      <PrevNext prev={prev} next={next} />
    </article>
  );
}
