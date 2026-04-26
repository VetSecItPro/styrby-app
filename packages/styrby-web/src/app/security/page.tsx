import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Security',
  description:
    'How Styrby protects your data: E2E encryption, zero-knowledge architecture, vulnerability disclosure, and incident response.',
  openGraph: {
    title: 'Styrby Security',
    description:
      'How Styrby protects your data: E2E encryption, zero-knowledge architecture, vulnerability disclosure, and incident response.',
    type: 'website',
    url: 'https://styrbyapp.com/security',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Styrby Security',
    description:
      'How Styrby protects your data: E2E encryption, zero-knowledge architecture, vulnerability disclosure, and incident response.',
  },
};

/**
 * Security page.
 *
 * WHY: GDPR Articles 33-34 require breach notification within 72 hours.
 * This page publicly documents our security posture, responsible disclosure
 * process, and how we handle incidents, building trust with users and
 * satisfying compliance requirements for transparency.
 */
export default function SecurityPage() {
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
              className="text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Back to Home
            </Link>
          </div>
        </div>
      </header>

      {/* Security content */}
      <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6 lg:px-8">
        <article className="prose prose-lg prose-invert max-w-none prose-headings:text-zinc-100 prose-p:text-zinc-300 prose-li:text-zinc-300 prose-a:text-orange-400 prose-a:no-underline hover:prose-a:text-orange-300 prose-strong:text-zinc-200">
          <h1>Security</h1>
          <p className="text-sm text-zinc-500">
            Last updated: April 25, 2026
          </p>

          <p>
            Security is foundational to Styrby. We handle sensitive data
            including AI agent session content, cost records, and user
            credentials. This page describes the measures we take to protect
            your data and how we respond to security incidents.
          </p>

          {/* ── Security Measures ─────────────────────────────── */}
          <h2 className="scroll-mt-20" id="security-measures">Security Measures</h2>

          <h3 className="scroll-mt-20" id="encryption">Encryption</h3>
          <ul>
            <li>
              <strong>End-to-end encryption</strong>: session messages between
              your CLI and mobile/web clients are encrypted using TweetNaCl
              (public-key authenticated encryption). Styrby cannot read the
              plaintext content of your encrypted messages.
            </li>
            <li>
              <strong>Encryption at rest</strong>: all data stored in our
              database is encrypted using AES-256.
            </li>
            <li>
              <strong>Encryption in transit</strong>: all connections use TLS
              1.2 or higher. HTTP is automatically redirected to HTTPS.
            </li>
          </ul>

          <h3 className="scroll-mt-20" id="access-control">Access Control</h3>
          <ul>
            <li>
              <strong>Row Level Security (RLS)</strong>: every database table
              has RLS enabled, ensuring users can only access their own data.
            </li>
            <li>
              <strong>Authentication</strong>: we use Supabase Auth with
              secure magic links and OAuth providers (GitHub).
            </li>
            <li>
              <strong>API key hashing</strong>: API keys are hashed with
              bcrypt (cost factor 12) before storage. Plaintext keys are shown
              once on creation and never stored.
            </li>
          </ul>

          <h3 className="scroll-mt-20" id="application-security">Application Security</h3>
          <ul>
            <li>
              <strong>Input validation</strong>: all API endpoints use Zod
              schema validation to prevent injection and malformed input.
            </li>
            <li>
              <strong>Rate limiting</strong>: all write endpoints are rate
              limited to prevent abuse.
            </li>
            <li>
              <strong>Security headers</strong>: Content Security Policy,
              HSTS, X-Frame-Options, and other headers are configured in
              production.
            </li>
            <li>
              <strong>Webhook signatures</strong>: incoming webhooks are
              verified using HMAC-SHA256 with timing-safe comparison.
            </li>
            <li>
              <strong>Audit logging</strong>: security-relevant actions
              (login, machine pairing, API key operations, data export) are
              logged with timestamps and IP addresses.
            </li>
          </ul>

          {/* ── Vulnerability Disclosure ──────────────────────── */}
          <h2 className="scroll-mt-20" id="responsible-disclosure">Responsible Disclosure</h2>
          <p>
            If you discover a security vulnerability in Styrby, we ask that you
            disclose it responsibly:
          </p>
          <ol>
            <li>
              Email <strong>security@styrby.dev</strong> with a description of
              the vulnerability, steps to reproduce, and any proof-of-concept
              code.
            </li>
            <li>
              Allow us reasonable time (up to 90 days) to investigate and
              address the issue before any public disclosure.
            </li>
            <li>
              Do not access, modify, or delete other users&apos; data during
              your research.
            </li>
          </ol>
          <p>
            We commit to acknowledging your report within 48 hours and
            providing regular updates on our progress.
          </p>

          {/* ── Incident Response ─────────────────────────────── */}
          <h2 className="scroll-mt-20" id="incident-response">Incident Response</h2>
          <p>
            In the event of a confirmed security incident or data breach, we
            follow this response plan:
          </p>

          <h3 className="scroll-mt-20" id="1-detection-and-assessment-0-4-hours">1. Detection and Assessment (0-4 hours)</h3>
          <ul>
            <li>Confirm the incident scope, affected systems, and data categories</li>
            <li>Assess severity: critical, high, medium, or low</li>
            <li>Activate incident response team</li>
          </ul>

          <h3 className="scroll-mt-20" id="2-containment-4-24-hours">2. Containment (4-24 hours)</h3>
          <ul>
            <li>Isolate affected systems to prevent further exposure</li>
            <li>Revoke compromised credentials or API keys</li>
            <li>Preserve evidence for investigation</li>
          </ul>

          <h3 className="scroll-mt-20" id="3-notification-within-72-hours">3. Notification (within 72 hours)</h3>
          <ul>
            <li>
              <strong>Supervisory authority</strong>: if the breach is likely
              to result in a risk to individuals, we notify the relevant data
              protection authority within 72 hours of confirmation (GDPR
              Article 33).
            </li>
            <li>
              <strong>Affected users</strong>: if the breach is likely to
              result in a high risk to individuals, we notify affected users
              without undue delay via email (GDPR Article 34). Notifications
              include: nature of the breach, categories of data affected,
              likely consequences, and measures taken.
            </li>
            <li>
              <strong>Team/B2B customers</strong>: Power tier team
              administrators are notified directly per our{' '}
              <Link href="/dpa">Data Processing Agreement</Link>.
            </li>
          </ul>

          <h3 className="scroll-mt-20" id="4-recovery-and-review-1-7-days">4. Recovery and Review (1-7 days)</h3>
          <ul>
            <li>Restore affected systems from verified backups</li>
            <li>Implement fixes to prevent recurrence</li>
            <li>Conduct post-incident review and update security practices</li>
            <li>Publish a post-mortem for significant incidents</li>
          </ul>

          {/* ── Infrastructure ────────────────────────────────── */}
          <h2 className="scroll-mt-20" id="infrastructure">Infrastructure</h2>
          <ul>
            <li>
              <strong>Hosting</strong>: Vercel
            </li>
            <li>
              <strong>Database</strong>: Supabase, with daily backups and
              point-in-time recovery
            </li>
            <li>
              <strong>Email</strong>: Resend, with DKIM, SPF, and DMARC
              configured on our sending domain
            </li>
            <li>
              <strong>Payments</strong>: Polar, as merchant of record. We
              never handle payment card data.
            </li>
          </ul>
          <p className="text-sm text-muted-foreground">
            Each vendor publishes its own security and compliance posture; you
            can verify the current status on their respective trust pages.
          </p>

          {/* ── Contact ──────────────────────────────────────── */}
          <h2 className="scroll-mt-20" id="contact">Contact</h2>
          <p>
            For security concerns:{' '}
            <strong>security@styrby.dev</strong>
          </p>
          <p>
            For general inquiries:{' '}
            <strong>support@styrby.dev</strong>
          </p>

          {/* ── Related ──────────────────────────────────────── */}
          <hr />
          <p className="text-sm text-zinc-500">
            Related documents:{' '}
            <Link href="/privacy">Privacy Policy</Link>
            {' | '}
            <Link href="/terms">Terms of Service</Link>
            {' | '}
            <Link href="/dpa">Data Processing Agreement</Link>
          </p>
        </article>
      </main>
    </div>
  );
}
