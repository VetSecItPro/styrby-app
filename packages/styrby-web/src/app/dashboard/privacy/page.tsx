/**
 * Privacy Control Center — Page (Server Component)
 *
 * GDPR Art. 15 (Subject Access Request) and Art. 17 (Right to Erasure)
 * self-serve flows for Styrby users.
 *
 * WHY a dedicated page (not just settings):
 *   Privacy controls deserve first-class real estate, not a buried sub-section.
 *   A dedicated route (/dashboard/privacy) is:
 *     - Directly linkable from the mobile app's Settings > Privacy row
 *     - Easily referenced in our Privacy Policy ("visit your Privacy Center at...")
 *     - Scoped so future GDPR Art. 16 (data correction) and Art. 18 (restriction)
 *       controls can slot in without touching the settings page.
 *
 * Audit standards:
 *   GDPR Art. 15  — Subject Access Request self-service
 *   GDPR Art. 17  — Right to Erasure self-service
 *   GDPR Art. 20  — Data portability (export)
 *   SOC2 CC6.5    — User controls for data management
 */

import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { PrivacyClient } from './_components/PrivacyClient';

export const metadata: Metadata = {
  title: 'Privacy Control Center | Styrby',
  description:
    'Manage your data privacy - export your data, set retention policies, and control how long your sessions are stored.',
};

/**
 * Privacy Control Center server component.
 *
 * Fetches the user's profile (including retention_days) and the last
 * data export request so the client can show "last exported on X".
 *
 * @returns Server-rendered page with pre-fetched privacy data
 */
export default async function PrivacyPage() {
  const supabase = await createClient();

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    redirect('/login');
  }

  // Fetch profile for retention_days setting
  const { data: profile } = await supabase
    .from('profiles')
    .select('retention_days, deleted_at, deletion_scheduled_at')
    .eq('id', user.id)
    .single();

  // Fetch last successful export request for "last exported" display
  const { data: lastExport } = await supabase
    .from('data_export_requests')
    .select('requested_at, status')
    .eq('user_id', user.id)
    .eq('status', 'ready')
    .order('requested_at', { ascending: false })
    .limit(1)
    .single();

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-zinc-100">Privacy Control Center</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Control how your data is stored, exported, and deleted. All operations are
          logged in your audit history.
        </p>
      </div>

      <PrivacyClient
        userId={user.id}
        userEmail={user.email ?? ''}
        retentionDays={profile?.retention_days ?? null}
        lastExportedAt={lastExport?.requested_at ?? null}
      />
    </div>
  );
}
