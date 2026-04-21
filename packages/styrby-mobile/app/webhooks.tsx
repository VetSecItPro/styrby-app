/**
 * Webhooks Screen (Orchestrator)
 *
 * Full-screen management interface for the user's webhooks.
 *
 * Features:
 * - List view showing URL (truncated), event types, active/paused status, created date
 * - Tap a webhook to open the detail sheet (full URL, secret, event types, deliveries,
 *   test delivery, toggle active/paused, delete)
 * - FAB to create a new webhook (name, URL, event type checkboxes)
 * - Power-tier gate - non-Power users see an upgrade prompt
 * - Pull-to-refresh
 *
 * Navigated to from Settings > Developer Tools section.
 *
 * WHY orchestrator pattern:
 * Following the project's Component-First Architecture rule, this file owns
 * only state, data fetching, top-level layout, and routing between sub-views.
 * All presentation lives in `src/components/webhooks/*` so each piece stays
 * under the 400-LOC ceiling and can be tested in isolation.
 */

import { useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  Pressable,
  Alert,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useWebhooks } from '../src/hooks/useWebhooks';
import type { Webhook, CreateWebhookInput } from '../src/types/webhooks';
import {
  PowerTierGate,
  WebhookDetailSheet,
  WebhookFormSheet,
  WebhookListItem,
} from '../src/components/webhooks';

/**
 * Webhooks screen.
 *
 * Renders the user's webhook list with CRUD capabilities.
 * Non-Power-tier users see an upgrade prompt.
 *
 * @returns React element
 */
export default function WebhooksScreen() {
  const {
    webhooks,
    isLoading,
    isMutating,
    error,
    isPowerTier,
    webhookLimit,
    webhookCount,
    refresh,
    createWebhook,
    deleteWebhook,
    toggleWebhook,
    testWebhook,
    fetchDeliveries,
  } = useWebhooks();

  const [isFormVisible, setIsFormVisible] = useState(false);
  const [selectedWebhook, setSelectedWebhook] = useState<Webhook | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // --------------------------------------------------------------------------
  // Handlers
  // --------------------------------------------------------------------------

  /**
   * Opens the create form sheet.
   */
  const handleCreatePress = useCallback(() => {
    setIsFormVisible(true);
  }, []);

  /**
   * Handles saving a new webhook from the form.
   *
   * @param input - Webhook form data
   */
  const handleFormSave = useCallback(
    async (input: CreateWebhookInput): Promise<void> => {
      const created = await createWebhook(input);
      if (created) {
        setIsFormVisible(false);
      } else {
        Alert.alert('Error', 'Failed to create webhook. Check the URL and try again.');
      }
    },
    [createWebhook]
  );

  /**
   * Opens the detail sheet for a webhook.
   *
   * @param webhook - The webhook to show
   */
  const handleWebhookPress = useCallback((webhook: Webhook) => {
    setSelectedWebhook(webhook);
  }, []);

  /**
   * Closes the detail sheet.
   */
  const handleDetailClose = useCallback(() => {
    setSelectedWebhook(null);
  }, []);

  /**
   * Handles toggle from the detail sheet - updates local state.
   *
   * WHY we sync `selectedWebhook` here:
   * The detail sheet reads `webhook.is_active` directly from props. Without
   * this sync, the toggle would update the underlying list but the open sheet
   * would still display the stale value until the user closed and reopened it.
   *
   * @param id - Webhook ID
   * @param isActive - Desired active state
   */
  const handleToggle = useCallback(
    async (id: string, isActive: boolean): Promise<boolean> => {
      const success = await toggleWebhook(id, isActive);
      if (success) {
        setSelectedWebhook((prev) =>
          prev?.id === id ? { ...prev, is_active: isActive } : prev
        );
      }
      return success;
    },
    [toggleWebhook]
  );

  /**
   * Handles delete from the detail sheet - removes from local list.
   *
   * @param id - Webhook ID to delete
   */
  const handleDelete = useCallback(
    async (id: string): Promise<boolean> => {
      return await deleteWebhook(id);
    },
    [deleteWebhook]
  );

  /**
   * Handles pull-to-refresh.
   */
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await refresh();
    setIsRefreshing(false);
  }, [refresh]);

  const canCreate = webhookLimit === 0 || webhookCount < webhookLimit;

  // --------------------------------------------------------------------------
  // Render: Loading
  // --------------------------------------------------------------------------

  if (isLoading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="large" color="#f97316" />
        <Text className="text-zinc-500 mt-4">Loading webhooks...</Text>
      </View>
    );
  }

  // --------------------------------------------------------------------------
  // Render: Power Tier Gate
  // --------------------------------------------------------------------------

  if (!isPowerTier) {
    return <PowerTierGate />;
  }

  // --------------------------------------------------------------------------
  // Render: Error (no data)
  // --------------------------------------------------------------------------

  if (error && webhooks.length === 0) {
    return (
      <View className="flex-1 bg-background items-center justify-center px-6">
        <Ionicons name="alert-circle-outline" size={48} color="#ef4444" />
        <Text className="text-white text-lg font-semibold mt-4">
          Failed to Load Webhooks
        </Text>
        <Text className="text-zinc-500 text-center mt-2">{error}</Text>
        <Pressable
          onPress={refresh}
          className="bg-brand px-6 py-3 rounded-xl mt-6 active:opacity-80"
          accessibilityRole="button"
          accessibilityLabel="Retry loading webhooks"
        >
          <Text className="text-white font-semibold">Try Again</Text>
        </Pressable>
      </View>
    );
  }

  // --------------------------------------------------------------------------
  // Render: Main
  // --------------------------------------------------------------------------

  return (
    <View className="flex-1 bg-background">
      {/* Info bar */}
      <View className="px-4 py-3 border-b border-zinc-800/50">
        <Text className="text-zinc-400 text-sm">
          {webhookCount} / {webhookLimit} webhooks used.{' '}
          Receive real-time event notifications at your own endpoints.
        </Text>
      </View>

      <FlatList
        data={webhooks}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <WebhookListItem webhook={item} onPress={handleWebhookPress} />
        )}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            tintColor="#f97316"
            colors={['#f97316']}
          />
        }
        contentContainerStyle={
          webhooks.length === 0 ? { flexGrow: 1 } : { paddingTop: 12, paddingBottom: 100 }
        }
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <View className="flex-1 items-center justify-center py-20 px-6">
            <Ionicons name="git-network-outline" size={48} color="#3f3f46" />
            <Text className="text-zinc-400 font-semibold text-lg mt-4">
              No webhooks yet
            </Text>
            <Text className="text-zinc-500 text-center mt-2">
              Create a webhook to receive real-time notifications when sessions
              start, complete, or hit budget limits.
            </Text>
            <Pressable
              onPress={handleCreatePress}
              className="bg-brand px-6 py-3 rounded-xl mt-6 active:opacity-80 flex-row items-center"
              accessibilityRole="button"
              accessibilityLabel="Create your first webhook"
            >
              <Ionicons name="add" size={20} color="white" />
              <Text className="text-white font-semibold ml-2">Create Webhook</Text>
            </Pressable>
          </View>
        }
      />

      {/* FAB */}
      {webhooks.length > 0 && canCreate && (
        <View className="absolute bottom-6 right-6">
          <Pressable
            onPress={handleCreatePress}
            className="w-14 h-14 rounded-full bg-brand items-center justify-center shadow-lg active:opacity-80"
            style={{
              shadowColor: '#f97316',
              shadowOffset: { width: 0, height: 4 },
              shadowOpacity: 0.3,
              shadowRadius: 8,
              elevation: 8,
            }}
            accessibilityRole="button"
            accessibilityLabel="Create new webhook"
          >
            <Ionicons name="add" size={28} color="white" />
          </Pressable>
        </View>
      )}

      {/* Limit reached hint */}
      {webhooks.length > 0 && !canCreate && (
        <View className="absolute bottom-6 left-4 right-4">
          <View className="bg-zinc-900 border border-zinc-700 rounded-xl px-4 py-3 flex-row items-center">
            <Ionicons name="information-circle" size={18} color="#71717a" />
            <Text className="text-zinc-400 text-sm ml-2">
              Webhook limit reached ({webhookLimit} max on your plan).
            </Text>
          </View>
        </View>
      )}

      {/* Create Form Sheet */}
      <WebhookFormSheet
        visible={isFormVisible}
        onClose={() => setIsFormVisible(false)}
        onSave={handleFormSave}
        isSaving={isMutating}
      />

      {/* Detail Sheet */}
      <WebhookDetailSheet
        webhook={selectedWebhook}
        onClose={handleDetailClose}
        onToggle={handleToggle}
        onTest={testWebhook}
        onDelete={handleDelete}
        fetchDeliveries={fetchDeliveries}
        isMutating={isMutating}
      />
    </View>
  );
}
