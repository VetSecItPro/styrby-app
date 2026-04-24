/**
 * Styrby Subprocessor List
 *
 * Purpose: Typed, canonical list of all third-party subprocessors that handle
 * personal data on behalf of Styrby (Steel Motion LLC) and, by extension, on
 * behalf of our B2B customers acting as data controllers.
 *
 * WHY this file exists:
 *   GDPR Article 28(1) requires that a data processor engage only sub-processors
 *   that offer sufficient guarantees to implement appropriate technical and
 *   organizational measures. Article 28(2) requires prior written authorization
 *   from the controller before engaging a sub-processor, which our DPA implements
 *   via general authorization with notification obligations.
 *
 *   This typed list is the single source of truth. It is rendered at
 *   /legal/subprocessors for public transparency and embedded in the DPA table
 *   at /dpa. Both pages import this module so changes here propagate everywhere.
 *
 * Audit citations:
 *   GDPR Art. 28    — Sub-processor requirements (written contract, adequate guarantees)
 *   GDPR Art. 30    — Records of processing activities (sub-processor registry)
 *   SOC2 CC1.3      — Vendor management and third-party oversight
 *   ISO 27001 A.15  — Supplier relationships: information security in supplier agreements
 *
 * Maintenance: Update this list whenever a sub-processor is added, removed, or
 * their DPF certification status changes. Bump the LAST_UPDATED constant below.
 */

/** Category tags for each sub-processor — used to group and filter. */
export type SubprocessorCategory =
  | 'hosting'
  | 'database'
  | 'auth'
  | 'payment'
  | 'error-tracking'
  | 'email'
  | 'cache'
  | 'analytics';

/**
 * A single third-party sub-processor that processes personal data on behalf
 * of Styrby (Processor) and, transitively, on behalf of B2B Controllers.
 */
export type Subprocessor = {
  /** Display name of the sub-processor. */
  name: string;

  /** What this sub-processor does for Styrby at a high level. */
  purpose: string;

  /**
   * Geographic location where data is primarily processed.
   * Include DPF certification note where applicable.
   */
  location: string;

  /** Public-facing URL (homepage or privacy policy). */
  website: string;

  /**
   * Whether this sub-processor holds EU-US Data Privacy Framework (DPF)
   * certification. Certified = valid transfer mechanism for EU/EEA→US data.
   *
   * WHY we track this: Under Schrems II (C-311/18), each data transfer to
   * a third country needs a valid mechanism. DPF certification is the primary
   * mechanism for US-based sub-processors. Non-certified processors rely on
   * Standard Contractual Clauses (SCCs) or are in the EU.
   */
  dpf_certified: boolean;

  /** Functional categories this sub-processor touches. */
  categories: SubprocessorCategory[];

  /**
   * Description of what personal data (PII, metadata, etc.) flows to
   * this sub-processor during normal Styrby operation.
   */
  data_shared: string;
};

/**
 * Date this list was last audited and updated.
 * Hardcoded for stability — bump this when editing SUBPROCESSORS below.
 *
 * WHY hardcoded vs. git log: git log is unavailable in edge runtimes and
 * CDN-cached pages. A hardcoded date is reliable and forces intentional bumps.
 */
export const SUBPROCESSORS_LAST_UPDATED = '2026-04-24';

/**
 * Canonical list of all Styrby sub-processors.
 *
 * Ordered by: hosting infrastructure first, then services, then ancillary.
 * This mirrors the DPA section 4 table.
 *
 * @see https://styrbyapp.com/dpa Section 4 — Sub-processors
 * @see https://styrbyapp.com/legal/subprocessors (rendered table)
 */
export const SUBPROCESSORS: readonly Subprocessor[] = [
  // ── Infrastructure ──────────────────────────────────────────────────────────
  {
    name: 'Vercel',
    purpose: 'Application hosting + CDN (web dashboard, API routes, edge functions)',
    location: 'United States (EU-US DPF certified)',
    website: 'https://vercel.com/legal/privacy-policy',
    dpf_certified: true,
    categories: ['hosting'],
    data_shared:
      'HTTP request metadata, IP addresses, user-agent strings. No session content or credentials are stored by Vercel.',
  },

  // ── Database / Auth ─────────────────────────────────────────────────────────
  {
    name: 'Supabase',
    purpose: 'Postgres database, authentication, real-time relay, and storage',
    location: 'United States (EU-US DPF certified)',
    website: 'https://supabase.com/privacy',
    dpf_certified: true,
    categories: ['database', 'auth'],
    data_shared:
      'User accounts, session metadata, encrypted message ciphertext (zero-knowledge — Styrby cannot decrypt), subscription state, audit logs, push notification tokens.',
  },

  // ── Payments ────────────────────────────────────────────────────────────────
  {
    name: 'Polar',
    purpose: 'Subscription billing and checkout (merchant of record)',
    location: 'European Union (Germany)',
    website: 'https://polar.sh/legal/privacy',
    dpf_certified: false,
    categories: ['payment'],
    data_shared:
      'Email address, billing address, subscription state. Payment method metadata is stored by Polar — Styrby never receives raw card numbers. Polar is incorporated in the EU; payment data does not leave the EU.',
  },

  // ── Error Tracking ──────────────────────────────────────────────────────────
  {
    name: 'Sentry',
    purpose: 'Error monitoring and performance tracing (web + mobile + CLI)',
    location: 'United States (EU-US DPF certified)',
    website: 'https://sentry.io/privacy/',
    dpf_certified: true,
    categories: ['error-tracking'],
    data_shared:
      'Error stack traces, user ID (hashed), request metadata, performance spans. Session message content and API keys are explicitly excluded from Sentry payloads via beforeSend scrubbing.',
  },

  // ── Email ───────────────────────────────────────────────────────────────────
  {
    name: 'Resend',
    purpose: 'Transactional email delivery (OTP codes, team invitations, alerts)',
    location: 'United States',
    website: 'https://resend.com/legal/privacy-policy',
    dpf_certified: false,
    categories: ['email'],
    data_shared:
      'Recipient email addresses, email subject and body text for transactional notifications only. No session message content is included in emails.',
  },

  // ── Cache / Rate Limiting ───────────────────────────────────────────────────
  {
    name: 'Upstash',
    purpose: 'Redis cache for rate limiting and ephemeral session state',
    location: 'United States (multi-region)',
    website: 'https://upstash.com/trust/privacy.pdf',
    dpf_certified: false,
    categories: ['cache'],
    data_shared:
      'Ephemeral rate-limit keys containing hashed user IDs and IP addresses. Maximum TTL is 60 minutes. No persistent personal data is stored in Upstash.',
  },
] as const;
