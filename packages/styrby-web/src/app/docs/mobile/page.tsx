import type { Metadata } from "next";
import { PrevNext } from "../prev-next";
import { getPrevNext } from "../nav";

export const metadata: Metadata = {
  title: "Mobile App",
  description: "Styrby mobile app: setup, push notifications, offline mode, and permission approvals.",
};

/**
 * Mobile App documentation page.
 */
export default function MobileAppPage() {
  const { prev, next } = getPrevNext("/docs/mobile");

  return (
    <article>
      <h1 className="text-3xl font-bold tracking-tight text-foreground">
        Mobile App
      </h1>
      <p className="mt-3 text-muted-foreground">
        Monitor and control your AI agents from your phone. Available for iOS
        and Android.
      </p>

      {/* Download */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="download-and-setup">
        Download and Setup
      </h2>
      <ul className="mt-2 list-disc space-y-1 pl-6 text-sm text-muted-foreground">
        <li>
          <strong className="text-foreground/75">iOS:</strong> App Store, search
          &quot;Styrby&quot;. Requires iOS 17+.
        </li>
        <li>
          <strong className="text-foreground/75">Android:</strong> Google Play Store,
          search &quot;Styrby&quot;. Requires Android 14+.
        </li>
      </ul>
      <p className="mt-2 text-sm text-muted-foreground">
        Sign in with the same GitHub account you used on the web dashboard.
      </p>

      {/* Pairing */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="pairing-with-your-machine">
        Pairing with Your Machine
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        After signing in, tap &quot;Add Machine&quot; and scan the QR code
        displayed by{" "}
        <code className="rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground/75">
          styrby onboard
        </code>{" "}
        or{" "}
        <code className="rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground/75">
          styrby pair
        </code>{" "}
        in your terminal. The QR code encodes a signed pairing token with an
        expiration time. The app generates its own TweetNaCl keypair for
        decrypting session data on the phone.
      </p>

      {/* Push Notifications */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="push-notifications">
        Push Notifications
      </h2>
      <h3 className="mt-4 text-base font-medium text-foreground/90 scroll-mt-20" id="what-triggers-a-notification">
        What triggers a notification
      </h3>
      <ul className="mt-2 list-disc space-y-1 pl-6 text-sm text-muted-foreground">
        <li>
          <strong className="text-foreground/75">Permission request:</strong> An agent
          needs approval for a tool call.
        </li>
        <li>
          <strong className="text-foreground/75">Session error:</strong> An agent
          session crashed or hit an unrecoverable error.
        </li>
        <li>
          <strong className="text-foreground/75">Budget alert:</strong> A spending
          threshold was reached.
        </li>
        <li>
          <strong className="text-foreground/75">Machine disconnected:</strong> A
          paired machine went offline.
        </li>
      </ul>
      <p className="mt-3 text-sm text-muted-foreground/70">
        Push tokens are registered with APNs (iOS) and FCM (Android). Token
        registration happens automatically on sign-in.
      </p>

      <h3 className="mt-4 text-base font-medium text-foreground/90 scroll-mt-20" id="configuration">
        Configuration
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Fine-tune notifications in the app under Settings &gt; Notifications.
        Toggle each event type on or off. You can also configure these from the
        web dashboard.
      </p>

      {/* Quiet Hours */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="quiet-hours">
        Quiet Hours
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Suppress non-critical notifications during set hours. Permission
        requests are still delivered (they block agent progress), but
        informational alerts like session completions are held until quiet hours
        end.
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        Configure quiet hours in the mobile app under Settings &gt; Notifications
        &gt; Quiet Hours, or from the web dashboard under Settings &gt;
        Notifications.
      </p>

      {/* Offline Mode */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="offline-mode">
        Offline Mode
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        The mobile app works offline using a local SQLite queue. When you
        approve a permission, change a setting, or perform any action while
        offline, the command is queued locally on-device.
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        When connectivity returns, the queue syncs automatically in order.
        A badge shows the number of pending queued commands.
      </p>
      <p className="mt-2 text-sm text-muted-foreground/70">
        Processed commands are also synced to the{" "}
        <code className="rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground/75">
          offline_command_queue
        </code>{" "}
        table in Supabase for audit purposes.
      </p>

      {/* Permission Workflow */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="permission-approval-workflow">
        Permission Approval Workflow
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        When an agent requests a tool call that is not auto-approved:
      </p>
      <ol className="mt-2 list-decimal space-y-2 pl-6 text-sm text-muted-foreground">
        <li>Push notification arrives on your phone.</li>
        <li>
          Tap the notification to see the request detail: tool name, arguments,
          and a description of what it will do.
        </li>
        <li>
          Tap <strong className="text-foreground/75">Approve</strong> or{" "}
          <strong className="text-foreground/75">Deny</strong>.
        </li>
        <li>
          The decision is sent to the CLI in real time via Supabase Realtime.
          The agent continues or retries based on your response.
        </li>
      </ol>
      <p className="mt-3 text-sm text-muted-foreground/70">
        You can also approve or deny from the web dashboard. The first response
        wins; duplicate approvals are ignored.
      </p>

      <PrevNext prev={prev} next={next} />
    </article>
  );
}
