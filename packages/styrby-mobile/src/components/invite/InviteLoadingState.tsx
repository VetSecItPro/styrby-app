/**
 * InviteLoadingState
 *
 * Displayed while the POST /api/invitations/accept request is in-flight.
 * Shows a spinner and a short status message.
 *
 * WHY a dedicated component (not inline in InviteAcceptScreen):
 * Orchestrator pattern — InviteAcceptScreen stays thin by delegating all
 * rendering to named sub-components. Each sub-component can be tested,
 * snapshotted, and iterated on without touching the orchestrator.
 */

import React from 'react';
import { View, Text, ActivityIndicator } from 'react-native';

/**
 * Spinner screen shown while the invitation accept API call is in progress.
 *
 * @returns React element
 *
 * @example
 * if (state === 'loading') return <InviteLoadingState />;
 */
export function InviteLoadingState(): React.ReactElement {
  return (
    <View
      className="flex-1 items-center justify-center px-8"
      accessibilityLabel="Loading, joining team"
      accessibilityRole="progressbar"
    >
      <ActivityIndicator size="large" color="#f97316" />
      <Text className="text-zinc-400 mt-4 text-base">
        Joining team...
      </Text>
    </View>
  );
}
