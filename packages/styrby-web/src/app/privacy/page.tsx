import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description:
    'Styrby Privacy Policy — how we collect, use, and protect your data.',
};

/**
 * Privacy Policy page.
 *
 * Outlines data collection, usage, storage, third-party services,
 * retention, and user rights for the Styrby platform.
 */
export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-zinc-950">
      {/* Navigation header */}
      <header className="border-b border-zinc-800 bg-zinc-900/50">
        <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            <Link href="/" className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center">
                <span className="text-lg font-bold text-white">S</span>
              </div>
              <span className="font-semibold text-zinc-100">Styrby</span>
            </Link>
            <Link
              href="/"
              className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
            >
              Back to Home
            </Link>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-12">
        <article className="prose prose-invert prose-zinc max-w-none prose-headings:text-zinc-100 prose-p:text-zinc-300 prose-li:text-zinc-300 prose-a:text-orange-500 prose-a:no-underline hover:prose-a:underline prose-strong:text-zinc-100">
          <h1>Privacy Policy</h1>

          <p className="text-sm text-zinc-500">
            Last updated: February 5, 2026
          </p>

          <p>
            Steel Motion LLC (&quot;we,&quot; &quot;our,&quot; or &quot;us&quot;)
            operates the Styrby platform, including the website at{' '}
            <a href="https://styrbyapp.com">styrbyapp.com</a>, the Styrby mobile
            application, and the Styrby CLI tool (collectively, the
            &quot;Service&quot;). This Privacy Policy explains how we collect,
            use, disclose, and safeguard your information when you use our
            Service.
          </p>

          <p>
            By using Styrby, you agree to the collection and use of information
            in accordance with this policy. If you do not agree with this
            policy, please do not use our Service.
          </p>

          {/* ── Information We Collect ─────────────────────────── */}
          <h2>1. Information We Collect</h2>

          <h3>Account Information</h3>
          <p>
            When you create an account, we collect information that identifies
            you as an individual, including:
          </p>
          <ul>
            <li>
              <strong>Email address</strong> -- used for authentication, account
              recovery, and important service notifications
            </li>
            <li>
              <strong>Display name</strong> -- an optional name you choose to
              identify yourself within the platform
            </li>
            <li>
              <strong>Authentication provider data</strong> -- if you sign in
              via GitHub OAuth, we receive your GitHub profile information
              (username, email, avatar URL) as authorized by you
            </li>
          </ul>

          <h3>Usage Data</h3>
          <p>We automatically collect certain information when you use the Service:</p>
          <ul>
            <li>
              <strong>Session data</strong> -- information about your AI agent
              sessions, including agent type, session duration, message counts,
              and token usage
            </li>
            <li>
              <strong>Cost records</strong> -- token usage and associated costs
              for billing and analytics purposes
            </li>
            <li>
              <strong>Feature usage</strong> -- which features you use and how
              frequently, to help us improve the product
            </li>
          </ul>

          <h3>Device Information</h3>
          <ul>
            <li>
              <strong>Device tokens</strong> -- push notification tokens
              (APNs for iOS, FCM for Android) to deliver real-time
              notifications to your mobile device
            </li>
            <li>
              <strong>Machine identifiers</strong> -- machine registration data
              for CLI instances connected to your account, including hostname,
              platform, and a client-generated fingerprint
            </li>
            <li>
              <strong>IP addresses</strong> -- collected when your CLI connects
              and during security-relevant actions (login, API key operations).
              Used for security monitoring, abuse prevention, and audit logging.
              Retained in accordance with our data retention policy.
            </li>
            <li>
              <strong>Public keys</strong> -- cryptographic public keys used for
              end-to-end encryption of session messages
            </li>
          </ul>

          {/* ── How We Use Your Information ────────────────────── */}
          <h2>2. How We Use Your Information</h2>

          <p>We use the information we collect for the following purposes:</p>
          <ul>
            <li>
              <strong>Providing the Service</strong> -- authenticating your
              account, connecting your mobile device to CLI instances, relaying
              AI agent messages, and enabling session management
            </li>
            <li>
              <strong>Billing and cost tracking</strong> -- calculating and
              displaying your AI agent usage costs, managing subscription tiers,
              and processing payments through our billing provider
            </li>
            <li>
              <strong>Notifications</strong> -- sending push notifications when
              your AI agents need attention, permission approvals, or budget
              alerts
            </li>
            <li>
              <strong>Security</strong> -- detecting and preventing
              unauthorized access, fraud, and abuse
            </li>
            <li>
              <strong>Product improvement</strong> -- understanding how the
              Service is used so we can fix issues and build better features
            </li>
            <li>
              <strong>Communication</strong> -- sending you essential service
              updates, security alerts, and (only with your consent) product
              announcements
            </li>
          </ul>

          {/* ── Data Storage and Security ─────────────────────── */}
          <h2>3. Data Storage and Security</h2>

          <p>
            We take the security of your data seriously and implement
            industry-standard measures to protect it:
          </p>
          <ul>
            <li>
              <strong>End-to-end encryption</strong> -- session messages between
              your CLI and mobile app are encrypted using TweetNaCl
              (public-key authenticated encryption). We cannot read the content
              of your encrypted messages.
            </li>
            <li>
              <strong>Encryption at rest</strong> -- all data stored in our
              database is encrypted at rest using AES-256
            </li>
            <li>
              <strong>Encryption in transit</strong> -- all data transmitted
              between your devices and our servers is encrypted using TLS 1.2 or
              higher
            </li>
            <li>
              <strong>Row Level Security</strong> -- database access is
              restricted so that users can only access their own data
            </li>
            <li>
              <strong>Authentication</strong> -- we use secure, industry-standard
              authentication mechanisms including magic links and OAuth
            </li>
          </ul>

          <p>
            Your data is stored on servers operated by our infrastructure
            provider, Supabase, which maintains SOC 2 Type II compliance. While
            we strive to use commercially acceptable means to protect your
            personal information, no method of electronic storage or
            transmission is 100% secure.
          </p>

          {/* ── Third-Party Services ──────────────────────────── */}
          <h2>4. Third-Party Services</h2>

          <p>
            We use the following third-party services to operate Styrby. Each
            has its own privacy policy governing use of your information:
          </p>
          <ul>
            <li>
              <strong>
                <a
                  href="https://supabase.com/privacy"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Supabase
                </a>
              </strong>{' '}
              -- database, authentication, and real-time infrastructure.
              Stores your account data, session records, and encrypted messages.
            </li>
            <li>
              <strong>
                <a
                  href="https://polar.sh/legal/privacy"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Polar
                </a>
              </strong>{' '}
              -- payment processing and subscription management. Polar acts as
              our merchant of record and handles all payment card data. We do
              not store your payment card information on our servers.
            </li>
            <li>
              <strong>
                <a
                  href="https://expo.dev/privacy"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Expo
                </a>
              </strong>{' '}
              -- push notification delivery for the mobile application.
              Receives your device push token to deliver notifications.
            </li>
            <li>
              <strong>
                <a
                  href="https://vercel.com/legal/privacy-policy"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Vercel
                </a>
              </strong>{' '}
              -- web application hosting. May collect standard web analytics
              data such as IP address and request metadata.
            </li>
            <li>
              <strong>
                <a
                  href="https://resend.com/legal/privacy-policy"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Resend
                </a>
              </strong>{' '}
              -- transactional email delivery. Receives your email address to
              send service communications such as welcome emails, team
              invitations, and security alerts.
            </li>
          </ul>

          <p>
            We do not sell, rent, or share your personal information with third
            parties for their marketing purposes.
          </p>

          {/* ── Data Retention ────────────────────────────────── */}
          <h2>5. Data Retention</h2>

          <p>We retain your information for as long as your account is active:</p>
          <ul>
            <li>
              <strong>Account data</strong> -- retained until you delete your
              account
            </li>
            <li>
              <strong>Session data</strong> -- retained for the lifetime of your
              account; you may delete individual sessions at any time
            </li>
            <li>
              <strong>Cost records</strong> -- retained for the lifetime of your
              account for billing accuracy and dispute resolution
            </li>
            <li>
              <strong>Audit logs</strong> -- retained for 90 days for security
              purposes
            </li>
          </ul>

          <p>
            When you delete your account, we will delete or anonymize your
            personal data within 30 days, except where we are required to retain
            data for legal or regulatory compliance.
          </p>

          {/* ── Your Rights ───────────────────────────────────── */}
          <h2>6. Your Rights</h2>

          <p>You have the following rights regarding your personal data:</p>
          <ul>
            <li>
              <strong>Access</strong> -- you can request a copy of all personal
              data we hold about you
            </li>
            <li>
              <strong>Correction</strong> -- you can update your account
              information at any time through the Settings page
            </li>
            <li>
              <strong>Deletion</strong> -- you can request deletion of your
              account and all associated data by contacting us at{' '}
              <a href="mailto:support@styrby.dev">support@styrby.dev</a>
            </li>
            <li>
              <strong>Export</strong> -- you can request a machine-readable
              export of your data by contacting us at{' '}
              <a href="mailto:support@styrby.dev">support@styrby.dev</a>
            </li>
            <li>
              <strong>Opt-out</strong> -- you can opt out of non-essential
              notifications through the Settings page
            </li>
          </ul>

          <p>
            To exercise any of these rights, please contact us at{' '}
            <a href="mailto:support@styrby.dev">support@styrby.dev</a>. We will
            respond to your request within 30 days.
          </p>

          {/* ── Children's Privacy ────────────────────────────── */}
          <h2>7. Children&apos;s Privacy</h2>

          <p>
            Styrby is not intended for use by anyone under the age of 13. We do
            not knowingly collect personal information from children under 13.
            If we become aware that we have collected personal data from a child
            under 13, we will take steps to delete that information promptly.
          </p>

          {/* ── Changes to This Policy ────────────────────────── */}
          <h2>8. Changes to This Policy</h2>

          <p>
            We may update this Privacy Policy from time to time. We will notify
            you of any material changes by posting the new policy on this page
            and updating the &quot;Last updated&quot; date. For significant
            changes, we will provide additional notice via email or an in-app
            notification.
          </p>

          <p>
            Your continued use of the Service after any changes to this Privacy
            Policy constitutes your acceptance of the updated policy.
          </p>

          {/* ── Contact Information ───────────────────────────── */}
          <h2>9. Contact Information</h2>

          <p>
            If you have questions or concerns about this Privacy Policy or our
            data practices, please contact us:
          </p>
          <ul>
            <li>
              <strong>Email:</strong>{' '}
              <a href="mailto:support@styrby.dev">support@styrby.dev</a>
            </li>
            <li>
              <strong>Company:</strong> Steel Motion LLC
            </li>
          </ul>
        </article>

        {/* Footer links */}
        <div className="mt-12 pt-8 border-t border-zinc-800 flex items-center justify-between text-sm text-zinc-500">
          <p>&copy; {new Date().getFullYear()} Steel Motion LLC. All rights reserved.</p>
          <div className="flex gap-6">
            <Link
              href="/terms"
              className="hover:text-zinc-100 transition-colors"
            >
              Terms of Service
            </Link>
            <Link
              href="/privacy"
              className="text-orange-500"
            >
              Privacy Policy
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
