/**
 * Webhooks Screen
 *
 * Full-screen management interface for the user's webhooks.
 *
 * Features:
 * - List view showing URL (truncated), event types, active/paused status, created date
 * - Tap a webhook to open the detail sheet (full URL, secret, event types, deliveries,
 *   test delivery, toggle active/paused, delete)
 * - FAB to create a new webhook (name, URL, event type checkboxes)
 * - Power-tier gate — non-Power users see an upgrade prompt
 * - Pull-to-refresh
 *
 * Navigated to from Settings > Developer Tools section.
 */

import { useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  Pressable,
  Modal,
  ScrollView,
  TextInput,
  Switch,
  Alert,
  ActivityIndicator,
  RefreshControl,
  KeyboardAvoidingView,
  Platform,
  Linking,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { z } from 'zod';
import {
  useWebhooks,
  type Webhook,
  type WebhookEvent,
  type WebhookDelivery,
  type CreateWebhookInput,
} from '../src/hooks/useWebhooks';

// ============================================================================
// Constants
// ============================================================================

/**
 * Event options shown in the create/edit form and detail view.
 */
const EVENT_OPTIONS: { value: WebhookEvent; label: string; description: string }[] = [
  {
    value: 'session.started',
    label: 'Session Started',
    description: 'When an agent session begins',
  },
  {
    value: 'session.completed',
    label: 'Session Completed',
    description: 'When an agent session ends',
  },
  {
    value: 'budget.exceeded',
    label: 'Budget Exceeded',
    description: 'When a budget alert threshold is crossed',
  },
  {
    value: 'permission.requested',
    label: 'Permission Requested',
    description: 'When an agent requests permission for an action',
  },
];

/**
 * Colors for event type badges.
 */
const EVENT_COLORS: Record<WebhookEvent, { bg: string; text: string }> = {
  'session.started': { bg: '#16a34a20', text: '#4ade80' },
  'session.completed': { bg: '#2563eb20', text: '#60a5fa' },
  'budget.exceeded': { bg: '#ea580c20', text: '#fb923c' },
  'permission.requested': { bg: '#9333ea20', text: '#c084fc' },
};

/**
 * Zod schema for the create/edit webhook form.
 */
const WebhookFormSchema = z.object({
  name: z
    .string()
    .min(1, 'Name is required')
    .max(100, 'Name must be 100 characters or less'),
  url: z
    .string()
    .url('Must be a valid URL')
    .refine((u) => u.startsWith('https://'), 'URL must use HTTPS'),
  events: z.array(z.string()).min(1, 'Select at least one event'),
});

// ============================================================================
// Helpers
// ============================================================================

/**
 * Truncates a URL to a fixed character limit for list display.
 *
 * @param url - The URL string to truncate
 * @param maxLength - Maximum display length (default 50)
 * @returns Truncated URL with ellipsis if needed
 */
function truncateUrl(url: string, maxLength = 50): string {
  if (url.length <= maxLength) return url;
  return url.slice(0, maxLength - 3) + '...';
}

/**
 * Formats an ISO 8601 date string into a short human-readable date.
 *
 * @param iso - ISO 8601 date string
 * @returns Formatted date string (e.g., "Mar 29, 2026")
 */
function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

/**
 * Formats an ISO 8601 date string into a short time-ago or absolute label
 * for delivery logs.
 *
 * @param iso - ISO 8601 date string
 * @returns Human-friendly relative string
 */
function formatRelativeTime(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return formatDate(iso);
  } catch {
    return iso;
  }
}

// ============================================================================
// Sub-Components
// ============================================================================

interface EventBadgeProps {
  /** Event type string */
  event: string;
}

/**
 * Small colored pill badge for a webhook event type.
 *
 * @param props - Badge props
 * @returns React element
 */
function EventBadge({ event }: EventBadgeProps) {
  const colors = EVENT_COLORS[event as WebhookEvent] ?? { bg: '#3f3f4620', text: '#a1a1aa' };
  const label = EVENT_OPTIONS.find((o) => o.value === event)?.label ?? event;
  return (
    <View
      className="px-2 py-0.5 rounded-full mr-1 mb-1"
      style={{ backgroundColor: colors.bg }}
    >
      <Text style={{ color: colors.text, fontSize: 11, fontWeight: '600' }} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

interface WebhookListItemProps {
  /** The webhook to display */
  webhook: Webhook;
  /** Called when the row is tapped */
  onPress: (webhook: Webhook) => void;
}

/**
 * A single row in the webhook list.
 *
 * Shows: name, truncated URL, event badges, active/paused status.
 *
 * @param props - Component props
 * @returns React element
 */
function WebhookListItem({ webhook, onPress }: WebhookListItemProps) {
  return (
    <Pressable
      className="bg-zinc-900 rounded-2xl p-4 mb-3 mx-4 active:opacity-80"
      onPress={() => onPress(webhook)}
      accessibilityRole="button"
      accessibilityLabel={`Webhook ${webhook.name}, ${webhook.is_active ? 'active' : 'paused'}`}
    >
      {/* Header: name + status */}
      <View className="flex-row items-center justify-between mb-1">
        <Text className="text-white font-semibold text-base flex-1 mr-2" numberOfLines={1}>
          {webhook.name}
        </Text>
        <View
          className="px-2 py-0.5 rounded-full"
          style={{ backgroundColor: webhook.is_active ? '#16a34a20' : '#71717a20' }}
        >
          <Text
            style={{
              color: webhook.is_active ? '#4ade80' : '#71717a',
              fontSize: 11,
              fontWeight: '600',
            }}
          >
            {webhook.is_active ? 'Active' : 'Paused'}
          </Text>
        </View>
      </View>

      {/* URL */}
      <Text className="text-zinc-400 text-sm mb-2" numberOfLines={1}>
        {truncateUrl(webhook.url)}
      </Text>

      {/* Event badges */}
      <View className="flex-row flex-wrap mb-2">
        {webhook.events.map((event) => (
          <EventBadge key={event} event={event} />
        ))}
      </View>

      {/* Footer: created date + failure warning */}
      <View className="flex-row items-center justify-between">
        <Text className="text-zinc-500 text-xs">
          Created {formatDate(webhook.created_at)}
        </Text>
        {webhook.consecutive_failures > 0 && (
          <View className="flex-row items-center">
            <Ionicons name="warning" size={12} color="#fb923c" />
            <Text className="text-orange-400 text-xs ml-1">
              {webhook.consecutive_failures} failed
            </Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}

// ============================================================================
// Create / Edit Form Sheet
// ============================================================================

interface FormSheetProps {
  /** Whether the sheet is visible */
  visible: boolean;
  /** Close the sheet without saving */
  onClose: () => void;
  /** Save the form data */
  onSave: (input: CreateWebhookInput) => Promise<void>;
  /** Whether a save is in progress */
  isSaving: boolean;
}

/**
 * Bottom-sheet style modal for creating a new webhook.
 *
 * Contains: name input, URL input, event type checkboxes.
 * All inputs are validated with Zod before saving.
 *
 * @param props - Form sheet props
 * @returns React element
 */
function WebhookFormSheet({ visible, onClose, onSave, isSaving }: FormSheetProps) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [selectedEvents, setSelectedEvents] = useState<Set<WebhookEvent>>(
    new Set(['session.started'])
  );
  const [validationError, setValidationError] = useState<string | null>(null);

  /**
   * Resets the form to empty state.
   */
  const resetForm = useCallback(() => {
    setName('');
    setUrl('');
    setSelectedEvents(new Set(['session.started']));
    setValidationError(null);
  }, []);

  /**
   * Toggles an event type in the selected set.
   *
   * @param event - The event type to toggle
   */
  const toggleEvent = useCallback((event: WebhookEvent) => {
    setSelectedEvents((prev) => {
      const next = new Set(prev);
      if (next.has(event)) {
        next.delete(event);
      } else {
        next.add(event);
      }
      return next;
    });
  }, []);

  /**
   * Validates the form and triggers the save callback.
   */
  const handleSave = useCallback(async () => {
    setValidationError(null);

    const result = WebhookFormSchema.safeParse({
      name: name.trim(),
      url: url.trim(),
      events: Array.from(selectedEvents),
    });

    if (!result.success) {
      setValidationError(result.error.issues[0]?.message ?? 'Invalid form data');
      return;
    }

    await onSave({
      name: result.data.name,
      url: result.data.url,
      events: result.data.events as WebhookEvent[],
    });

    resetForm();
  }, [name, url, selectedEvents, onSave, resetForm]);

  /**
   * Closes the sheet and resets the form.
   */
  const handleClose = useCallback(() => {
    resetForm();
    onClose();
  }, [onClose, resetForm]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1 bg-zinc-950"
      >
        {/* Header */}
        <View className="flex-row items-center justify-between px-4 py-4 border-b border-zinc-800">
          <Pressable
            onPress={handleClose}
            className="p-1 active:opacity-60"
            accessibilityRole="button"
            accessibilityLabel="Cancel and close form"
          >
            <Text className="text-zinc-400 text-base">Cancel</Text>
          </Pressable>
          <Text className="text-white font-semibold text-lg">New Webhook</Text>
          <Pressable
            onPress={handleSave}
            disabled={isSaving}
            className="p-1 active:opacity-60"
            accessibilityRole="button"
            accessibilityLabel="Save webhook"
          >
            {isSaving ? (
              <ActivityIndicator size="small" color="#f97316" />
            ) : (
              <Text className="text-brand font-semibold text-base">Save</Text>
            )}
          </Pressable>
        </View>

        <ScrollView
          className="flex-1 px-4 pt-4"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Validation Error */}
          {validationError && (
            <View className="bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2 mb-4">
              <Text className="text-red-400 text-sm">{validationError}</Text>
            </View>
          )}

          {/* Name */}
          <Text className="text-zinc-400 text-xs font-semibold uppercase mb-2">Name</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="My Webhook"
            placeholderTextColor="#52525b"
            className="bg-zinc-900 text-white rounded-xl px-4 py-3 mb-4"
            autoCapitalize="words"
            returnKeyType="next"
            accessibilityLabel="Webhook name"
          />

          {/* URL */}
          <Text className="text-zinc-400 text-xs font-semibold uppercase mb-2">
            Endpoint URL
          </Text>
          <TextInput
            value={url}
            onChangeText={setUrl}
            placeholder="https://your-server.com/hooks/styrby"
            placeholderTextColor="#52525b"
            className="bg-zinc-900 text-white rounded-xl px-4 py-3 mb-1"
            autoCapitalize="none"
            keyboardType="url"
            returnKeyType="done"
            autoCorrect={false}
            accessibilityLabel="Webhook endpoint URL"
          />
          <Text className="text-zinc-500 text-xs mb-4">Must be an HTTPS URL</Text>

          {/* Event Types */}
          <Text className="text-zinc-400 text-xs font-semibold uppercase mb-2">
            Events
          </Text>
          <View className="bg-zinc-900 rounded-2xl mb-8 overflow-hidden">
            {EVENT_OPTIONS.map((option, index) => {
              const isSelected = selectedEvents.has(option.value);
              return (
                <Pressable
                  key={option.value}
                  onPress={() => toggleEvent(option.value)}
                  className={`flex-row items-center px-4 py-3 active:bg-zinc-800 ${
                    index < EVENT_OPTIONS.length - 1 ? 'border-b border-zinc-800' : ''
                  }`}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: isSelected }}
                  accessibilityLabel={`${option.label}: ${option.description}`}
                >
                  <View
                    className="w-5 h-5 rounded border-2 items-center justify-center mr-3"
                    style={{
                      borderColor: isSelected ? '#f97316' : '#3f3f46',
                      backgroundColor: isSelected ? '#f97316' : 'transparent',
                    }}
                  >
                    {isSelected && <Ionicons name="checkmark" size={12} color="white" />}
                  </View>
                  <View className="flex-1">
                    <Text className="text-white font-medium text-sm">{option.label}</Text>
                    <Text className="text-zinc-500 text-xs">{option.description}</Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ============================================================================
// Detail Sheet
// ============================================================================

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
 * Full-screen modal showing the webhook detail view.
 *
 * Sections:
 * 1. Full URL + secret reveal button
 * 2. Event types
 * 3. Test delivery button
 * 4. Recent deliveries list
 * 5. Toggle active / delete
 *
 * @param props - Detail sheet props
 * @returns React element
 */
function WebhookDetailSheet({
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

// ============================================================================
// Power Tier Gate
// ============================================================================

/**
 * Full-screen upgrade prompt shown to non-Power-tier users.
 *
 * @returns React element
 */
function PowerTierGate() {
  return (
    <View className="flex-1 bg-background items-center justify-center px-8">
      <View className="w-20 h-20 rounded-3xl bg-orange-500/15 items-center justify-center mb-6">
        <Ionicons name="key" size={40} color="#f97316" />
      </View>
      <Text className="text-white text-2xl font-bold text-center mb-2">
        Power Plan Required
      </Text>
      <Text className="text-zinc-400 text-center mb-6">
        Webhooks are available on the Power plan. Automate your workflow by
        receiving real-time event notifications to any HTTPS endpoint.
      </Text>
      <Pressable
        className="bg-brand px-8 py-4 rounded-2xl active:opacity-80"
        onPress={() =>
          Linking.openURL('https://polar.sh/styrby/portal').catch(() => null)
        }
        accessibilityRole="button"
        accessibilityLabel="Upgrade to Power plan"
      >
        <Text className="text-white font-bold text-base">Upgrade to Power</Text>
      </Pressable>
    </View>
  );
}

// ============================================================================
// Screen
// ============================================================================

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
   * Handles toggle from the detail sheet — updates local state.
   *
   * @param id - Webhook ID
   * @param isActive - Desired active state
   */
  const handleToggle = useCallback(
    async (id: string, isActive: boolean): Promise<boolean> => {
      const success = await toggleWebhook(id, isActive);
      if (success) {
        // Sync the selected webhook state to reflect the change
        setSelectedWebhook((prev) =>
          prev?.id === id ? { ...prev, is_active: isActive } : prev
        );
      }
      return success;
    },
    [toggleWebhook]
  );

  /**
   * Handles delete from the detail sheet — removes from local list.
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
