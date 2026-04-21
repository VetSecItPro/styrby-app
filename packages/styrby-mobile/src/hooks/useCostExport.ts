/**
 * Cost data export hook + format-picker.
 *
 * WHY: The export flow is non-trivial (Supabase auth → fetch web API →
 * platform-conditional UX → native share sheet → tier/rate-limit handling).
 * Extracting it from the screen file keeps the orchestrator small and lets
 * the export logic be unit-tested without rendering the costs UI.
 *
 * WHY we call the web API (/api/v1/costs/export): That is the canonical,
 * already-validated, rate-limited export endpoint. Duplicating export logic
 * in the mobile app would create two code paths to maintain.
 *
 * @module hooks/useCostExport
 */

import { useState, useCallback } from 'react';
import { ActionSheetIOS, Alert, Platform, Share } from 'react-native';
import { supabase } from '../lib/supabase';
import type { CostTimeRange } from './useCosts';

/**
 * Export file formats supported by the web export endpoint.
 */
export type CostExportFormat = 'csv' | 'json';

/**
 * Resolve the API base URL.
 *
 * WHY: Exposed for tests so we can assert the constructed URL without
 * mocking the entire env-var resolution chain.
 *
 * @returns The configured app base URL (defaults to production)
 */
export function getAppUrl(): string {
  return process.env.EXPO_PUBLIC_APP_URL ?? 'https://app.styrby.com';
}

/**
 * Build the export filename for the given format.
 *
 * @param format - 'csv' or 'json'
 * @param now - Optional override for "today" (defaults to current Date) — exposed for testing
 * @returns Filename like 'styrby-costs-2026-04-20.csv'
 */
export function buildExportFilename(format: CostExportFormat, now: Date = new Date()): string {
  const today = now.toISOString().split('T')[0];
  return `styrby-costs-${today}.${format}`;
}

/**
 * Hook return shape from {@link useCostExport}.
 */
export interface UseCostExportReturn {
  /** Whether an export is currently in flight */
  isExporting: boolean;
  /** Open the platform-appropriate format picker (ActionSheet on iOS, Alert on Android) */
  showExportPicker: () => void;
}

/**
 * Manages the export-to-CSV/JSON flow for the costs screen.
 *
 * @param timeRange - Active time range (in days) — passed to the export endpoint
 * @returns {@link UseCostExportReturn}
 */
export function useCostExport(timeRange: CostTimeRange): UseCostExportReturn {
  const [isExporting, setIsExporting] = useState(false);

  /**
   * Fetch the export from the web API and hand it to the native share sheet.
   *
   * WHY native Share sheet vs. local download: Mobile can't trigger a browser
   * download. Sharing the file content lets the user save to Files, AirDrop,
   * email, etc. — whichever destination they prefer.
   */
  const handleExport = useCallback(async (format: CostExportFormat) => {
    setIsExporting(true);
    try {
      const { data: { session: authSession } } = await supabase.auth.getSession();
      const token = authSession?.access_token;

      if (!token) {
        Alert.alert('Not Authenticated', 'Please log in to export cost data.');
        return;
      }

      const params = new URLSearchParams({ format, days: String(timeRange) });
      const res = await fetch(`${getAppUrl()}/api/v1/costs/export?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.status === 403) {
        // WHY platform-conditional message: Apple Reader App rules (§3.1.3(a))
        // prohibit referencing pricing or upgrade flows in iOS apps.
        // On Android we can mention the pricing URL; on iOS we keep it neutral.
        Alert.alert(
          'Power Tier Required',
          Platform.OS === 'ios'
            ? 'Cost export requires a Power subscription. Manage your plan at styrbyapp.com.'
            : 'Cost export is available on the Power plan. Upgrade at styrbyapp.com/pricing.'
        );
        return;
      }

      if (res.status === 429) {
        Alert.alert('Rate Limited', 'Cost export is limited to once per hour. Try again later.');
        return;
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { message?: string };
        throw new Error(body.message ?? `Export failed (${res.status})`);
      }

      const content = await res.text();
      const filename = buildExportFilename(format);

      await Share.share({
        title: filename,
        message: content,
      });
    } catch (err) {
      Alert.alert(
        'Export Failed',
        err instanceof Error ? err.message : 'Failed to export cost data'
      );
      if (__DEV__) console.error('[CostsExport] Export error:', err);
    } finally {
      setIsExporting(false);
    }
  }, [timeRange]);

  /**
   * Show a format picker (ActionSheet on iOS, Alert on Android) and call
   * handleExport with the chosen format.
   *
   * WHY ActionSheetIOS for iOS: Idiomatic iOS pattern without adding a
   * third-party bottom-sheet dependency. Android falls back to Alert with
   * action buttons since ActionSheetIOS is iOS-only.
   */
  const showExportPicker = useCallback(() => {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: 'Export Cost Data',
          message: `Last ${timeRange} days`,
          options: ['Cancel', 'Export as CSV', 'Export as JSON'],
          cancelButtonIndex: 0,
        },
        (buttonIndex) => {
          if (buttonIndex === 1) handleExport('csv');
          else if (buttonIndex === 2) handleExport('json');
        }
      );
    } else {
      Alert.alert(
        'Export Cost Data',
        `Choose a format to export the last ${timeRange} days of cost data.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Export CSV', onPress: () => handleExport('csv') },
          { text: 'Export JSON', onPress: () => handleExport('json') },
        ]
      );
    }
  }, [timeRange, handleExport]);

  return { isExporting, showExportPicker };
}
