import type { Metadata } from 'next';
import Link from 'next/link';
import { DownloadDpaButton } from './DownloadDpaButton';
import { SUBPROCESSORS } from '@/lib/legal/subprocessors';

export const metadata: Metadata = {
  title: 'Data Processing Agreement',
  description:
    'Styrby DPA for GDPR Article 28 compliance. Covers processor obligations, sub-processors, and data subject rights.',
  openGraph: {
    title: 'Styrby Data Processing Agreement',
    description:
      'Styrby DPA for GDPR Article 28 compliance. Covers processor obligations, sub-processors, and data subject rights.',
    type: 'website',
    url: 'https://styrbyapp.com/dpa',
  },
  robots: {
    index: true,
    follow: true,
  },
};

/**
 * Data Processing Agreement page.
 *
 * WHY: GDPR Article 28 requires a written contract between data controllers
 * (B2B customers, typically on Power tier) and data processors (Styrby).
 * This DPA sets out the obligations of both parties when Styrby processes
 * personal data on behalf of Controller's team members.
 *
 * Key architecture note: session message content is zero-knowledge. Styrby
 * relays encrypted ciphertext only. We cannot access plaintext session content.
 * This materially limits what "processing of personal data" means in practice.
 *
 * PDF download:
 *   The DownloadDpaButton triggers window.print() which opens the browser
 *   print dialog. Users choose "Save as PDF" for a clean single-column PDF.
 *   The @media print style block below hides navigation chrome and the button
 *   itself so the printed output contains only the DPA text.
 *
 *   WHY browser print vs. server PDF generation: zero new dependencies, works
 *   in all browsers, and the existing HTML renders a well-formatted PDF.
 *   See spec Phase 4.4 §4.4 for decision rationale.
 */
export default function DpaPage() {
  return (
    <div className="min-h-[100dvh] bg-zinc-950">
      {/*
       * Print styles — hide non-content chrome when printing to PDF.
       *
       * WHY inline <style>: Tailwind's @media print arbitrary variants are
       * verbose for multi-selector rules. An inline style block is cleaner
       * and guaranteed to load before the user clicks print.
       *
       * Selectors:
       *   header.dpa-header          — site navigation bar (logo + back link)
       *   [data-print-hide]          — the Download PDF button itself
       *   .dpa-related-links         — "Related documents" footer section
       *
       * Link href expansion: makes links readable as text URLs in the PDF,
       * which matters for a legal document where URLs may be referenced.
       */}
      <style>{`
        @media print {
          header.dpa-header,
          [data-print-hide],
          .dpa-related-links {
            display: none !important;
          }
          body {
            margin: 0.5in;
            color: black !important;
            background: white !important;
          }
          .min-h-[100dvh] {
            background: white !important;
          }
          article {
            color: black !important;
          }
          a[href]::after {
            content: " (" attr(href) ")";
            color: #555;
            font-size: 90%;
          }
        }
      `}</style>

      {/* Navigation header */}
      <header className="dpa-header border-b border-zinc-800 bg-zinc-900/50">
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
      <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6 lg:px-8">
        {/* Download PDF button — hidden in print output via data-print-hide */}
        <div className="mb-6 flex justify-end">
          <DownloadDpaButton />
        </div>

        <article className="prose prose-lg prose-invert max-w-none prose-headings:text-zinc-100 prose-p:text-zinc-300 prose-li:text-zinc-300 prose-a:text-orange-400 prose-a:no-underline hover:prose-a:text-orange-300 prose-strong:text-zinc-200">
          <h1>Data Processing Agreement</h1>
          <p className="text-sm text-zinc-500">
            Effective date: March 22, 2026. Last updated: March 22, 2026.
          </p>

          <p>
            This Data Processing Agreement (&quot;DPA&quot;) is between Steel
            Motion LLC, operating as Styrby (&quot;Processor&quot;,
            &quot;we&quot;, &quot;us&quot;), and the entity subscribing to our
            Service (&quot;Controller&quot;, &quot;you&quot;), together the
            &quot;Parties&quot;.
          </p>

          <p>
            This DPA governs the processing of personal data by Styrby when
            providing services to Controller under the{' '}
            <Link href="/terms">Terms of Service</Link>. It supplements,
            and does not replace, the Terms of Service and{' '}
            <Link href="/privacy">Privacy Policy</Link>.
          </p>

          <p>
            <strong>Zero-knowledge note:</strong> The content of AI agent
            sessions (prompts, code, responses) is end-to-end encrypted using
            TweetNaCl public-key authenticated encryption. Styrby relays
            encrypted ciphertext and cannot access plaintext session content.
            The personal data Styrby actually processes is limited to metadata:
            account information, session metadata, token counts, cost records,
            and audit logs.
          </p>

          {/* ── Definitions ──────────────────────────────────── */}
          <h2 className="scroll-mt-20" id="1-definitions">1. Definitions</h2>
          <ul>
            <li>
              <strong>&quot;Personal Data&quot;</strong> means any information
              relating to an identified or identifiable natural person, as
              defined by applicable Data Protection Laws.
            </li>
            <li>
              <strong>&quot;Data Protection Laws&quot;</strong> means the EU
              General Data Protection Regulation (GDPR 2016/679), the UK GDPR,
              the California Consumer Privacy Act (CCPA/CPRA), and any other
              applicable data protection legislation in force.
            </li>
            <li>
              <strong>&quot;Processing&quot;</strong> means any operation
              performed on Personal Data, including collection, storage,
              retrieval, use, disclosure, and deletion.
            </li>
            <li>
              <strong>&quot;Sub-processor&quot;</strong> means any third-party
              engaged by Processor to process Personal Data in connection with
              providing the Service.
            </li>
            <li>
              <strong>&quot;Data Subject&quot;</strong> means an individual
              whose Personal Data is processed under this DPA.
            </li>
          </ul>

          {/* ── Scope ────────────────────────────────────────── */}
          <h2 className="scroll-mt-20" id="2-scope-of-processing">2. Scope of Processing</h2>
          <p>
            Processor processes Personal Data only as necessary to provide the
            Styrby platform services. Processing activities include:
          </p>
          <ul>
            <li>
              Authenticating team members and managing user accounts
            </li>
            <li>
              Relaying AI agent session messages between CLI instances and
              mobile/web clients (as encrypted ciphertext only; Processor
              cannot read plaintext content)
            </li>
            <li>
              Tracking and displaying token usage and associated costs
            </li>
            <li>
              Delivering push notifications and transactional email
              communications
            </li>
            <li>
              Maintaining audit logs for security monitoring and compliance
            </li>
          </ul>

          <h3 className="scroll-mt-20" id="categories-of-data-subjects">Categories of Data Subjects</h3>
          <p>
            Team members and authorized users of Controller&apos;s Styrby
            account.
          </p>

          <h3 className="scroll-mt-20" id="categories-of-personal-data">Categories of Personal Data</h3>
          <p>
            The following categories of personal data are processed. Session
            message content is excluded because Processor cannot access it.
          </p>
          <ul>
            <li>Email addresses and display names</li>
            <li>Authentication provider data (GitHub OAuth profile data, where used)</li>
            <li>Device identifiers and push notification tokens</li>
            <li>IP addresses (captured in server logs and audit logs)</li>
            <li>
              Session metadata: agent type, session start/end times, status,
              and any labels or summaries created by the user
            </li>
            <li>Token usage counts and calculated cost records</li>
            <li>
              Encrypted session message ciphertext: stored and relayed by
              Processor. Processor cannot decrypt or access this content.
            </li>
          </ul>

          <h3 className="scroll-mt-20" id="duration-of-processing">Duration of Processing</h3>
          <p>
            Processor processes Personal Data for the duration of
            Controller&apos;s active subscription. Upon termination, data is
            deleted per Section 8 of this DPA.
          </p>

          {/* ── Obligations ──────────────────────────────────── */}
          <h2 className="scroll-mt-20" id="3-processor-obligations">3. Processor Obligations</h2>
          <p>Processor shall:</p>
          <ul>
            <li>
              Process Personal Data only as necessary to provide the Service,
              as described in this DPA, or as required by applicable law
            </li>
            <li>
              Ensure that all personnel authorized to process Personal Data are
              bound by appropriate confidentiality obligations
            </li>
            <li>
              Implement appropriate technical and organizational security
              measures, including:
              <ul>
                <li>
                  End-to-end encryption of session messages (TweetNaCl
                  public-key authenticated encryption; zero-knowledge
                  architecture)
                </li>
                <li>Encryption at rest (AES-256) and in transit (TLS 1.2+)</li>
                <li>Row Level Security on all database tables</li>
                <li>Rate limiting and input validation on all API endpoints</li>
                <li>
                  Audit logging of security-relevant events (login, machine
                  pairing, data export, API key operations)
                </li>
              </ul>
            </li>
            <li>
              Provide reasonable assistance to Controller in responding to Data
              Subject rights requests (access, rectification, erasure,
              portability, restriction)
            </li>
            <li>
              Notify Controller without undue delay, and in any event within
              72 hours, after becoming aware of a Personal Data breach
              affecting Controller&apos;s data
            </li>
            <li>
              Upon termination, delete or return Personal Data as described in
              Section 8
            </li>
            <li>
              Upon reasonable written request, make available information
              necessary to demonstrate compliance with this DPA
            </li>
          </ul>

          {/* ── Sub-processors ───────────────────────────────── */}
          <h2 className="scroll-mt-20" id="4-sub-processors">4. Sub-processors</h2>
          <p>
            Controller provides general authorization for Processor to engage
            the sub-processors listed below. Processor will notify Controller
            of any intended changes (additions or replacements) to this list
            with reasonable advance notice. Controller may object to a new
            sub-processor on reasonable data protection grounds by contacting
            support@styrby.dev; if the parties cannot resolve the objection,
            Controller may terminate the Service.
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
              {/*
                WHY canonical source: SUBPROCESSORS in lib/legal/subprocessors.ts
                is the single source of truth. /legal/subprocessors and this DPA
                table render from the same array so the lists never drift.
              */}
              {SUBPROCESSORS.map((sp) => (
                <tr key={sp.name}>
                  <td>
                    <a
                      href={sp.website}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {sp.name}
                    </a>
                  </td>
                  <td>{sp.purpose}</td>
                  <td>{sp.location}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* ── Data Subject Rights ──────────────────────────── */}
          <h2 className="scroll-mt-20" id="5-data-subject-rights">5. Data Subject Rights</h2>
          <p>
            Processor provides self-service tools for the following Data
            Subject rights:
          </p>
          <ul>
            <li>
              <strong>Right to access and portability:</strong> Data export
              (JSON) is available at Dashboard, Settings, Export Data.
            </li>
            <li>
              <strong>Right to rectification:</strong> Profile editing is
              available at Dashboard, Settings.
            </li>
            <li>
              <strong>Right to erasure:</strong> Account deletion is available
              at Dashboard, Settings, Delete Account. Personal data is
              permanently deleted within 30 days of deletion request.
            </li>
            <li>
              <strong>Right to restrict processing:</strong> Contact
              support@styrby.dev. We will respond within 30 days.
            </li>
          </ul>
          <p>
            Where Data Subjects contact Processor directly with rights
            requests that should be handled by Controller, Processor will
            forward the request to Controller promptly.
          </p>

          {/* ── Data Breach ──────────────────────────────────── */}
          <h2 className="scroll-mt-20" id="6-data-breach-notification">6. Data Breach Notification</h2>
          <p>
            In the event of a confirmed Personal Data breach, Processor shall:
          </p>
          <ul>
            <li>
              Notify Controller without undue delay and no later than 72 hours
              after becoming aware of the breach
            </li>
            <li>
              Include in the notification: the nature of the breach, categories
              and approximate number of Data Subjects affected, categories and
              approximate volume of records affected, likely consequences of
              the breach, and measures taken or proposed to address it
            </li>
            <li>
              Cooperate with Controller in fulfilling Controller&apos;s
              obligations to notify supervisory authorities and affected Data
              Subjects
            </li>
          </ul>
          <p>
            Send breach notifications to:{' '}
            <strong>support@styrby.dev</strong> (subject line: &quot;Data
            Breach Notification&quot;). For urgent security matters, also
            email <strong>security@styrby.dev</strong>.
          </p>

          {/* ── International Transfers ──────────────────────── */}
          <h2 className="scroll-mt-20" id="7-international-data-transfers">7. International Data Transfers</h2>
          <p>
            Personal Data is primarily processed in the United States by
            Processor and its sub-processors. For transfers from the EU/EEA or
            UK to the United States, Processor relies on:
          </p>
          <ul>
            <li>
              EU-US Data Privacy Framework certification of sub-processors
              where available (Vercel, Supabase are certified)
            </li>
            <li>
              Standard Contractual Clauses (SCCs) as approved by the European
              Commission, for transfers where the Data Privacy Framework does
              not apply
            </li>
          </ul>
          <p>
            Polar, our payment processor, is incorporated in the European
            Union. Payment data processed by Polar does not leave the EU.
          </p>

          {/* ── Term and Termination ─────────────────────────── */}
          <h2 className="scroll-mt-20" id="8-term-and-termination">8. Term and Termination</h2>
          <p>
            This DPA remains in force for the duration of Controller&apos;s
            use of the Service. Upon termination of the Service:
          </p>
          <ul>
            <li>
              Controller may export all data via the self-service export tool
              before account deletion is finalized
            </li>
            <li>
              Processor shall delete Controller&apos;s Personal Data within 30
              days of account deletion, except where retention is required by
              applicable law (for example, financial records required for tax
              compliance)
            </li>
            <li>
              Audit logs are retained for up to 90 days after account deletion
              for security investigation purposes, then permanently deleted
            </li>
            <li>
              Upon written request, Processor will provide written confirmation
              that deletion is complete
            </li>
          </ul>

          {/* ── Contact ──────────────────────────────────────── */}
          <h2 className="scroll-mt-20" id="9-contact">9. Contact</h2>
          <p>
            For questions about this DPA, data rights requests, or to execute
            a signed DPA for enterprise compliance purposes:
          </p>
          <p>
            <strong>Steel Motion LLC</strong>
            <br />
            Email:{' '}
            <a href="mailto:support@styrby.dev">support@styrby.dev</a>
          </p>
          <p>
            To request a countersigned copy of this DPA for your compliance
            records, contact us at the address above.
          </p>

          {/* ── Related ──────────────────────────────────────── */}
          <hr />
          <p className="dpa-related-links text-sm text-zinc-500">
            Related documents:{' '}
            <Link href="/privacy">Privacy Policy</Link>
            {' | '}
            <Link href="/terms">Terms of Service</Link>
            {' | '}
            <Link href="/security">Security</Link>
            {' | '}
            <Link href="/legal/subprocessors">Subprocessors</Link>
          </p>
        </article>
      </main>
    </div>
  );
}
