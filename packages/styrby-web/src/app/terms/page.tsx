import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Terms of Service',
  description:
    'Styrby Terms of Service — the rules and guidelines for using the Styrby platform.',
};

/**
 * Terms of Service page.
 *
 * Covers acceptance, description of service, accounts, billing,
 * acceptable use, IP, liability, termination, and changes.
 */
export default function TermsOfServicePage() {
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
          <h1>Terms of Service</h1>

          <p className="text-sm text-zinc-500">
            Last updated: February 5, 2026
          </p>

          {/* ── 1. Acceptance of Terms ────────────────────────── */}
          <h2>1. Acceptance of Terms</h2>

          <p>
            These Terms of Service (&quot;Terms&quot;) constitute a legally
            binding agreement between you (&quot;you&quot; or &quot;User&quot;)
            and Steel Motion LLC (&quot;we,&quot; &quot;our,&quot; or
            &quot;us&quot;), governing your access to and use of the Styrby
            platform, including the website at{' '}
            <a href="https://styrbyapp.com">styrbyapp.com</a>, the Styrby
            mobile application, and the Styrby CLI tool (collectively, the
            &quot;Service&quot;).
          </p>

          <p>
            By creating an account or using the Service, you agree to be bound
            by these Terms and our{' '}
            <Link href="/privacy">Privacy Policy</Link>. If you do not agree to
            these Terms, you may not use the Service.
          </p>

          {/* ── 2. Description of Service ─────────────────────── */}
          <h2>2. Description of Service</h2>

          <p>
            Styrby is a mobile remote control platform for AI coding agents.
            The Service allows users to:
          </p>
          <ul>
            <li>
              Connect to and control AI coding agents (including Claude Code,
              Codex CLI, and Gemini CLI) from a mobile device
            </li>
            <li>
              Monitor and manage active agent sessions in real time
            </li>
            <li>
              Approve or deny agent permission requests remotely
            </li>
            <li>
              Track AI agent usage costs and set budget alerts
            </li>
            <li>
              View session history, bookmarks, and analytics through the web
              dashboard
            </li>
          </ul>

          <p>
            Styrby acts as a communication bridge between your local CLI
            environment and your mobile device. We do not provide the AI models
            themselves; those are provided by their respective vendors (Anthropic,
            OpenAI, Google). Your use of those AI services is subject to their
            respective terms.
          </p>

          {/* ── 3. Account Registration ───────────────────────── */}
          <h2>3. Account Registration</h2>

          <p>To use Styrby, you must create an account. You agree to:</p>
          <ul>
            <li>
              Provide accurate, current, and complete information during
              registration
            </li>
            <li>
              Maintain the security of your account credentials (magic link
              email access, OAuth tokens)
            </li>
            <li>
              Immediately notify us of any unauthorized use of your account
            </li>
            <li>
              Accept responsibility for all activities that occur under your
              account
            </li>
          </ul>

          <p>
            You must be at least 13 years old to create an account. If you are
            under 18, you represent that you have your parent or guardian&apos;s
            consent to use the Service.
          </p>

          <p>
            We reserve the right to suspend or terminate accounts that violate
            these Terms or that we reasonably believe are being used
            fraudulently.
          </p>

          {/* ── 4. Subscription and Billing ───────────────────── */}
          <h2>4. Subscription and Billing</h2>

          <p>
            Styrby offers both free and paid subscription tiers. Paid
            subscriptions are billed through our merchant of record,{' '}
            <a
              href="https://polar.sh"
              target="_blank"
              rel="noopener noreferrer"
            >
              Polar
            </a>
            .
          </p>

          <h3>Subscription Tiers</h3>
          <ul>
            <li>
              <strong>Free</strong> -- limited functionality with basic session
              monitoring
            </li>
            <li>
              <strong>Pro</strong> -- full feature access with higher usage
              limits
            </li>
            <li>
              <strong>Power</strong> -- maximum limits for power users and teams
            </li>
          </ul>

          <h3>Billing Terms</h3>
          <ul>
            <li>
              Paid subscriptions are billed on a monthly or annual basis, as
              selected at the time of purchase
            </li>
            <li>
              Subscriptions automatically renew unless canceled before the end
              of the current billing period
            </li>
            <li>
              You may cancel your subscription at any time; cancellation takes
              effect at the end of the current billing period
            </li>
            <li>
              Refunds are handled in accordance with Polar&apos;s refund policy.
              We do not offer partial refunds for unused portions of a billing
              period
            </li>
            <li>
              We reserve the right to change pricing with 30 days&apos; notice.
              Existing subscribers will be grandfathered at their current price
              until their next renewal after the notice period
            </li>
          </ul>

          <h3>AI Usage Costs</h3>
          <p>
            Styrby tracks your AI agent token usage for cost monitoring purposes
            only. The actual costs of AI model usage are billed directly by the
            respective AI providers (Anthropic, OpenAI, Google) according to
            their pricing. Styrby does not charge for AI model usage.
          </p>

          {/* ── 5. Acceptable Use ─────────────────────────────── */}
          <h2>5. Acceptable Use</h2>

          <p>You agree not to use the Service to:</p>
          <ul>
            <li>
              Violate any applicable law, regulation, or third-party rights
            </li>
            <li>
              Attempt to gain unauthorized access to the Service, other user
              accounts, or related systems
            </li>
            <li>
              Transmit malware, viruses, or other harmful code through the
              Service
            </li>
            <li>
              Interfere with or disrupt the integrity or performance of the
              Service
            </li>
            <li>
              Use the Service to facilitate illegal activities, harassment,
              or the generation of harmful content
            </li>
            <li>
              Reverse engineer, decompile, or disassemble any part of the
              Service, except as permitted by applicable law
            </li>
            <li>
              Resell, sublicense, or redistribute the Service without our
              written permission
            </li>
            <li>
              Create multiple accounts to circumvent usage limits or avoid
              suspension
            </li>
          </ul>

          <p>
            We reserve the right to suspend or terminate your access to the
            Service if we reasonably determine that you have violated these
            acceptable use provisions.
          </p>

          {/* ── 6. Intellectual Property ──────────────────────── */}
          <h2>6. Intellectual Property</h2>

          <h3>Our Intellectual Property</h3>
          <p>
            The Service, including its software, design, branding, documentation,
            and all related intellectual property, is owned by Steel Motion LLC
            and is protected by copyright, trademark, and other intellectual
            property laws. All rights not expressly granted in these Terms are
            reserved.
          </p>

          <h3>Your Content</h3>
          <p>
            You retain ownership of all code, data, and content that you
            transmit through the Service (&quot;Your Content&quot;). By using
            the Service, you grant us a limited, non-exclusive license to
            process Your Content solely for the purpose of providing the
            Service to you.
          </p>

          <p>
            Session messages are end-to-end encrypted. We do not access, read,
            or use the content of your encrypted session messages for any
            purpose other than delivering them to your devices.
          </p>

          <h3>Feedback</h3>
          <p>
            If you provide feedback, suggestions, or ideas about the Service,
            you grant us an unrestricted, irrevocable, perpetual license to use
            that feedback for any purpose without compensation to you.
          </p>

          {/* ── 7. Limitation of Liability ────────────────────── */}
          <h2>7. Limitation of Liability</h2>

          <p>
            TO THE MAXIMUM EXTENT PERMITTED BY LAW, STEEL MOTION LLC AND ITS
            OFFICERS, DIRECTORS, EMPLOYEES, AND AGENTS SHALL NOT BE LIABLE FOR
            ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE
            DAMAGES, INCLUDING BUT NOT LIMITED TO LOSS OF PROFITS, DATA, USE,
            OR GOODWILL, ARISING OUT OF OR RELATED TO YOUR USE OF THE SERVICE.
          </p>

          <p>
            IN NO EVENT SHALL OUR TOTAL LIABILITY TO YOU FOR ALL CLAIMS ARISING
            OUT OF OR RELATED TO THE SERVICE EXCEED THE AMOUNT YOU HAVE PAID US
            IN THE TWELVE (12) MONTHS PRECEDING THE CLAIM, OR ONE HUNDRED
            DOLLARS ($100), WHICHEVER IS GREATER.
          </p>

          <p>
            THE SERVICE IS PROVIDED &quot;AS IS&quot; AND &quot;AS
            AVAILABLE&quot; WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS OR
            IMPLIED, INCLUDING BUT NOT LIMITED TO IMPLIED WARRANTIES OF
            MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND
            NON-INFRINGEMENT.
          </p>

          <p>
            Styrby is a communication tool for AI coding agents. We are not
            responsible for the output, behavior, or actions of AI models
            accessed through the Service. You are solely responsible for
            reviewing and validating any code or changes made by AI agents.
          </p>

          {/* ── 8. Indemnification ────────────────────────────── */}
          <h2>8. Indemnification</h2>

          <p>
            You agree to indemnify, defend, and hold harmless Steel Motion LLC
            and its officers, directors, employees, and agents from and against
            any claims, liabilities, damages, losses, and expenses (including
            reasonable attorney&apos;s fees) arising out of or related to your
            use of the Service, your violation of these Terms, or your violation
            of any third-party rights.
          </p>

          {/* ── 9. Termination ────────────────────────────────── */}
          <h2>9. Termination</h2>

          <p>
            You may terminate your account at any time by contacting us at{' '}
            <a href="mailto:support@styrby.dev">support@styrby.dev</a>. Upon
            termination:
          </p>
          <ul>
            <li>
              Your access to the Service will be immediately revoked
            </li>
            <li>
              Your data will be deleted within 30 days, except as required by
              law
            </li>
            <li>
              Any active paid subscription will continue until the end of the
              current billing period (no refund for the remaining period)
            </li>
          </ul>

          <p>
            We may suspend or terminate your access to the Service at any time,
            with or without cause, with or without notice. Reasons for
            termination may include, but are not limited to:
          </p>
          <ul>
            <li>Violation of these Terms</li>
            <li>Fraudulent or illegal activity</li>
            <li>Non-payment of subscription fees</li>
            <li>Extended period of inactivity (12 months or more)</li>
            <li>Discontinuation of the Service</li>
          </ul>

          {/* ── 10. Governing Law ─────────────────────────────── */}
          <h2>10. Governing Law</h2>

          <p>
            These Terms shall be governed by and construed in accordance with
            the laws of the State of Texas, United States, without regard to
            its conflict of law provisions. Any legal action or proceeding
            arising out of or related to these Terms shall be brought
            exclusively in the state or federal courts located in Texas.
          </p>

          {/* ── 11. Changes to Terms ──────────────────────────── */}
          <h2>11. Changes to Terms</h2>

          <p>
            We reserve the right to modify these Terms at any time. We will
            notify you of material changes by:
          </p>
          <ul>
            <li>Posting the updated Terms on this page</li>
            <li>Updating the &quot;Last updated&quot; date</li>
            <li>
              Sending an email notification for significant changes (at least
              14 days before the changes take effect)
            </li>
          </ul>

          <p>
            Your continued use of the Service after any changes constitutes
            your acceptance of the revised Terms. If you do not agree to the
            updated Terms, you must stop using the Service and delete your
            account.
          </p>

          {/* ── 12. Contact Information ───────────────────────── */}
          <h2>12. Contact Information</h2>

          <p>
            If you have questions about these Terms of Service, please contact
            us:
          </p>
          <ul>
            <li>
              <strong>Email:</strong>{' '}
              <a href="mailto:support@styrby.dev">support@styrby.dev</a>
            </li>
            <li>
              <strong>Company:</strong> Steel Motion LLC
            </li>
            <li>
              <strong>Website:</strong>{' '}
              <a href="https://styrbyapp.com">styrbyapp.com</a>
            </li>
          </ul>
        </article>

        {/* Footer links */}
        <div className="mt-12 pt-8 border-t border-zinc-800 flex items-center justify-between text-sm text-zinc-500">
          <p>&copy; {new Date().getFullYear()} Steel Motion LLC. All rights reserved.</p>
          <div className="flex gap-6">
            <Link
              href="/terms"
              className="text-orange-500"
            >
              Terms of Service
            </Link>
            <Link
              href="/privacy"
              className="hover:text-zinc-100 transition-colors"
            >
              Privacy Policy
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
