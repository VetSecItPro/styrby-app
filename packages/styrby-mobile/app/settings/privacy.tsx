/**
 * Privacy Control Center — Mobile Screen (Orchestrator)
 *
 * Self-serve GDPR controls available directly from the mobile app:
 *   1. Session retention policy (global auto-delete window)
 *   2. Data export (GDPR Art. 15 Subject Access Request)
 *   3. Account deletion (GDPR Art. 17 Right to Erasure)
 *   4. Link to web privacy page for encryption details and data map
 *
 * WHY an orchestrator: all heavy UI lives in src/components/privacy/*.
 * This file owns only: data fetching, navigation wiring, and section order.
 * Max ~150 LOC per the orchestrator pattern in CLAUDE.md.
 *
 * Audit standards:
 *   GDPR Art. 15  — Subject Access Request self-service
 *   GDPR Art. 17  — Right to Erasure self-service
 *   GDPR Art. 20  — Data portability (export)
 *   SOC2 CC6.5    — User controls for data management
 *
 * @see packages/styrby-mobile/src/components/privacy/
 */

import { ScrollView, View, Text, ActivityIndicator } from 'react-native';
import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { supabase } from '@/lib/supabase';
import { getApiBaseUrl } from '@/lib/config';
import {
  RetentionPicker,
  MobileExportButton,
  MobileDeleteSection,
  MobilePrivacyLinks,
} from '@/components/privacy';

/**
 * Privacy settings screen orchestrator.
 *
 * @returns React element
 */
export default function PrivacyScreen() {
  const router = useRouter();
  const { user, isLoading } = useCurrentUser();
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [isFetchingRetention, setIsFetchingRetention] = useState(true);

  /**
   * Fetch the current retention policy from the web API.
   *
   * WHY the web API (not direct Supabase query from mobile):
   *   Consistent with the account screen pattern — all sensitive account
   *   operations go through the web API so the service-role key stays
   *   server-side. For retention, this also means rate limiting and audit
   *   logging are applied consistently.
   */
  useEffect(() => {
    if (!user?.id) return;

    let cancelled = false;
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token || cancelled) return;

        const response = await fetch(`${getApiBaseUrl()}/api/account/retention`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });

        if (!response.ok || cancelled) return;
        const data = await response.json() as { retention_days: number | null };
        setRetentionDays(data.retention_days);
      } finally {
        if (!cancelled) setIsFetchingRetention(false);
      }
    })();

    return () => { cancelled = true; };
  }, [user?.id]);

  if (isLoading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="large" color="#71717a" />
      </View>
    );
  }

  if (!user) {
    router.replace('/(auth)/login');
    return null;
  }

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="pb-16"
      showsVerticalScrollIndicator={false}
    >
      {/* Header */}
      <View className="px-4 pt-6 pb-4">
        <Text className="text-2xl font-bold text-zinc-100">Privacy Control Center</Text>
        <Text className="text-sm text-zinc-400 mt-1">
          Control how your data is stored, exported, and deleted.
          All operations are audit-logged.
        </Text>
      </View>

      {/* Retention */}
      <RetentionPicker
        initialRetentionDays={isFetchingRetention ? 'loading' : retentionDays}
        onRetentionChanged={setRetentionDays}
        userId={user.id}
      />

      {/* Export */}
      <MobileExportButton />

      {/* Web links */}
      <MobilePrivacyLinks />

      {/* Delete */}
      <MobileDeleteSection
        userEmail={user.email ?? ''}
        userDisplayName={user.displayName ?? undefined}
      />
    </ScrollView>
  );
}
