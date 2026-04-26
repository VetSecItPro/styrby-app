import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description:
    'How Styrby collects, uses, and protects your data. Session content is zero-knowledge. We cannot read your code or prompts.',
  openGraph: {
    title: 'Styrby Privacy Policy',
    description:
      'How Styrby collects, uses, and protects your data. Session content is zero-knowledge. We cannot read your code or prompts.',
    type: 'website',
    url: 'https://styrbyapp.com/privacy',
  },
  robots: {
    index: true,
    follow: true,
  },
};

/**
 * Privacy Policy page.
 *
 * Outlines data collection, usage, storage, third-party services,
 * retention, cookies, and user rights for the Styrby platform.
 */
export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-[100dvh] bg-zinc-950">
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
      <main className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 py-12">
        <article className="prose prose-lg prose-invert prose-zinc max-w-none prose-headings:text-zinc-100 prose-p:text-zinc-300 prose-li:text-zinc-300 prose-a:text-orange-500 prose-a:no-underline hover:prose-a:underline prose-strong:text-zinc-100">
          <h1>Privacy Policy</h1>

          <p className="text-sm text-zinc-500">
            Effective date: March 22, 2026. Last updated: March 22, 2026.
          </p>

          <p>
            Steel Motion LLC (&quot;we,&quot; &quot;our,&quot; or &quot;us&quot;)
            operates Styrby, including the website at{' '}
            <a href="https://styrbyapp.com">styrbyapp.com</a>, the Styrby mobile
            app, and the Styrby CLI tool (collectively, the &quot;Service&quot;).
            This policy explains what data we collect, why we collect it, and
            how we handle it.
          </p>

          <p>
            By using Styrby, you agree to this policy. If you do not agree,
            please do not use the Service.
          </p>

          {/* ── Zero-Knowledge Architecture ─────────────────────── */}
          <h2 className="scroll-mt-20" id="our-zero-knowledge-architecture">Our Zero-Knowledge Architecture</h2>

          <p>
            Styrby is designed so that we never see the content of your work.
            Session messages (your prompts, code, and AI responses) are
            end-to-end encrypted using TweetNaCl public-key authenticated
            encryption. Your private key never leaves your devices. Our servers
            relay encrypted ciphertext and cannot read the plaintext content of
            your sessions.
          </p>

          <p>
            <strong>What this means in practice:</strong> we process metadata
            (timestamps, token counts, costs, agent type, session status,
            machine identifiers) but we do not process the actual content of
            your AI sessions. That content is yours, encrypted, and invisible
            to us.
          </p>

          {/* ── Information We Collect ─────────────────────────── */}
          <h2 className="scroll-mt-20" id="1-information-we-collect">1. Information We Collect</h2>

          <h3 className="scroll-mt-20" id="account-information">Account Information</h3>
          <p>
            When you create an account, we collect:
          </p>
          <ul>
            <li>
              <strong>Email address</strong>: used for authentication, account
              recovery, and essential service notifications
            </li>
            <li>
              <strong>Display name</strong>: an optional name you choose
            </li>
            <li>
              <strong>GitHub OAuth data</strong>: if you sign in via GitHub,
              we receive your GitHub username, email, and avatar URL as
              authorized by you during the OAuth flow
            </li>
          </ul>

          <h3 className="scroll-mt-20" id="session-metadata">Session Metadata</h3>
          <p>
            We collect metadata about your AI agent sessions. We do not collect
            the content of your sessions (see Zero-Knowledge Architecture
            above).
          </p>
          <ul>
            <li>
              <strong>Session records</strong>: agent type (Claude, Codex,
              Gemini), session start and end times, status, and any tags or
              summaries you create
            </li>
            <li>
              <strong>Token usage and costs</strong>: input tokens, output
              tokens, cache tokens, and calculated cost in USD, used to power
              your cost dashboard and budget alerts
            </li>
            <li>
              <strong>Encrypted message ciphertext</strong>: stored only to
              relay to your authorized devices. We cannot read this content.
            </li>
          </ul>

          <h3 className="scroll-mt-20" id="device-and-machine-information">Device and Machine Information</h3>
          <ul>
            <li>
              <strong>Machine identifiers</strong>: an anonymized identifier
              and display name for each CLI instance you register
            </li>
            <li>
              <strong>Public keys</strong>: cryptographic public keys used for
              end-to-end encryption. Private keys never leave your devices.
            </li>
            <li>
              <strong>Push notification tokens</strong>: APNs (iOS) or FCM
              (Android) tokens used to deliver real-time alerts to your mobile
              device
            </li>
          </ul>

          <h3 className="scroll-mt-20" id="configuration-data">Configuration Data</h3>
          <ul>
            <li>
              <strong>Agent configurations</strong>: your per-agent settings,
              auto-approve rules, and blocked tool lists
            </li>
            <li>
              <strong>Budget alerts</strong>: your spending thresholds and
              chosen actions
            </li>
            <li>
              <strong>Notification preferences</strong>: your push and email
              notification settings
            </li>
          </ul>

          <h3 className="scroll-mt-20" id="what-we-do-not-collect">What We Do Not Collect</h3>
          <ul>
            <li>
              We do not use analytics services (no Mixpanel, Amplitude,
              Segment, Google Analytics, or similar). We do not track your
              behavior across the app.
            </li>
            <li>
              We do not collect your AI API keys or credentials. You configure
              those directly with the AI provider on your local machine.
            </li>
            <li>
              We do not collect the plaintext content of your AI sessions.
            </li>
          </ul>

          {/* ── How We Use Your Information ────────────────────── */}
          <h2 className="scroll-mt-20" id="2-how-we-use-your-information">2. How We Use Your Information</h2>

          <ul>
            <li>
              <strong>Providing the Service</strong>: authenticating your
              account, connecting your mobile device to CLI instances, relaying
              encrypted messages, and enabling session management
            </li>
            <li>
              <strong>Cost tracking and billing</strong>: calculating and
              displaying your AI token usage costs, managing your subscription
              tier, and processing payments through Polar
            </li>
            <li>
              <strong>Notifications</strong>: sending push notifications when
              your AI agents need attention, approval, or when budget thresholds
              are reached
            </li>
            <li>
              <strong>Security</strong>: detecting and preventing unauthorized
              access, fraud, and abuse
            </li>
            <li>
              <strong>Service communications</strong>: sending essential
              updates, security alerts, and (only with your consent) product
              announcements
            </li>
          </ul>

          <p>
            We do not use your data to train AI models. We do not sell, rent,
            or share your personal data with third parties for their marketing
            purposes.
          </p>

          {/* ── Cookies ───────────────────────────────────────── */}
          <h2 className="scroll-mt-20" id="3-cookies">3. Cookies</h2>

          <p>
            Styrby uses only two cookies. No tracking cookies. No analytics
            cookies. No third-party advertising cookies.
          </p>

          <ul>
            <li>
              <strong>Authentication cookie</strong>{' '}
              (<code>sb-[ref]-auth-token</code>): set by Supabase Auth when
              you log in. Required for the Service to work. Contains your
              session token, stored as an httpOnly cookie.
            </li>
            <li>
              <strong>Sidebar preference cookie</strong>{' '}
              (<code>sidebar:state</code>): remembers whether your sidebar
              is open or closed. Expires after 7 days. Not required; the Service
              works without it.
            </li>
          </ul>

          <p>
            Because we use only strictly necessary and functional cookies, we
            do not require an opt-in consent gate. We display a notice
            informing you of these cookies when you first visit.
          </p>

          {/* ── Data Storage and Security ─────────────────────── */}
          <h2 className="scroll-mt-20" id="4-data-storage-and-security">4. Data Storage and Security</h2>

          <ul>
            <li>
              <strong>End-to-end encryption</strong>: session message content
              is encrypted on your device before it reaches our servers. We
              relay ciphertext only.
            </li>
            <li>
              <strong>Encryption at rest</strong>: all data stored in our
              database is encrypted at rest (AES-256)
            </li>
            <li>
              <strong>Encryption in transit</strong>: all connections use TLS
              1.2 or higher. HTTP is redirected to HTTPS.
            </li>
            <li>
              <strong>Row Level Security</strong>: database access is
              restricted so each user can only read and write their own data
            </li>
          </ul>

          <p>
            Data is stored on servers operated by Supabase. The web application
            is hosted on Vercel. Both are major US-based platforms; you can
            review their published security posture on their respective trust
            pages. No method of storage or transmission is 100% secure. We
            cannot guarantee absolute security.
          </p>

          {/* ── Third-Party Services ──────────────────────────── */}
          <h2 className="scroll-mt-20" id="5-sub-processors-third-party-services">5. Sub-processors (Third-Party Services)</h2>

          <p>
            We use the following third-party services to operate Styrby. Each
            is bound by its own privacy policy. We do not share your data with
            any other parties.
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
              (United States): database, authentication, and real-time
              infrastructure. Stores your account data, session metadata, and
              encrypted message ciphertext.
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
              (United States): web application hosting. Receives your IP
              address and standard HTTP request metadata as part of serving
              web requests. Vercel does not use this for advertising.
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
              (European Union): payment processing and subscription
              management. Polar is our merchant of record. They handle all
              payment card data. We never store your payment card information.
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
              (United States): transactional email delivery. Receives your
              email address to send service notifications and account emails.
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
              (United States): push notification delivery for the iOS and
              Android apps. Receives your device push token to deliver alerts.
            </li>
            <li>
              <strong>
                <a
                  href="https://sentry.io/privacy/"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Sentry
                </a>
              </strong>{' '}
              (United States): error monitoring and performance tracing.
              Receives error stack traces, hashed user IDs, and request
              metadata. Session message content and API keys are explicitly
              scrubbed before transmission.
            </li>
            <li>
              <strong>
                <a
                  href="https://upstash.com/trust/privacy.pdf"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Upstash
                </a>
              </strong>{' '}
              (United States): Redis cache for rate limiting and ephemeral
              session state. Stores hashed user IDs and IP addresses for at
              most 60 minutes. No persistent personal data.
            </li>
          </ul>

          <p>
            For the canonical, machine-readable list with DPF certification
            status and data categories, see our{' '}
            <Link href="/legal/subprocessors">Subprocessors page</Link>.
          </p>

          {/* ── Data Retention ────────────────────────────────── */}
          <h2 className="scroll-mt-20" id="6-data-retention">6. Data Retention</h2>

          <p>
            We retain data for as long as your account is active, subject to
            the following limits:
          </p>

          <ul>
            <li>
              <strong>Session history</strong>: retained based on your
              subscription tier: 7 days on Free, 90 days on Pro, 1 year on
              Power. Older sessions are automatically deleted.
            </li>
            <li>
              <strong>Cost records</strong>: retained for the lifetime of
              your account for billing accuracy and dispute resolution
            </li>
            <li>
              <strong>Account data</strong>: retained until you delete your
              account
            </li>
            <li>
              <strong>Audit logs</strong>: retained for 90 days for security
              monitoring, then deleted
            </li>
          </ul>

          <p>
            When you delete your account, we delete or anonymize your personal
            data within 30 days, except where we are required to retain it for
            legal compliance (for example, financial records required by tax
            law).
          </p>

          {/* ── Your Rights ───────────────────────────────────── */}
          <h2 className="scroll-mt-20" id="7-your-rights">7. Your Rights</h2>

          <p>
            You have the following rights over your personal data. Most can be
            exercised directly in the app under Settings.
          </p>

          <ul>
            <li>
              <strong>Access</strong>: request a copy of all personal data we
              hold about you
            </li>
            <li>
              <strong>Portability</strong>: export a machine-readable (JSON)
              copy of your data via Settings
            </li>
            <li>
              <strong>Correction</strong>: update your profile information at
              any time via Settings
            </li>
            <li>
              <strong>Deletion (right to be forgotten)</strong>: delete your
              account and all associated data via Settings, or by emailing us.
              Data is permanently deleted within 30 days.
            </li>
            <li>
              <strong>Restrict processing</strong>: request that we limit how
              we use your data by contacting us
            </li>
            <li>
              <strong>Opt-out of marketing</strong>: unsubscribe from
              non-essential emails at any time. Essential service notifications
              cannot be disabled while your account is active.
            </li>
          </ul>

          <h3 className="scroll-mt-20" id="california-residents-ccpa">California Residents (CCPA)</h3>
          <p>
            California residents have additional rights under the CCPA,
            including the right to know what personal information we sell
            (we do not sell personal information) and the right to
            non-discrimination for exercising privacy rights.
          </p>

          <h3 className="scroll-mt-20" id="eu-and-uk-residents-gdpr">EU and UK Residents (GDPR)</h3>
          <p>
            If you are in the EU or UK, our legal basis for processing your
            data is performance of the contract (providing the Service you
            signed up for) and our legitimate interest in preventing fraud and
            maintaining security. You have the right to lodge a complaint with
            your local data protection authority.
          </p>

          <p>
            To exercise any right, contact us at{' '}
            <a href="mailto:support@styrby.dev">support@styrby.dev</a>. We
            respond within 30 days.
          </p>

          {/* ── Children's Privacy ────────────────────────────── */}
          <h2 className="scroll-mt-20" id="8-children-s-privacy">8. Children&apos;s Privacy</h2>

          <p>
            Styrby is not intended for anyone under the age of 13. We do not
            knowingly collect personal data from children under 13. If we learn
            that we have, we will delete it promptly.
          </p>

          {/* ── Changes to This Policy ────────────────────────── */}
          <h2 className="scroll-mt-20" id="9-changes-to-this-policy">9. Changes to This Policy</h2>

          <p>
            We may update this policy. For material changes, we will notify
            you by email at least 14 days before the change takes effect and
            update the &quot;Last updated&quot; date above. Minor clarifications
            may be made without notice.
          </p>

          <p>
            Continued use of the Service after a change takes effect
            constitutes acceptance of the updated policy.
          </p>

          {/* ── Contact Information ───────────────────────────── */}
          <h2 className="scroll-mt-20" id="10-contact">10. Contact</h2>

          <ul>
            <li>
              <strong>Email:</strong>{' '}
              <a href="mailto:support@styrby.dev">support@styrby.dev</a>
            </li>
            <li>
              <strong>Company:</strong> Steel Motion LLC (veteran-owned)
            </li>
          </ul>

          <p>
            For a full breakdown of how we handle data in B2B contexts, see our{' '}
            <Link href="/dpa">Data Processing Agreement</Link>.
          </p>
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
