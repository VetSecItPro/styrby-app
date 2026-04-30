/**
 * MCP Approval Screen — route handler at /mcp-approval/[approvalId].
 *
 * Orchestrator only: pulls the approval ID from the route, calls
 * {@link useMcpApproval} for state, and delegates rendering to
 * {@link McpApprovalRequest}. No business logic lives here.
 *
 * Deep-linked from the push notification routed in
 * `src/hooks/useNotifications.ts` when the payload's `screen` field is
 * `'mcp_approval'` and `approvalId` is present.
 *
 * @module app/mcp-approval/[approvalId]
 */

import React, { useCallback } from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import {
  useMcpApproval,
  McpApprovalRequest,
} from '@/components/mcp-approval';

/**
 * Route params extracted by expo-router from the file-system route.
 */
interface McpApprovalRouteParams extends Record<string, string | string[]> {
  approvalId: string;
}

/**
 * Default export — the actual screen.
 */
export default function McpApprovalScreen(): React.ReactElement {
  const router = useRouter();
  const params = useLocalSearchParams<McpApprovalRouteParams>();
  const approvalId =
    typeof params.approvalId === 'string' ? params.approvalId : '';

  /**
   * Dismisses the screen after a successful decision write.
   *
   * WHY router.back() vs router.replace('/'): the user arrived here from a
   * notification deep-link or the dashboard "Review" button. In both cases
   * popping back lands them on the prior screen (dashboard or wherever
   * they came from), which is the least disruptive UX.
   */
  const handleResolved = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(tabs)/');
    }
  }, [router]);

  const {
    request,
    isLoading,
    loadError,
    isSubmitting,
    submitError,
    secondsRemaining,
    submit,
  } = useMcpApproval({ approvalId, onResolved: handleResolved });

  const handleApprove = useCallback(
    (note: string) => {
      void submit('approved', note);
    },
    [submit],
  );

  const handleDeny = useCallback(
    (note: string) => {
      void submit('denied', note);
    },
    [submit],
  );

  if (!approvalId) {
    return (
      <View style={styles.statusContainer} accessibilityRole="alert">
        <Stack.Screen options={{ title: 'Approval' }} />
        <Text style={styles.errorText}>Missing approval id in route.</Text>
      </View>
    );
  }

  if (isLoading) {
    return (
      <View style={styles.statusContainer}>
        <Stack.Screen options={{ title: 'Approval' }} />
        <ActivityIndicator size="large" color="#f97316" />
        <Text style={styles.statusText}>Loading approval request…</Text>
      </View>
    );
  }

  if (loadError || !request) {
    return (
      <View style={styles.statusContainer} accessibilityRole="alert">
        <Stack.Screen options={{ title: 'Approval' }} />
        <Text style={styles.errorText}>
          {loadError ?? 'Approval request unavailable.'}
        </Text>
      </View>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Approval requested' }} />
      <McpApprovalRequest
        request={request}
        isSubmitting={isSubmitting}
        submitError={submitError}
        secondsRemaining={secondsRemaining}
        onApprove={handleApprove}
        onDeny={handleDeny}
      />
    </>
  );
}

const styles = StyleSheet.create({
  statusContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#0a0a0a',
    gap: 12,
  },
  statusText: {
    color: '#9ca3af',
    fontSize: 14,
  },
  errorText: {
    color: '#fca5a5',
    fontSize: 15,
    textAlign: 'center',
  },
});
