/**
 * Webhook Documentation Page
 *
 * Provides comprehensive documentation for webhook integration including:
 * - Event payload schemas
 * - Signature verification examples
 * - Best practices
 */

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';

export default async function WebhookDocsPage() {
  const supabase = await createClient();

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    redirect('/login');
  }

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

            <div className="flex items-center gap-4">
              <span className="text-sm text-zinc-400">{user.email}</span>
            </div>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-8">
        {/* Breadcrumb */}
        <div className="flex items-center gap-3 mb-2">
          <Link
            href="/settings"
            className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            Settings
          </Link>
          <span className="text-zinc-500">/</span>
          <Link
            href="/settings/webhooks"
            className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            Webhooks
          </Link>
          <span className="text-zinc-500">/</span>
          <span className="text-sm text-zinc-300">Documentation</span>
        </div>

        <h1 className="text-2xl font-bold text-zinc-100 mb-8">Webhook Documentation</h1>

        <div className="space-y-12">
          {/* Overview */}
          <section>
            <h2 className="text-lg font-semibold text-zinc-100 mb-4">Overview</h2>
            <div className="prose prose-invert max-w-none">
              <p className="text-zinc-400">
                Styrby webhooks allow you to receive real-time notifications when events occur
                in your account. You can use webhooks to integrate Styrby with Slack, Discord,
                custom monitoring systems, or any HTTP endpoint.
              </p>
              <p className="text-zinc-400 mt-3">
                When an event occurs, Styrby sends an HTTP POST request to your configured URL
                with a JSON payload containing event details.
              </p>
            </div>
          </section>

          {/* Event Types */}
          <section>
            <h2 className="text-lg font-semibold text-zinc-100 mb-4">Event Types</h2>
            <div className="space-y-6">
              {/* session.started */}
              <EventDocBlock
                event="session.started"
                description="Triggered when a new agent session begins."
                payload={{
                  event: 'session.started',
                  timestamp: '2025-02-06T10:30:00.000Z',
                  data: {
                    session_id: 'uuid-xxxx-xxxx-xxxx',
                    agent_type: 'claude',
                    model: 'claude-sonnet-4',
                    project_path: '/home/user/my-project',
                    machine_id: 'uuid-machine-id',
                    started_at: '2025-02-06T10:30:00.000Z',
                  },
                }}
              />

              {/* session.completed */}
              <EventDocBlock
                event="session.completed"
                description="Triggered when a session ends (stopped, error, or expired)."
                payload={{
                  event: 'session.completed',
                  timestamp: '2025-02-06T12:45:00.000Z',
                  data: {
                    session_id: 'uuid-xxxx-xxxx-xxxx',
                    agent_type: 'claude',
                    model: 'claude-sonnet-4',
                    status: 'stopped',
                    error_code: null,
                    error_message: null,
                    started_at: '2025-02-06T10:30:00.000Z',
                    ended_at: '2025-02-06T12:45:00.000Z',
                    total_cost_usd: 2.45,
                    total_input_tokens: 150000,
                    total_output_tokens: 25000,
                    message_count: 42,
                  },
                }}
              />

              {/* budget.exceeded */}
              <EventDocBlock
                event="budget.exceeded"
                description="Triggered when a budget alert threshold is crossed."
                payload={{
                  event: 'budget.exceeded',
                  timestamp: '2025-02-06T14:00:00.000Z',
                  data: {
                    alert_id: 'uuid-alert-id',
                    alert_name: 'Daily Claude Limit',
                    current_spend_usd: 10.50,
                    threshold_usd: 10.00,
                    period: 'daily',
                    action: 'notify',
                    percentage_used: 105.00,
                  },
                }}
              />

              {/* permission.requested */}
              <EventDocBlock
                event="permission.requested"
                description="Triggered when an agent requests permission for a sensitive action."
                payload={{
                  event: 'permission.requested',
                  timestamp: '2025-02-06T11:15:00.000Z',
                  data: {
                    session_id: 'uuid-xxxx-xxxx-xxxx',
                    message_id: 'uuid-message-id',
                    agent_type: 'claude',
                    model: 'claude-sonnet-4',
                    project_path: '/home/user/my-project',
                    risk_level: 'high',
                    tool_name: 'bash',
                    created_at: '2025-02-06T11:15:00.000Z',
                  },
                }}
              />
            </div>
          </section>

          {/* Request Headers */}
          <section>
            <h2 className="text-lg font-semibold text-zinc-100 mb-4">Request Headers</h2>
            <div className="rounded-xl bg-zinc-900 border border-zinc-800 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-800">
                    <th className="px-4 py-3 text-left text-zinc-400 font-medium">Header</th>
                    <th className="px-4 py-3 text-left text-zinc-400 font-medium">Description</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  <tr>
                    <td className="px-4 py-3 font-mono text-orange-400">X-Styrby-Signature</td>
                    <td className="px-4 py-3 text-zinc-300">
                      HMAC-SHA256 signature of the payload, prefixed with <code className="bg-zinc-800 px-1 rounded">sha256=</code>
                    </td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 font-mono text-orange-400">X-Styrby-Event</td>
                    <td className="px-4 py-3 text-zinc-300">
                      The event type (e.g., <code className="bg-zinc-800 px-1 rounded">session.started</code>)
                    </td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 font-mono text-orange-400">X-Styrby-Delivery-Id</td>
                    <td className="px-4 py-3 text-zinc-300">Unique identifier for this delivery attempt</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 font-mono text-orange-400">X-Styrby-Timestamp</td>
                    <td className="px-4 py-3 text-zinc-300">Unix timestamp when the request was sent</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 font-mono text-orange-400">Content-Type</td>
                    <td className="px-4 py-3 text-zinc-300">
                      Always <code className="bg-zinc-800 px-1 rounded">application/json</code>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          {/* Signature Verification */}
          <section>
            <h2 className="text-lg font-semibold text-zinc-100 mb-4">Signature Verification</h2>
            <p className="text-zinc-400 mb-4">
              To verify that a webhook request came from Styrby, compute an HMAC-SHA256 signature
              of the raw request body using your webhook secret, and compare it to the signature
              in the <code className="bg-zinc-800 px-1 rounded">X-Styrby-Signature</code> header.
            </p>

            {/* Node.js Example */}
            <div className="mb-6">
              <h3 className="text-sm font-medium text-zinc-300 mb-2">Node.js / Express</h3>
              <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4 overflow-x-auto">
                <pre className="text-sm text-zinc-300 font-mono whitespace-pre">{`import crypto from 'crypto';
import express from 'express';

const app = express();

// Use raw body parser to get the exact payload
app.use('/webhook', express.raw({ type: 'application/json' }));

app.post('/webhook', (req, res) => {
  const signature = req.headers['x-styrby-signature'];
  const secret = process.env.STYRBY_WEBHOOK_SECRET;

  // Compute expected signature
  const expectedSignature = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(req.body)
    .digest('hex');

  // Constant-time comparison to prevent timing attacks
  const isValid = crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );

  if (!isValid) {
    return res.status(401).send('Invalid signature');
  }

  // Parse and process the event
  const event = JSON.parse(req.body);
  console.log('Received event:', event.event);

  res.status(200).send('OK');
});`}</pre>
              </div>
            </div>

            {/* Python Example */}
            <div className="mb-6">
              <h3 className="text-sm font-medium text-zinc-300 mb-2">Python / Flask</h3>
              <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4 overflow-x-auto">
                <pre className="text-sm text-zinc-300 font-mono whitespace-pre">{`import hmac
import hashlib
import os
from flask import Flask, request, abort

app = Flask(__name__)

@app.route('/webhook', methods=['POST'])
def webhook():
    signature = request.headers.get('X-Styrby-Signature')
    secret = os.environ.get('STYRBY_WEBHOOK_SECRET')

    # Compute expected signature
    expected = 'sha256=' + hmac.new(
        secret.encode('utf-8'),
        request.data,
        hashlib.sha256
    ).hexdigest()

    # Constant-time comparison
    if not hmac.compare_digest(signature, expected):
        abort(401, 'Invalid signature')

    # Process the event
    event = request.get_json()
    print(f"Received event: {event['event']}")

    return 'OK', 200`}</pre>
              </div>
            </div>

            {/* Go Example */}
            <div>
              <h3 className="text-sm font-medium text-zinc-300 mb-2">Go</h3>
              <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4 overflow-x-auto">
                <pre className="text-sm text-zinc-300 font-mono whitespace-pre">{`package main

import (
    "crypto/hmac"
    "crypto/sha256"
    "encoding/hex"
    "io"
    "net/http"
    "os"
)

func webhookHandler(w http.ResponseWriter, r *http.Request) {
    signature := r.Header.Get("X-Styrby-Signature")
    secret := os.Getenv("STYRBY_WEBHOOK_SECRET")

    // Read body
    body, _ := io.ReadAll(r.Body)

    // Compute expected signature
    mac := hmac.New(sha256.New, []byte(secret))
    mac.Write(body)
    expected := "sha256=" + hex.EncodeToString(mac.Sum(nil))

    // Constant-time comparison
    if !hmac.Equal([]byte(signature), []byte(expected)) {
        http.Error(w, "Invalid signature", http.StatusUnauthorized)
        return
    }

    // Process event...
    w.WriteHeader(http.StatusOK)
}`}</pre>
              </div>
            </div>
          </section>

          {/* Best Practices */}
          <section>
            <h2 className="text-lg font-semibold text-zinc-100 mb-4">Best Practices</h2>
            <div className="space-y-4">
              <BestPracticeItem
                title="Always verify signatures"
                description="Never trust webhook payloads without verifying the signature. This prevents attackers from spoofing events."
              />
              <BestPracticeItem
                title="Respond quickly"
                description="Return a 2xx response within 30 seconds. Process events asynchronously if needed. Webhook delivery times out after 30 seconds."
              />
              <BestPracticeItem
                title="Handle retries gracefully"
                description="Styrby retries failed deliveries up to 3 times with exponential backoff. Use the X-Styrby-Delivery-Id header to deduplicate events."
              />
              <BestPracticeItem
                title="Use HTTPS endpoints"
                description="Always use HTTPS URLs for production webhooks. HTTP is only allowed for local development."
              />
              <BestPracticeItem
                title="Keep secrets secure"
                description="Store your webhook secret in environment variables. Never commit it to source control or expose it in client-side code."
              />
            </div>
          </section>

          {/* Retry Policy */}
          <section>
            <h2 className="text-lg font-semibold text-zinc-100 mb-4">Retry Policy</h2>
            <p className="text-zinc-400 mb-4">
              If your endpoint returns a non-2xx response or times out, Styrby will retry the delivery:
            </p>
            <ul className="list-disc list-inside text-zinc-400 space-y-2">
              <li>1st retry: 1 minute after initial failure</li>
              <li>2nd retry: 2 minutes after 1st retry</li>
              <li>3rd retry: 4 minutes after 2nd retry</li>
            </ul>
            <p className="text-zinc-400 mt-4">
              After 3 failed retries, the delivery is marked as failed. Webhooks with 10+ consecutive
              failed deliveries are automatically disabled to prevent excessive retries.
            </p>
          </section>

          {/* Back link */}
          <div className="pt-8 border-t border-zinc-800">
            <Link
              href="/settings/webhooks"
              className="text-orange-400 hover:text-orange-300 transition-colors text-sm font-medium"
            >
              Back to Webhooks
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helper Components
// ---------------------------------------------------------------------------

interface EventDocBlockProps {
  event: string;
  description: string;
  payload: Record<string, unknown>;
}

function EventDocBlock({ event, description, payload }: EventDocBlockProps) {
  return (
    <div className="rounded-xl bg-zinc-900 border border-zinc-800 overflow-hidden">
      <div className="px-4 py-3 border-b border-zinc-800">
        <h3 className="text-sm font-semibold text-zinc-100">
          <code className="text-orange-400">{event}</code>
        </h3>
        <p className="text-sm text-zinc-400 mt-1">{description}</p>
      </div>
      <div className="p-4 overflow-x-auto">
        <pre className="text-xs text-zinc-300 font-mono whitespace-pre">
          {JSON.stringify(payload, null, 2)}
        </pre>
      </div>
    </div>
  );
}

interface BestPracticeItemProps {
  title: string;
  description: string;
}

function BestPracticeItem({ title, description }: BestPracticeItemProps) {
  return (
    <div className="rounded-lg bg-zinc-900 border border-zinc-800 p-4">
      <h4 className="text-sm font-medium text-zinc-100 mb-1">{title}</h4>
      <p className="text-sm text-zinc-400">{description}</p>
    </div>
  );
}
