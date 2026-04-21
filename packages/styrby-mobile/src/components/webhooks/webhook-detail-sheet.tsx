/**
 * WebhookDetailSheet
 *
 * Full-screen modal showing the detail view for a single webhook:
 * - Endpoint URL (tappable, opens in browser)
 * - Event type badges
 * - Failure summary (if any)
 * - "Send test delivery" button + result
 * - Recent deliveries list (loaded on open)
 * - Active/paused toggle
 * - Delete button (with confirmation)
 */

import { useState, useCallback } from 'react';
import {
  View,
  Text,
  Pressable,
  Modal,
  ScrollView,
  Switch,
  Alert,
  ActivityIndicator,
  Linking,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { Webhook, WebhookDelivery } from '../../types/webhooks';
import { EventBadge } from './event-badge';
import { formatDate, formatRelativeTime } from './webhook-helpers';

interface DetailSheetProps {
  /** The webhook to show detail for, or null when hidden */
  webhook: Webhook | null;
  /** Close the detail sheet */
  onClose: () => void;
  /** Toggle the webhook's active state */
  onToggle: (id: string, isActive: boolean) => Promise<boolean>;
  /** Send a test delivery */
  onTest: (id: string) => Promise<boolean>;
  /** Delete the webhook */
  onDelete: (id: string) => Promise<boolean>;
  /** Fetch delivery history */
  fetchDeliveries: (id: string) => Promise<WebhookDelivery[]>;
  /** Whether a mutation is in progress */
  isMutating: boolean;
}

/**
 * Renders the webhook detail sheet.
 *
 * WHY deliveries load on `onShow` (not on first render):
 * The Modal stays mounted with `webhook=null`, so loading on render would
 * either fire on every parent re-render or require an effect with awkward
 * cleanup. `onShow` fires exactly once per open and gives us a fresh
 * delivery list each time the user opens a row.
 *
 * @param props - Detail sheet props
 * @returns React element
 */
export function WebhookDetailSheet({
  webhook,
  onClose,
  onToggle,
  onTest,
  onDelete,
  fetchDeliveries,
  isMutating,
}: DetailSheetProps) {
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [isLoadingDeliveries, setIsLoadingDeliveries] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<'success' | 'error' | null>(null);

  /**
   * Loads deliveries when the sheet opens.
   *
   * @param id - Webhook ID whose deliveries should be fetched
   */
  const loadDeliveries = useCallback(
    async (id: string) => {
      setIsLoadingDeliveries(true);
      const result = await fetchDeliveries(id);
      setDeliveries(result);
      setIsLoadingDeliveries(false);
    },
    [fetchDeliveries]
  );

  /**
   * Resets delivery state when the sheet closes.
   */
  const handleClose = useCallback(() => {
    setDeliveries([]);
    setTestResult(null);
    onClose();
  }, [onClose]);

  /**
   * Sends a test delivery and shows result.
   */
  const handleTest = useCallback(async () => {
    if (!webhook) return;
    setIsTesting(true);
    setTestResult(null);
    const success = await onTest(webhook.id);
    setTestResult(success ? 'success' : 'error');
    setIsTesting(false);
    // Refresh deliveries after test
    if (success) {
      await loadDeliveries(webhook.id);
    }
  }, [webhook, onTest, loadDeliveries]);

  /**
   * Prompts the user for confirmation then deletes the webhook.
   */
  const handleDelete = useCallback(() => {
    if (!webhook) return;
    Alert.alert(
      'Delete Webhook?',
      `Are you sure you want to delete "${webhook.name}"? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            const success = await onDelete(webhook.id);
            if (success) {
              handleClose();
            } else {
              Alert.alert('Error', 'Failed to delete webhook. Please try again.');
            }
          },
        },
      ]
    );
  }, [webhook, onDelete, handleClose]);

  /**
   * Effect: load deliveries when the detail sheet opens with a new webhook.
   *
   * @param id - Webhook ID just opened
   */
  const handleOpen = useCallback(
    (id: string) => {
      loadDeliveries(id);
    },
    [loadDeliveries]
  );

  return (
    <Modal
      visible={webhook !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
      onShow={() => {
        if (webhook) handleOpen(webhook.id);
      }}
    >
      {webhook && (
        <View className="flex-1 bg-zinc-950">
          {/* Header */}
          <View className="flex-row items-center justify-between px-4 py-4 border-b border-zinc-800">
            <Pressable
              onPress={handleClose}
              className="p-1 active:opacity-60"
              accessibilityRole="button"
              accessibilityLabel="Close webhook detail"
            >
              <Ionicons name="close" size={24} color="#71717a" />
            </Pressable>
            <Text className="text-white font-semibold text-lg flex-1 text-center mx-4" numberOfLines={1}>
              {webhook.name}
            </Text>
            <View
              className="px-2 py-0.5 rounded-full"
              style={{ backgroundColor: webhook.is_active ? '#16a34a20' : '#71717a20' }}
            >
              <Text
                style={{
                  color: webhook.is_active ? '#4ade80' : '#71717a',
                  fontSize: 12,
                  fontWeight: '600',
                }}
              >
                {webhook.is_active ? 'Active' : 'Paused'}
              </Text>
            </View>
          </View>

          <ScrollView
            className="flex-1 px-4 pt-4"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 40 }}
          >
            {/* URL Section */}
            <Text className="text-zinc-400 text-xs font-semibold uppercase mb-2">
              Endpoint URL
            </Text>
            <Pressable
              className="bg-zinc-900 rounded-xl px-4 py-3 mb-4 active:opacity-80"
              onPress={() => Linking.openURL(webhook.url).catch(() => null)}
              accessibilityRole="link"
              accessibilityLabel={`Open webhook URL: ${webhook.url}`}
            >
              <Text className="text-zinc-300 text-sm" selectable>
                {webhook.url}
              </Text>
            </Pressable>

            {/* Event Types */}
            <Text className="text-zinc-400 text-xs font-semibold uppercase mb-2">
              Events
            </Text>
            <View className="flex-row flex-wrap mb-4">
              {webhook.events.map((event) => (
                <EventBadge key={event} event={event} />
              ))}
            </View>

            {/* Failure info */}
            {webhook.consecutive_failures > 0 && (
              <View className="bg-orange-500/10 border border-orange-500/30 rounded-xl px-3 py-3 mb-4 flex-row items-center">
                <Ionicons name="warning" size={18} color="#fb923c" />
                <Text className="text-orange-400 text-sm ml-2 flex-1">
                  {webhook.consecutive_failures} consecutive delivery failures.
                  {webhook.last_failure_at
                    ? ` Last failure: ${formatRelativeTime(webhook.last_failure_at)}`
                    : ''}
                </Text>
              </View>
            )}

            {/* Test Delivery */}
            <Text className="text-zinc-400 text-xs font-semibold uppercase mb-2">
              Test
            </Text>
            <Pressable
              onPress={handleTest}
              disabled={isTesting || isMutating}
              className="bg-zinc-900 rounded-xl px-4 py-3 mb-1 flex-row items-center active:opacity-80"
              accessibilityRole="button"
              accessibilityLabel="Send test delivery to webhook"
            >
              {isTesting ? (
                <ActivityIndicator size="small" color="#f97316" />
              ) : (
                <Ionicons name="send" size={18} color="#f97316" />
              )}
              <Text className="text-white font-medium ml-3">
                {isTesting ? 'Sending...' : 'Send Test Delivery'}
              </Text>
              {testResult === 'success' && (
                <View className="ml-auto flex-row items-center">
                  <Ionicons name="checkmark-circle" size={18} color="#4ade80" />
                  <Text className="text-green-400 text-sm ml-1">Delivered</Text>
                </View>
              )}
              {testResult === 'error' && (
                <View className="ml-auto flex-row items-center">
                  <Ionicons name="close-circle" size={18} color="#ef4444" />
                  <Text className="text-red-400 text-sm ml-1">Failed</Text>
                </View>
              )}
            </Pressable>
            <Text className="text-zinc-500 text-xs mb-4">
              Sends a sample payload to verify your endpoint is reachable.
            </Text>

            {/* Recent Deliveries */}
            <Text className="text-zinc-400 text-xs font-semibold uppercase mb-2">
              Recent Deliveries
            </Text>
            {isLoadingDeliveries ? (
              <View className="items-center py-6">
                <ActivityIndicator size="small" color="#f97316" />
              </View>
            ) : deliveries.length === 0 ? (
              <View className="bg-zinc-900 rounded-xl px-4 py-4 mb-4">
                <Text className="text-zinc-500 text-sm text-center">
                  No delivery attempts yet.
                </Text>
              </View>
            ) : (
              <View className="bg-zinc-900 rounded-2xl mb-4 overflow-hidden">
                {deliveries.map((delivery, index) => (
                  <View
                    key={delivery.id}
                    className={`flex-row items-center px-4 py-3 ${
                      index < deliveries.length - 1 ? 'border-b border-zinc-800' : ''
                    }`}
                  >
                    <Ionicons
                      name={delivery.success ? 'checkmark-circle' : 'close-circle'}
                      size={18}
                      color={delivery.success ? '#4ade80' : '#ef4444'}
                    />
                    <View className="flex-1 ml-3">
                      <Text className="text-white text-sm" numberOfLines={1}>
                        {delivery.event_type}
                      </Text>
                      {delivery.error_message && (
                        <Text className="text-red-400 text-xs" numberOfLines={1}>
                          {delivery.error_message}
                        </Text>
                      )}
                    </View>
                    <View className="items-end">
                      {delivery.status_code !== null && (
                        <Text
                          className="text-xs font-mono font-semibold"
                          style={{
                            color: delivery.success ? '#4ade80' : '#ef4444',
                          }}
                        >
                          {delivery.status_code}
                        </Text>
                      )}
                      <Text className="text-zinc-500 text-xs">
                        {formatRelativeTime(delivery.created_at)}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            )}

            {/* Controls: Toggle + Delete */}
            <Text className="text-zinc-400 text-xs font-semibold uppercase mb-2">
              Settings
            </Text>
            <View className="bg-zinc-900 rounded-2xl overflow-hidden mb-4">
              <View className="flex-row items-center px-4 py-3 border-b border-zinc-800">
                <Ionicons
                  name={webhook.is_active ? 'pause-circle' : 'play-circle'}
                  size={20}
                  color="#f97316"
                />
                <Text className="text-white font-medium ml-3 flex-1">
                  {webhook.is_active ? 'Active' : 'Paused'}
                </Text>
                <Switch
                  value={webhook.is_active}
                  onValueChange={(value) => { void onToggle(webhook.id, value); }}
                  disabled={isMutating}
                  trackColor={{ false: '#3f3f46', true: '#f9731650' }}
                  thumbColor={webhook.is_active ? '#f97316' : '#71717a'}
                  accessibilityRole="switch"
                  accessibilityLabel="Toggle webhook active state"
                />
              </View>
              <Pressable
                onPress={handleDelete}
                disabled={isMutating}
                className="flex-row items-center px-4 py-3 active:bg-zinc-800"
                accessibilityRole="button"
                accessibilityLabel="Delete this webhook"
              >
                <Ionicons name="trash-outline" size={20} color="#ef4444" />
                <Text className="text-red-400 font-medium ml-3">Delete Webhook</Text>
              </Pressable>
            </View>

            {/* Metadata */}
            <Text className="text-zinc-600 text-xs text-center">
              Created {formatDate(webhook.created_at)}
            </Text>
          </ScrollView>
        </View>
      )}
    </Modal>
  );
}
