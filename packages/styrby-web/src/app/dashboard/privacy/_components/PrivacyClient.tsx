'use client';

/**
 * Privacy Control Center Client Component — Orchestrator
 *
 * Composes the three privacy-control sections into a single scrollable panel:
 *   1. RetentionSection     — global auto-delete window
 *   2. ExportSection        — GDPR Art. 15 data portability
 *   3. DeletionSection      — GDPR Art. 17 right to erasure (links to danger zone)
 *
 * WHY an orchestrator: each section owns its own loading/error state and
 * Supabase calls. The orchestrator stays declarative (compose sections in
 * order) and never grows beyond ~80 lines. Future Art. 16 (correction) and
 * Art. 18 (restriction) sections slot in here without touching existing files.
 *
 * @module privacy/PrivacyClient
 */

import { RetentionSection } from './RetentionSection';
import { ExportSection } from './ExportSection';
import { DeletionSection } from './DeletionSection';
import { DataMapSection } from './DataMapSection';
import { EncryptionSection } from './EncryptionSection';

/** Props pre-fetched by the server component. */
export interface PrivacyClientProps {
  /** Current user's Supabase auth ID */
  userId: string;
  /** Current user's email (used for 2-step delete confirmation) */
  userEmail: string;
  /** Current global retention setting — null means "never auto-delete" */
  retentionDays: number | null;
  /** ISO timestamp of the last successful export, or null if never exported */
  lastExportedAt: string | null;
}

/**
 * Privacy Control Center client orchestrator.
 *
 * @param props - Pre-fetched data from the server component
 */
export function PrivacyClient({
  userId,
  userEmail,
  retentionDays,
  lastExportedAt,
}: PrivacyClientProps) {
  return (
    <div className="space-y-8">
      <RetentionSection
        userId={userId}
        initialRetentionDays={retentionDays}
      />
      <ExportSection
        lastExportedAt={lastExportedAt}
      />
      <DataMapSection />
      <EncryptionSection />
      <DeletionSection
        userEmail={userEmail}
      />
    </div>
  );
}
