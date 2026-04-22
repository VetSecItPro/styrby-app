'use client';

/**
 * Data Map Section — Transparent Data Inventory
 *
 * Shows every Styrby database table with:
 *   - What data it stores
 *   - Whether the content is encrypted or plaintext
 *   - Where it is stored (Supabase region)
 *   - How long it is kept
 *
 * WHY static content (not dynamic from schema):
 *   A generator script could introspect the live schema, but that would:
 *     (a) require a DB connection on every page load
 *     (b) expose raw column names that are not user-friendly
 *   The data map is a human-curated, plain-language explanation that tracks
 *   the schema intentionally. Update this when adding tables (migration-driven).
 *
 * This page satisfies GDPR Art. 13/14 (transparency notice) and GDPR Art. 30
 * (record of processing activities) from the user perspective.
 *
 * @module privacy/DataMapSection
 */

import { useState } from 'react';
import { Database, ChevronDown, ChevronRight, Lock, Eye } from 'lucide-react';

/**
 * Represents one row in the data map table.
 */
interface DataMapEntry {
  /** Table name as shown in Postgres */
  table: string;
  /** Human-readable description of what is stored */
  description: string;
  /** Whether the sensitive content fields are E2E encrypted */
  encrypted: boolean;
  /** What is NOT encrypted in this table */
  plaintextFields?: string;
  /** Retention policy (default unless user overrides) */
  retention: string;
  /** Data category for visual grouping */
  category: 'core' | 'sessions' | 'config' | 'billing' | 'features' | 'audit';
}

/** Complete inventory of Styrby tables - keep in sync with migrations. */
const DATA_MAP: DataMapEntry[] = [
  // ── Core ─────────────────────────────────────────────────────────────────
  {
    table: 'profiles',
    description: 'Your account profile: display name, avatar, timezone, language, referral code, GDPR consent timestamps, and onboarding state.',
    encrypted: false,
    plaintextFields: 'All fields are plaintext. No PII beyond display name and avatar URL.',
    retention: 'Kept until account deletion. Soft-deleted for 30-day grace window, then hard-deleted.',
    category: 'core',
  },
  {
    table: 'machines',
    description: 'Registered CLI instances: machine name, platform (macOS/Linux/Windows), hostname, CLI version, last-seen IP address.',
    encrypted: false,
    plaintextFields: 'Machine name, hostname, and last IP are plaintext.',
    retention: 'Deleted when you unpair a machine or delete your account.',
    category: 'core',
  },
  {
    table: 'machine_keys',
    description: 'Public encryption keys for each machine. Used to establish end-to-end encrypted sessions between your phone and CLI.',
    encrypted: false,
    plaintextFields: 'The public key (base64) is stored plaintext - it is designed to be public. The matching private key never leaves your CLI machine.',
    retention: 'Deleted when the parent machine is deleted.',
    category: 'core',
  },
  {
    table: 'device_tokens',
    description: 'Push notification tokens for your mobile devices (APNs/FCM). Used to deliver session alerts and permission requests to your phone.',
    encrypted: false,
    plaintextFields: 'Token value, platform (iOS/Android), device name, and app version are plaintext.',
    retention: 'Deleted on account deletion. Revoked automatically when the device unregisters.',
    category: 'core',
  },
  // ── Sessions ────────────────────────────────────────────────────────────
  {
    table: 'sessions',
    description: 'Metadata for each coding session: title, agent type, model, project path, git branch, status, timing, and cost aggregates.',
    encrypted: false,
    plaintextFields: 'Session metadata (title, path, git info) is plaintext for search and display. Message content is in session_messages (encrypted).',
    retention: 'Per your retention policy (7/30/90/365 days, or never). Individual sessions can be pinned to never-delete.',
    category: 'sessions',
  },
  {
    table: 'session_messages',
    description: 'Every message exchanged in a session: your prompts, agent responses, tool calls, permission requests, and thinking blocks.',
    encrypted: true,
    plaintextFields: 'Message type, token counts, tool name, and timestamps are plaintext. The content itself is encrypted with XChaCha20-Poly1305.',
    retention: 'Deleted with the parent session per your retention policy.',
    category: 'sessions',
  },
  {
    table: 'session_bookmarks',
    description: 'Sessions you have starred for quick access, with optional notes.',
    encrypted: false,
    retention: 'Deleted with the parent session or on account deletion.',
    category: 'sessions',
  },
  {
    table: 'session_checkpoints',
    description: 'Named save-points within sessions, allowing you to mark important moments in a long session.',
    encrypted: false,
    retention: 'Deleted with the parent session.',
    category: 'sessions',
  },
  // ── Config ──────────────────────────────────────────────────────────────
  {
    table: 'agent_configs',
    description: 'Per-agent settings: default model, temperature, custom system prompt, auto-approve rules, blocked tools, and cost limits. BYOK API keys are encrypted.',
    encrypted: true,
    plaintextFields: 'All fields except api_key_encrypted are plaintext. API keys are encrypted at rest.',
    retention: 'Deleted on account deletion.',
    category: 'config',
  },
  {
    table: 'notification_preferences',
    description: 'Your push and email notification preferences: which events trigger alerts, quiet hours settings, and timezone.',
    encrypted: false,
    retention: 'Deleted on account deletion.',
    category: 'config',
  },
  {
    table: 'budget_alerts',
    description: 'Spending thresholds you have configured: alert name, threshold in USD, period (daily/weekly/monthly), and action (notify/slow/stop).',
    encrypted: false,
    retention: 'Deleted on account deletion.',
    category: 'config',
  },
  // ── Billing ─────────────────────────────────────────────────────────────
  {
    table: 'subscriptions',
    description: 'Your Styrby subscription state synced from Polar: tier, status, billing cycle, and payment method last 4 digits.',
    encrypted: false,
    retention: 'Kept for 7 years after cancellation (tax compliance). Anonymised on account deletion.',
    category: 'billing',
  },
  {
    table: 'cost_records',
    description: 'Detailed token usage and cost per session message: input/output/cache tokens, model pricing, and calculated cost in USD.',
    encrypted: false,
    retention: 'Retained per your session retention policy. Aggregates in mv_daily_cost_summary are removed when source records are deleted.',
    category: 'billing',
  },
  // ── Features ────────────────────────────────────────────────────────────
  {
    table: 'prompt_templates',
    description: 'Your custom reusable prompts (system templates are shared across all users and contain no personal data).',
    encrypted: false,
    retention: 'Deleted on account deletion.',
    category: 'features',
  },
  {
    table: 'offline_command_queue',
    description: 'Commands queued on your phone when it was offline, awaiting delivery to your CLI. Commands are encrypted end-to-end.',
    encrypted: true,
    retention: 'Deleted after successful delivery or on account deletion.',
    category: 'features',
  },
  {
    table: 'data_export_requests',
    description: 'A log of your GDPR data export requests: request time, status (ready/failed), and whether a download was completed.',
    encrypted: false,
    retention: 'Retained for 90 days, then automatically expired.',
    category: 'audit',
  },
  // ── Audit ────────────────────────────────────────────────────────────────
  {
    table: 'audit_log',
    description: 'Security and compliance events: logins, machine pairings, session lifecycle, settings changes, data exports, and account deletion requests. Includes IP addresses and user agents.',
    encrypted: false,
    plaintextFields: 'All fields are plaintext. IP addresses and user agents are personal data under GDPR.',
    retention: 'Kept for the life of your account. Deleted with your account data.',
    category: 'audit',
  },
  {
    table: 'user_feedback',
    description: 'In-app NPS ratings and feedback messages you have submitted.',
    encrypted: false,
    retention: 'Kept for 2 years for product analysis. Anonymised on account deletion (user_id set to null).',
    category: 'audit',
  },
];

const CATEGORY_LABELS: Record<DataMapEntry['category'], string> = {
  core: 'Core Account',
  sessions: 'Sessions & Messages',
  config: 'Configuration',
  billing: 'Billing',
  features: 'Features',
  audit: 'Audit & Compliance',
};

/**
 * Renders a single data map row with expand/collapse detail.
 */
function DataMapRow({ entry }: { entry: DataMapEntry }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-b border-zinc-800 last:border-0">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-zinc-800/50 transition-colors"
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-zinc-500 flex-shrink-0" aria-hidden />
        ) : (
          <ChevronRight className="h-4 w-4 text-zinc-500 flex-shrink-0" aria-hidden />
        )}
        <span className="font-mono text-xs text-zinc-300 flex-shrink-0 w-44">{entry.table}</span>
        <span className="text-xs text-zinc-400 flex-1 truncate">{entry.description.split(':')[0]}</span>
        <span
          className={`flex-shrink-0 flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${
            entry.encrypted
              ? 'bg-green-500/10 text-green-400'
              : 'bg-zinc-700 text-zinc-400'
          }`}
          aria-label={entry.encrypted ? 'Content encrypted' : 'Plaintext'}
        >
          {entry.encrypted ? (
            <><Lock className="h-3 w-3" aria-hidden /> Encrypted</>
          ) : (
            <><Eye className="h-3 w-3" aria-hidden /> Plaintext</>
          )}
        </span>
      </button>

      {expanded && (
        <div className="px-11 pb-4 space-y-2">
          <p className="text-xs text-zinc-400">{entry.description}</p>
          {entry.plaintextFields && (
            <p className="text-xs text-zinc-500">
              <span className="text-zinc-400 font-medium">What is not encrypted: </span>
              {entry.plaintextFields}
            </p>
          )}
          <p className="text-xs text-zinc-500">
            <span className="text-zinc-400 font-medium">Retention: </span>
            {entry.retention}
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Renders the full data map grouped by category.
 */
export function DataMapSection() {
  const categories = Object.keys(CATEGORY_LABELS) as DataMapEntry['category'][];

  return (
    <section className="rounded-xl bg-zinc-900 border border-zinc-800">
      <div className="px-6 py-4 border-b border-zinc-800 flex items-center gap-3">
        <Database className="h-4 w-4 text-purple-400" aria-hidden />
        <h2 className="text-base font-semibold text-zinc-100">What We Store</h2>
        <span className="ml-auto text-xs text-zinc-500">GDPR Art. 13/14</span>
      </div>

      <div className="px-6 py-4">
        <p className="text-sm text-zinc-400 mb-4">
          Every table in the Styrby database, explained in plain language. All data is
          stored in Supabase (AWS us-east-1). Click any table to see details.
        </p>
      </div>

      {categories.map((category) => {
        const entries = DATA_MAP.filter((e) => e.category === category);
        if (entries.length === 0) return null;

        return (
          <div key={category} className="border-t border-zinc-800">
            <div className="px-6 py-2 bg-zinc-800/50">
              <p className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
                {CATEGORY_LABELS[category]}
              </p>
            </div>
            {entries.map((entry) => (
              <DataMapRow key={entry.table} entry={entry} />
            ))}
          </div>
        );
      })}
    </section>
  );
}
