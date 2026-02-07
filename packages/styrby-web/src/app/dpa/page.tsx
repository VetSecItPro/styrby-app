import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Data Processing Agreement',
  description:
    'Styrby Data Processing Agreement (DPA) for GDPR compliance — terms governing the processing of personal data.',
};

/**
 * Data Processing Agreement page.
 *
 * WHY: GDPR Article 28 requires a written contract between data controllers
 * (B2B customers on the Power tier) and data processors (Styrby). This DPA
 * sets out the obligations of both parties regarding the processing of
 * personal data.
 */
export default function DpaPage() {
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
              className="text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Back to Home
            </Link>
          </div>
        </div>
      </header>

      {/* DPA content */}
      <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6 lg:px-8">
        <article className="prose prose-invert max-w-none prose-headings:text-zinc-100 prose-p:text-zinc-300 prose-li:text-zinc-300 prose-a:text-orange-400 prose-a:no-underline hover:prose-a:text-orange-300 prose-strong:text-zinc-200">
          <h1>Data Processing Agreement</h1>
          <p className="text-sm text-zinc-500">
            Last updated: February 6, 2026
          </p>

          <p>
            This Data Processing Agreement (&quot;DPA&quot;) forms part of the
            agreement between Steel Motion LLC, operating as Styrby
            (&quot;Processor&quot;, &quot;we&quot;, &quot;us&quot;), and the
            entity subscribing to our Service (&quot;Controller&quot;,
            &quot;you&quot;), collectively the &quot;Parties&quot;.
          </p>

          <p>
            This DPA applies when Styrby processes personal data on behalf of
            Controller in connection with providing the Styrby platform services.
            It supplements our{' '}
            <Link href="/terms">Terms of Service</Link> and{' '}
            <Link href="/privacy">Privacy Policy</Link>.
          </p>

          {/* ── Definitions ──────────────────────────────────── */}
          <h2>1. Definitions</h2>
          <ul>
            <li>
              <strong>&quot;Personal Data&quot;</strong> means any information
              relating to an identified or identifiable natural person as
              defined by applicable Data Protection Laws.
            </li>
            <li>
              <strong>&quot;Data Protection Laws&quot;</strong> means the EU
              General Data Protection Regulation (GDPR), the California Consumer
              Privacy Act (CCPA), and any other applicable data protection
              legislation.
            </li>
            <li>
              <strong>&quot;Processing&quot;</strong> means any operation
              performed on Personal Data, including collection, storage,
              retrieval, use, disclosure, and deletion.
            </li>
            <li>
              <strong>&quot;Sub-processor&quot;</strong> means any third party
              engaged by Processor to process Personal Data on behalf of
              Controller.
            </li>
          </ul>

          {/* ── Scope ────────────────────────────────────────── */}
          <h2>2. Scope of Processing</h2>
          <p>
            Processor shall process Personal Data only as necessary to provide
            the Styrby platform services, which includes:
          </p>
          <ul>
            <li>
              Authenticating team members and managing user accounts
            </li>
            <li>
              Relaying AI agent session messages between CLI instances and
              mobile/web clients
            </li>
            <li>
              Tracking and aggregating token usage and associated costs
            </li>
            <li>
              Delivering push notifications and email communications
            </li>
            <li>
              Maintaining audit logs for security monitoring
            </li>
          </ul>

          <h3>Categories of Data Subjects</h3>
          <p>
            Team members and authorized users of Controller&apos;s Styrby
            account.
          </p>

          <h3>Categories of Personal Data</h3>
          <ul>
            <li>Email addresses and display names</li>
            <li>Authentication provider data (e.g., GitHub OAuth)</li>
            <li>Device identifiers and push notification tokens</li>
            <li>IP addresses (for security and audit purposes)</li>
            <li>Session metadata (agent type, duration, cost, project path)</li>
            <li>
              Encrypted session message content (end-to-end encrypted;
              Processor cannot access plaintext)
            </li>
          </ul>

          {/* ── Obligations ──────────────────────────────────── */}
          <h2>3. Processor Obligations</h2>
          <p>Processor shall:</p>
          <ul>
            <li>
              Process Personal Data only on documented instructions from
              Controller, unless required by law
            </li>
            <li>
              Ensure that persons authorized to process Personal Data have
              committed to confidentiality
            </li>
            <li>
              Implement appropriate technical and organizational security
              measures, including:
              <ul>
                <li>End-to-end encryption of session messages (TweetNaCl)</li>
                <li>Encryption at rest (AES-256) and in transit (TLS 1.2+)</li>
                <li>Row Level Security on all database tables</li>
                <li>Rate limiting and input validation on all API endpoints</li>
                <li>Audit logging of security-relevant events</li>
              </ul>
            </li>
            <li>
              Not engage another processor without prior written authorization
              from Controller (see Sub-processors below)
            </li>
            <li>
              Assist Controller in responding to data subject rights requests
              (access, rectification, erasure, portability)
            </li>
            <li>
              Notify Controller without undue delay (and within 72 hours) after
              becoming aware of a Personal Data breach
            </li>
            <li>
              Delete or return all Personal Data upon termination of services,
              subject to our data retention policy (90-day audit log retention,
              30-day account deletion window)
            </li>
            <li>
              Make available all information necessary to demonstrate compliance
              and allow for audits
            </li>
          </ul>

          {/* ── Sub-processors ───────────────────────────────── */}
          <h2>4. Sub-processors</h2>
          <p>
            Controller authorizes Processor to engage the following
            sub-processors:
          </p>

          <table>
            <thead>
              <tr>
                <th>Sub-processor</th>
                <th>Purpose</th>
                <th>Location</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <a
                    href="https://supabase.com/privacy"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Supabase
                  </a>
                </td>
                <td>Database, authentication, real-time infrastructure</td>
                <td>United States</td>
              </tr>
              <tr>
                <td>
                  <a
                    href="https://polar.sh/legal/privacy"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Polar
                  </a>
                </td>
                <td>Payment processing and subscription management</td>
                <td>European Union</td>
              </tr>
              <tr>
                <td>
                  <a
                    href="https://vercel.com/legal/privacy-policy"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Vercel
                  </a>
                </td>
                <td>Web application hosting and serverless compute</td>
                <td>United States</td>
              </tr>
              <tr>
                <td>
                  <a
                    href="https://resend.com/legal/privacy-policy"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Resend
                  </a>
                </td>
                <td>Transactional email delivery</td>
                <td>United States</td>
              </tr>
              <tr>
                <td>
                  <a
                    href="https://expo.dev/privacy"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Expo
                  </a>
                </td>
                <td>Push notification delivery (mobile)</td>
                <td>United States</td>
              </tr>
            </tbody>
          </table>

          <p>
            Processor shall notify Controller of any intended changes to
            sub-processors, giving Controller the opportunity to object.
          </p>

          {/* ── Data Subject Rights ──────────────────────────── */}
          <h2>5. Data Subject Rights</h2>
          <p>
            Processor provides the following self-service tools for data subject
            rights:
          </p>
          <ul>
            <li>
              <strong>Right to access / portability</strong> — data export
              available at Dashboard &gt; Settings &gt; Export Data (JSON
              download of all 20 user tables)
            </li>
            <li>
              <strong>Right to rectification</strong> — profile editing
              available at Dashboard &gt; Settings
            </li>
            <li>
              <strong>Right to erasure</strong> — account deletion available at
              Dashboard &gt; Settings &gt; Delete Account (30-day recovery
              window, then permanent deletion)
            </li>
            <li>
              <strong>Right to restrict processing</strong> — contact
              support@styrby.dev
            </li>
          </ul>

          {/* ── Data Breach ──────────────────────────────────── */}
          <h2>6. Data Breach Notification</h2>
          <p>
            In the event of a Personal Data breach, Processor shall:
          </p>
          <ul>
            <li>
              Notify Controller without undue delay and no later than 72 hours
              after becoming aware of the breach
            </li>
            <li>
              Provide details of the breach, including: nature and categories
              of data affected, approximate number of data subjects, likely
              consequences, and measures taken to mitigate
            </li>
            <li>
              Cooperate with Controller in fulfilling its obligations to notify
              supervisory authorities and affected data subjects
            </li>
          </ul>
          <p>
            Breach notifications should be directed to: support@styrby.dev
          </p>

          {/* ── International Transfers ──────────────────────── */}
          <h2>7. International Data Transfers</h2>
          <p>
            Personal Data is primarily processed in the United States.
            Processor relies on the following transfer mechanisms:
          </p>
          <ul>
            <li>
              EU-US Data Privacy Framework certification of sub-processors
              where available
            </li>
            <li>
              Standard Contractual Clauses (SCCs) where the Data Privacy
              Framework does not apply
            </li>
          </ul>

          {/* ── Term and Termination ─────────────────────────── */}
          <h2>8. Term and Termination</h2>
          <p>
            This DPA shall remain in effect for the duration of Controller&apos;s
            use of the Service. Upon termination:
          </p>
          <ul>
            <li>
              Controller may export all data via the self-service export tool
              before account deletion
            </li>
            <li>
              Processor shall delete Controller&apos;s Personal Data within 30 days
              of account deletion, except where retention is required by law
            </li>
            <li>
              Audit logs related to Controller&apos;s account shall be retained for
              up to 90 days as stated in our Privacy Policy
            </li>
          </ul>

          {/* ── Contact ──────────────────────────────────────── */}
          <h2>9. Contact</h2>
          <p>
            For questions about this DPA or to exercise any rights under
            applicable Data Protection Laws, contact:
          </p>
          <p>
            <strong>Steel Motion LLC</strong>
            <br />
            Email: support@styrby.dev
          </p>

          {/* ── Related ──────────────────────────────────────── */}
          <hr />
          <p className="text-sm text-zinc-500">
            Related documents:{' '}
            <Link href="/privacy">Privacy Policy</Link>
            {' | '}
            <Link href="/terms">Terms of Service</Link>
          </p>
        </article>
      </main>
    </div>
  );
}
