import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Terms of Service',
  description:
    'Terms of Service for Styrby. Covers accounts, billing, acceptable use, data handling, and your rights as a subscriber.',
  openGraph: {
    title: 'Styrby Terms of Service',
    description:
      'Terms of Service for Styrby. Covers accounts, billing, acceptable use, data handling, and your rights as a subscriber.',
    type: 'website',
    url: 'https://styrbyapp.com/terms',
  },
  robots: {
    index: true,
    follow: true,
  },
};

/**
 * Terms of Service page.
 *
 * Covers acceptance, description of service, accounts, billing,
 * acceptable use, IP, limitation of liability, indemnification,
 * termination, governing law, and changes.
 */
export default function TermsOfServicePage() {
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
          <h1>Terms of Service</h1>

          <p className="text-sm text-zinc-500">
            Effective date: March 22, 2026. Last updated: March 22, 2026.
          </p>

          {/* ── 1. Acceptance of Terms ────────────────────────── */}
          <h2>1. Acceptance of Terms</h2>

          <p>
            These Terms of Service (&quot;Terms&quot;) are a binding agreement
            between you (&quot;you&quot; or &quot;User&quot;) and Steel Motion
            LLC (&quot;we,&quot; &quot;our,&quot; or &quot;us&quot;), governing
            your use of the Styrby platform: the website at{' '}
            <a href="https://styrbyapp.com">styrbyapp.com</a>, the Styrby
            mobile app, and the Styrby CLI tool (collectively, the
            &quot;Service&quot;).
          </p>

          <p>
            By creating an account or using the Service, you agree to these
            Terms and our <Link href="/privacy">Privacy Policy</Link>. If you
            do not agree, you may not use the Service.
          </p>

          {/* ── 2. Description of Service ─────────────────────── */}
          <h2>2. What Styrby Does</h2>

          <p>
            Styrby is a remote monitoring and control platform for AI coding
            agents. The Service allows you to:
          </p>
          <ul>
            <li>
              Connect to and control AI coding agents (Claude Code, Codex CLI,
              Gemini CLI) from your mobile device or web browser
            </li>
            <li>
              Monitor active sessions, approve or deny agent permission
              requests, and send messages in real time
            </li>
            <li>
              Track token usage and costs across AI providers, and configure
              budget alerts
            </li>
            <li>
              View session history and bookmarks through the web dashboard
            </li>
          </ul>

          <p>
            <strong>What Styrby is not:</strong> Styrby does not provide the AI
            models themselves. Those are provided by Anthropic, OpenAI, and
            Google. Your use of those AI services is governed by their own
            terms. Styrby acts as a communication bridge between your local CLI
            and your devices. All session content is end-to-end encrypted. We
            do not have access to the plaintext content of your AI sessions.
          </p>

          {/* ── 3. Account Registration ───────────────────────── */}
          <h2>3. Your Account</h2>

          <p>To use Styrby, you must create an account. You agree to:</p>
          <ul>
            <li>
              Provide accurate information during registration and keep it
              current
            </li>
            <li>
              Keep your login credentials secure. You are responsible for all
              activity under your account.
            </li>
            <li>
              Notify us immediately at{' '}
              <a href="mailto:support@styrby.dev">support@styrby.dev</a> if you
              suspect unauthorized access to your account
            </li>
            <li>
              Be responsible for the actions of any team members you invite to
              your account
            </li>
          </ul>

          <p>
            You must be at least 13 years old to create an account. If you are
            under 18, you represent that you have your parent or
            guardian&apos;s consent.
          </p>

          {/* ── 4. Subscription and Billing ───────────────────── */}
          <h2>4. Subscriptions and Billing</h2>

          <p>
            Styrby offers free and paid subscription tiers. Payments are
            processed by our merchant of record,{' '}
            <a
              href="https://polar.sh"
              target="_blank"
              rel="noopener noreferrer"
            >
              Polar
            </a>
            . Current pricing is displayed at{' '}
            <a href="https://styrbyapp.com/#pricing">styrbyapp.com</a>.
          </p>

          <h3>Subscription Tiers</h3>
          <ul>
            <li>
              <strong>Free</strong>: basic session monitoring with 7 days of
              session history
            </li>
            <li>
              <strong>Pro</strong>: full feature access with 90 days of
              session history
            </li>
            <li>
              <strong>Power</strong>: maximum limits with 1 year of session
              history
            </li>
          </ul>

          <h3>Billing Terms</h3>
          <ul>
            <li>
              Paid subscriptions are billed monthly or annually, as selected
              at purchase
            </li>
            <li>
              Subscriptions renew automatically unless you cancel before the
              end of the current billing period
            </li>
            <li>
              You may cancel at any time. Cancellation takes effect at the end
              of the current billing period. You keep access until then.
            </li>
            <li>
              We do not offer pro-rated refunds for unused portions of a
              billing period. Polar&apos;s refund policy applies.
            </li>
            <li>
              We may change pricing with 30 days&apos; notice. Existing
              subscribers will not see a price change until their next renewal
              after the notice period ends.
            </li>
          </ul>

          <h3>AI Provider Costs</h3>
          <p>
            Styrby tracks your AI token usage so you can monitor your spending.
            <strong> The actual costs of AI model usage are charged directly
            by the AI providers</strong> (Anthropic, OpenAI, Google) to your
            account with them. Styrby does not charge for AI model usage and
            is not responsible for costs incurred through those providers.
            You are responsible for your own API keys and the costs they
            generate.
          </p>

          {/* ── 5. Acceptable Use ─────────────────────────────── */}
          <h2>5. Acceptable Use</h2>

          <p>You agree not to use the Service to:</p>
          <ul>
            <li>
              Violate any law, regulation, or third-party rights
            </li>
            <li>
              Attempt to gain unauthorized access to the Service, other
              accounts, or our infrastructure
            </li>
            <li>
              Interfere with or disrupt the performance or integrity of the
              Service
            </li>
            <li>
              Circumvent or attempt to reverse-engineer the end-to-end
              encryption
            </li>
            <li>
              Use the Service to direct AI agents to take actions that violate
              the terms of service of the AI provider (Anthropic, OpenAI,
              Google)
            </li>
            <li>
              Transmit malware, viruses, or other harmful code
            </li>
            <li>
              Facilitate illegal activities, harassment, or the generation of
              illegal content
            </li>
            <li>
              Create multiple accounts to circumvent usage limits or suspensions
            </li>
            <li>
              Resell or sublicense the Service without our written permission
            </li>
          </ul>

          <p>
            We may suspend or terminate your access immediately if we determine
            you have violated these provisions.
          </p>

          {/* ── 6. Intellectual Property ──────────────────────── */}
          <h2>6. Intellectual Property</h2>

          <h3>Our Property</h3>
          <p>
            The Service, including its software, design, branding, and
            documentation, is owned by Steel Motion LLC. All rights not
            expressly granted in these Terms are reserved.
          </p>

          <h3>Your Content</h3>
          <p>
            You retain ownership of all code, data, and content you work with
            through the Service. Because session messages are end-to-end
            encrypted, we cannot access them. By using the Service, you grant
            us only the rights necessary to transmit and store encrypted
            ciphertext on your behalf.
          </p>

          <h3>Feedback</h3>
          <p>
            If you send us feedback or suggestions, you grant us an
            unrestricted, perpetual license to use that feedback for any
            purpose. We will not compensate you for feedback, but we genuinely
            appreciate it.
          </p>

          {/* ── 7. Limitation of Liability ────────────────────── */}
          <h2>7. Limitation of Liability</h2>

          <p>
            <strong>Plain English summary:</strong> Styrby is a monitoring and
            relay tool. We are not responsible for what your AI agents do. We
            are not responsible for costs your AI agents generate with
            third-party providers. We are not responsible for code your AI
            agents write. We are not responsible for downtime from our
            third-party infrastructure providers. Our total liability to you is
            capped at what you paid us in the last 12 months.
          </p>

          <p>
            TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, STEEL MOTION LLC
            AND ITS OFFICERS, DIRECTORS, EMPLOYEES, AND AGENTS SHALL NOT BE
            LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR
            PUNITIVE DAMAGES, INCLUDING BUT NOT LIMITED TO LOSS OF PROFITS,
            DATA, REVENUE, GOODWILL, OR BUSINESS OPPORTUNITY, ARISING OUT OF
            OR RELATED TO YOUR USE OF OR INABILITY TO USE THE SERVICE, EVEN IF
            WE HAVE BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.
          </p>

          <p>
            IN NO EVENT SHALL OUR TOTAL LIABILITY TO YOU FOR ALL CLAIMS ARISING
            OUT OF OR RELATED TO THE SERVICE EXCEED THE GREATER OF (A) THE
            TOTAL FEES YOU HAVE PAID US IN THE TWELVE (12) MONTHS IMMEDIATELY
            PRECEDING THE CLAIM, OR (B) ONE HUNDRED DOLLARS ($100).
          </p>

          <p>
            THE SERVICE IS PROVIDED &quot;AS IS&quot; AND &quot;AS
            AVAILABLE&quot; WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED,
            INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS
            FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. WE DO NOT WARRANT
            THAT THE SERVICE WILL BE UNINTERRUPTED, ERROR-FREE, OR SECURE.
          </p>

          <p>
            Specific exclusions of liability include, without limitation:
          </p>
          <ul>
            <li>
              Actions taken by AI agents running on your infrastructure.
              You are solely responsible for reviewing and approving agent
              actions before they execute.
            </li>
            <li>
              Costs incurred through third-party AI provider APIs (Anthropic,
              OpenAI, Google). We track these costs; we do not control them.
            </li>
            <li>
              Code generated by AI agents. Review all AI-generated code before
              deploying it.
            </li>
            <li>
              Data loss due to the session history retention limits of your
              subscription tier.
            </li>
            <li>
              Service outages caused by our infrastructure providers (Supabase,
              Vercel).
            </li>
          </ul>

          {/* ── 8. Indemnification ────────────────────────────── */}
          <h2>8. Indemnification</h2>

          <p>
            You agree to defend, indemnify, and hold harmless Steel Motion LLC
            and its officers, directors, employees, and agents from any claims,
            damages, losses, and expenses (including reasonable legal fees)
            arising from your use of the Service, your violation of these
            Terms, or your violation of any third-party rights.
          </p>

          {/* ── 9. Termination ────────────────────────────────── */}
          <h2>9. Termination</h2>

          <h3>By You</h3>
          <p>
            You may delete your account at any time via Settings or by
            contacting us at{' '}
            <a href="mailto:support@styrby.dev">support@styrby.dev</a>. On
            deletion:
          </p>
          <ul>
            <li>Your access is revoked immediately</li>
            <li>
              Your data is deleted within 30 days, except as required by law
            </li>
            <li>
              Any active paid subscription continues until the end of the
              current billing period. No refund is issued for the remaining
              period.
            </li>
          </ul>

          <h3>By Us</h3>
          <p>
            We may suspend or terminate your account for the following reasons:
          </p>
          <ul>
            <li>Violation of these Terms</li>
            <li>Fraudulent or illegal activity</li>
            <li>Non-payment of subscription fees</li>
            <li>
              Inactivity for 12 months or more (we will email you before doing
              this)
            </li>
            <li>
              Discontinuation of the Service (we will give at least 30
              days&apos; notice)
            </li>
          </ul>

          <p>
            For serious violations (fraud, illegal activity, ToS abuse), we
            may suspend without notice. For all other reasons, we will provide
            reasonable notice where practicable.
          </p>

          {/* ── 10. Governing Law ─────────────────────────────── */}
          <h2>10. Governing Law</h2>

          <p>
            These Terms are governed by the laws of the State of Texas, United
            States, without regard to conflict of law principles. Any legal
            dispute shall be brought in the state or federal courts located in
            Texas.
          </p>

          {/* ── 11. Changes to Terms ──────────────────────────── */}
          <h2>11. Changes to These Terms</h2>

          <p>
            We may update these Terms. For material changes, we will:
          </p>
          <ul>
            <li>Update the &quot;Last updated&quot; date at the top</li>
            <li>Post the updated Terms on this page</li>
            <li>
              Send you an email notification at least 14 days before the change
              takes effect
            </li>
          </ul>

          <p>
            Continued use of the Service after a change takes effect
            constitutes acceptance of the revised Terms. If you do not agree,
            you must stop using the Service and delete your account before the
            effective date.
          </p>

          {/* ── 12. Contact Information ───────────────────────── */}
          <h2>12. Contact</h2>

          <p>
            Questions about these Terms:
          </p>
          <ul>
            <li>
              <strong>Email:</strong>{' '}
              <a href="mailto:support@styrby.dev">support@styrby.dev</a>
            </li>
            <li>
              <strong>Company:</strong> Steel Motion LLC (veteran-owned)
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
