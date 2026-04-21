/**
 * Account Settings — Data Section
 *
 * Renders the GDPR Art. 20 "Export My Data" row. Lives in its own file so
 * future additions (data deletion request, data correction request) can be
 * grouped here without re-inflating the orchestrator.
 */

import { View, ActivityIndicator } from 'react-native';
import { SectionHeader, SettingRow } from '@/components/ui';

/**
 * Props consumed by {@link DataSection}.
 */
export interface DataSectionProps {
  /** True while the export request is in flight */
  isExporting: boolean;
  /** Triggers the export flow (calls the web API and copies JSON to clipboard) */
  onPressExport: () => void;
}

/**
 * Data section: export-my-data row.
 */
export function DataSection({ isExporting, onPressExport }: DataSectionProps) {
  return (
    <>
      <SectionHeader title="Data" />
      <View className="bg-background-secondary">
        <SettingRow
          icon="download"
          iconColor="#22c55e"
          title="Export My Data"
          subtitle="Download all your data (GDPR Art. 20)"
          onPress={onPressExport}
          trailing={
            isExporting ? (
              <ActivityIndicator size="small" color="#22c55e" />
            ) : undefined
          }
        />
      </View>
    </>
  );
}
