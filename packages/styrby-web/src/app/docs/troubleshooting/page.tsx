import type { Metadata } from "next";
import { PrevNext } from "../prev-next";
import { getPrevNext } from "../nav";

export const metadata: Metadata = {
  title: "Troubleshooting",
  description: "Fix common Styrby issues: CLI connection, agent detection, push notifications, and more.",
};

/**
 * Troubleshooting page. Common issues and their solutions.
 */
export default function TroubleshootingPage() {
  const { prev, next } = getPrevNext("/docs/troubleshooting");

  return (
    <article>
      <h1 className="text-3xl font-bold tracking-tight text-zinc-50">
        Troubleshooting
      </h1>
      <p className="mt-3 text-zinc-400">
        Common issues and how to fix them. If your problem is not listed here,
        reach out at{" "}
        <a
          href="mailto:support@styrbyapp.com"
          className="text-amber-500 underline underline-offset-2 hover:text-amber-400"
        >
          support@styrbyapp.com
        </a>.
      </p>

      {/* CLI won't connect */}
      <h2 className="mt-10 text-xl font-semibold text-zinc-100">
        CLI won&apos;t connect
      </h2>
      <p className="mt-2 text-sm text-zinc-400">
        The CLI needs outbound HTTPS (port 443) to styrbyapp.com and
        supabase.co.
      </p>
      <h3 className="mt-4 text-base font-medium text-zinc-200">
        Check connectivity
      </h3>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm font-mono text-zinc-300 ring-1 ring-zinc-800">
        <code>{`curl -I https://styrbyapp.com/api/health
# Should return HTTP 200

curl -I https://supabase.co
# Should return HTTP 200`}</code>
      </pre>

      <h3 className="mt-4 text-base font-medium text-zinc-200">
        Firewall or proxy
      </h3>
      <p className="mt-1 text-sm text-zinc-400">
        If you are behind a corporate firewall or proxy, set the standard proxy
        environment variables:
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm font-mono text-zinc-300 ring-1 ring-zinc-800">
        <code>{`export HTTPS_PROXY=http://proxy.corp.com:8080
export NO_PROXY=localhost,127.0.0.1`}</code>
      </pre>

      <h3 className="mt-4 text-base font-medium text-zinc-200">VPN issues</h3>
      <p className="mt-1 text-sm text-zinc-400">
        Some VPNs intercept WebSocket connections. If{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
          styrby status
        </code>{" "}
        shows &quot;connecting&quot; indefinitely, try disconnecting your VPN
        temporarily to confirm.
      </p>

      {/* Not authenticated */}
      <h2 className="mt-10 text-xl font-semibold text-zinc-100">
        &quot;Not authenticated&quot; error
      </h2>
      <p className="mt-2 text-sm text-zinc-400">
        Run the full setup wizard to authenticate and register your machine:
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm font-mono text-zinc-300 ring-1 ring-zinc-800">
        <code>{`styrby onboard
# Use --force to re-authenticate if already set up
styrby onboard --force`}</code>
      </pre>

      {/* Agent not appearing */}
      <h2 className="mt-10 text-xl font-semibold text-zinc-100">
        Agent not appearing in the dashboard
      </h2>
      <ol className="mt-2 list-decimal space-y-2 pl-6 text-sm text-zinc-400">
        <li>
          Run the health check to see if your agent is detected:{" "}
          <pre className="mt-2 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm font-mono text-zinc-300 ring-1 ring-zinc-800">
            <code>styrby doctor</code>
          </pre>
        </li>
        <li>
          If the agent shows as &quot;not installed&quot;, install it:
          <pre className="mt-2 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm font-mono text-zinc-300 ring-1 ring-zinc-800">
            <code>styrby install claude</code>
          </pre>
        </li>
        <li>
          Confirm the CLI is running and connected:
          <pre className="mt-2 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm font-mono text-zinc-300 ring-1 ring-zinc-800">
            <code>styrby status</code>
          </pre>
        </li>
        <li>
          Start the agent via Styrby (not directly):
          <pre className="mt-2 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm font-mono text-zinc-300 ring-1 ring-zinc-800">
            <code>styrby claude</code>
          </pre>
        </li>
        <li>
          Check CLI logs for errors:
          <pre className="mt-2 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm font-mono text-zinc-300 ring-1 ring-zinc-800">
            <code>{`STYRBY_LOG_LEVEL=debug styrby status`}</code>
          </pre>
        </li>
      </ol>

      {/* Push notifications */}
      <h2 className="mt-10 text-xl font-semibold text-zinc-100">
        Push notifications not working
      </h2>
      <ul className="mt-2 list-disc space-y-2 pl-6 text-sm text-zinc-400">
        <li>
          <strong className="text-zinc-300">Check OS permissions:</strong> Make sure
          the Styrby app has notification permission in your phone&apos;s settings.
        </li>
        <li>
          <strong className="text-zinc-300">Check quiet hours:</strong> Notifications
          are suppressed during quiet hours (except permission requests). Verify
          your quiet hours config in Settings &gt; Notifications.
        </li>
        <li>
          <strong className="text-zinc-300">Token registration:</strong> Force a
          token refresh by signing out of the mobile app and signing back in.
          This re-registers the push token (APNs or FCM).
        </li>
        <li>
          <strong className="text-zinc-300">Check event types:</strong> Make sure
          the specific event type is enabled in your notification preferences.
        </li>
      </ul>

      {/* Cost data delayed */}
      <h2 className="mt-10 text-xl font-semibold text-zinc-100">
        Cost data delayed or missing
      </h2>
      <p className="mt-2 text-sm text-zinc-400">
        The daily cost chart uses a materialized view (
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
          mv_daily_cost_summary
        </code>
        ) that refreshes periodically for performance. If you just finished a
        session:
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-6 text-sm text-zinc-400">
        <li>
          Near real-time cost data appears in session detail views and
          the cost ticker.
        </li>
        <li>
          The daily aggregate chart updates within 5 minutes when the
          materialized view refreshes.
        </li>
        <li>
          If data is still missing after 10 minutes, check your machine
          connection status. Cost records require the CLI to be online to report.
        </li>
      </ul>

      {/* Session replay blank */}
      <h2 className="mt-10 text-xl font-semibold text-zinc-100">
        Session replay shows blank messages
      </h2>
      <p className="mt-2 text-sm text-zinc-400">
        Session messages are end-to-end encrypted. Blank messages mean the
        decryption key on your current device does not match the key used to
        encrypt the session.
      </p>
      <h3 className="mt-4 text-base font-medium text-zinc-200">Common causes</h3>
      <ul className="mt-2 list-disc space-y-1 pl-6 text-sm text-zinc-400">
        <li>
          <strong className="text-zinc-300">Different device:</strong> You are
          viewing from a device that was not paired when the session was
          recorded. Each device has its own keypair.
        </li>
        <li>
          <strong className="text-zinc-300">Re-onboarded:</strong> If you ran{" "}
          <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
            styrby onboard --force
          </code>{" "}
          after the session was recorded, a new keypair was generated. Sessions
          encrypted with the old key are no longer decryptable on this machine.
        </li>
        <li>
          <strong className="text-zinc-300">Cleared config:</strong> If{" "}
          <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
            ~/.styrby/config.json
          </code>{" "}
          was deleted, the private key was lost along with it.
        </li>
      </ul>
      <h3 className="mt-4 text-base font-medium text-zinc-200">Fix</h3>
      <p className="mt-1 text-sm text-zinc-400">
        Open the session from the original machine where the agent ran. That
        machine has the private key in{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
          ~/.styrby/config.json
        </code>{" "}
        and can decrypt the session.
      </p>

      <PrevNext prev={prev} next={next} />
    </article>
  );
}
