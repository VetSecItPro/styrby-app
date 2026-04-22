/**
 * Mobile Export Button
 *
 * Triggers the GDPR Art. 15/20 data export via POST /api/account/export.
 * On mobile, the JSON is copied to the clipboard rather than downloaded
 * (mobile browsers don't support file downloads from fetch).
 *
 * WHY clipboard: React Native does not support triggering a browser download.
 * The clipboard approach is the same as the existing exportAccountData()
 * function in account-io.ts. The alert tells the user to paste into Notes or
 * Files to save the data.
 *
 * GDPR Art. 15 — Subject Access Request
 * GDPR Art. 20 — Data portability
 */

import { View, Text, Pressable, ActivityIndicator, Alert } from 'react-native';
import { useState, useCallback } from 'react';
import * as Clipboard from 'expo-clipboard';
import { supabase } from '@/lib/supabase';
import { getApiBaseUrl } from '@/lib/config';
import { SectionHeader } from '@/components/ui';

/**
 * Renders the mobile export button with rate-limit and error feedback.
 */
export function MobileExportButton() {
  const [isExporting, setIsExporting] = useState(false);

  /**
   * Request a data export, parse the JSON, and copy to clipboard.
   *
   * WHY the alert on success: clipboard feedback is important on mobile
   * because there is no visual "download started" indicator.
   */
  const handleExport = useCallback(async () => {
    setIsExporting(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        Alert.alert(
          'Sign In Required',
          'You must be signed in to export your data.',
        );
        return;
      }

      const response = await fetch(`${getApiBaseUrl()}/api/account/export`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
      });

      if (response.status === 429) {
        const data = await response.json();
        const minutes = Math.ceil((data.retryAfter ?? 3600) / 60);
        Alert.alert(
          'Rate Limited',
          `You can only export your data once per hour. Please try again in ${minutes} minutes.`,
        );
        return;
      }

      if (!response.ok) {
        const data = await response.json();
        Alert.alert(
          'Export Failed',
          data.error ?? 'Failed to export your data. Please try again.',
        );
        return;
      }

      const exportText = await response.text();
      await Clipboard.setStringAsync(exportText);

      Alert.alert(
        'Export Copied',
        'Your data has been copied to the clipboard. Paste it into Notes, Files, or a text editor to save it.',
      );
    } catch {
      Alert.alert(
        'Network Error',
        'Failed to export your data. Please check your connection and try again.',
      );
    } finally {
      setIsExporting(false);
    }
  }, []);

  return (
    <>
      <SectionHeader title="Data Export" />
      <View className="bg-background-secondary mx-4 rounded-xl mb-4 overflow-hidden">
        <Pressable
          onPress={handleExport}
          disabled={isExporting}
          accessibilityRole="button"
          accessibilityLabel="Export all your data as JSON (GDPR Art. 15)"
          className="flex-row items-center px-4 py-4 active:bg-zinc-800"
        >
          <View className="flex-1">
            <Text className="text-sm font-medium text-zinc-100">Export My Data</Text>
            <Text className="text-xs text-zinc-500 mt-0.5">
              Download a complete copy of your data (GDPR Art. 15)
            </Text>
          </View>
          {isExporting ? (
            <ActivityIndicator size="small" color="#22c55e" />
          ) : null}
        </Pressable>
      </View>
      <Text className="text-xs text-zinc-500 mx-4 mb-4">
        Includes sessions, messages, configurations, and audit logs. Message content
        is exported in encrypted form - only your device can decrypt it.
      </Text>
    </>
  );
}
