/**
 * Budget Alerts Screen
 *
 * Full-screen management interface for budget alerts. Displays existing
 * alerts as cards with progress bars, enables/disables alerts via toggle,
 * and provides a creation form for new alerts.
 *
 * Tier-gated: Free users see an upgrade prompt. Pro users can create
 * up to 3 alerts. Power users can create up to 10.
 */

import { useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  TextInput,
  Switch,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import {
  useBudgetAlerts,
  getPeriodLabel,
  getActionLabel,
  getActionDescription,
  getAlertProgressColor,
  getActionBadgeColor,
} from '../src/hooks/useBudgetAlerts';
import type {
  BudgetAlert,
  BudgetAlertPeriod,
  BudgetAlertAction,
  CreateBudgetAlertInput,
} from '../src/hooks/useBudgetAlerts';

// ============================================================================
// Sub-Components
// ============================================================================

/**
 * Props for the AlertCard component.
 */
interface AlertCardProps {
  /** The budget alert to display */
  alert: BudgetAlert;
  /** Callback when the enabled toggle is changed */
  onToggle: (id: string, enabled: boolean) => void;
  /** Callback when the delete button is pressed */
  onDelete: (id: string) => void;
}

/**
 * Displays a single budget alert as a card with progress bar, spend info,
 * action badge, and enabled toggle.
 *
 * @param props - Component props
 * @returns Rendered alert card
 */
function AlertCard({ alert, onToggle, onDelete }: AlertCardProps) {
  const progressColor = getAlertProgressColor(alert.percentUsed);
  const actionBadge = getActionBadgeColor(alert.action);

  // WHY: Clamp progress width to 100% for the visual bar, but show the
  // actual percentage in text so users know how far over they are.
  const progressWidth = Math.min(alert.percentUsed, 100);

  /**
   * Format a cost value for display.
   *
   * @param value - Cost in USD
   * @returns Formatted string (e.g., "$12.34")
   */
  const formatCost = (value: number): string => {
    if (value === 0) return '$0.00';
    if (value < 0.01) return `$${value.toFixed(4)}`;
    if (value < 1) return `$${value.toFixed(3)}`;
    return `$${value.toFixed(2)}`;
  };

  /**
   * Confirm before deleting an alert.
   */
  const handleDeletePress = () => {
    Alert.alert(
      'Delete Alert',
      `Are you sure you want to delete "${alert.name}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => onDelete(alert.id) },
      ]
    );
  };

  return (
    <View
      className="bg-zinc-900 rounded-2xl p-4 mb-3"
      style={{ opacity: alert.enabled ? 1 : 0.6 }}
      accessibilityRole="summary"
      accessibilityLabel={`Budget alert: ${alert.name}, ${formatCost(alert.currentSpend)} of ${formatCost(alert.threshold)} ${getPeriodLabel(alert.period)}, ${alert.percentUsed.toFixed(0)}% used`}
    >
      {/* Header: Name + Toggle + Delete */}
      <View className="flex-row items-center justify-between mb-3">
        <View className="flex-row items-center flex-1 mr-3">
          <Text className="text-white font-semibold text-base" numberOfLines={1}>
            {alert.name}
          </Text>
          {/* Action Badge */}
          <View
            className="ml-2 px-2 py-0.5 rounded-full"
            style={{ backgroundColor: actionBadge.bg }}
          >
            <Text style={{ color: actionBadge.text, fontSize: 11, fontWeight: '600' }}>
              {getActionLabel(alert.action)}
            </Text>
          </View>
        </View>
        <View className="flex-row items-center">
          <Pressable
            onPress={handleDeletePress}
            className="p-2 mr-1 active:opacity-60"
            accessibilityRole="button"
            accessibilityLabel={`Delete ${alert.name} alert`}
            hitSlop={8}
          >
            <Ionicons name="trash-outline" size={18} color="#71717a" />
          </Pressable>
          <Switch
            value={alert.enabled}
            onValueChange={(value) => onToggle(alert.id, value)}
            trackColor={{ false: '#3f3f46', true: '#f9731640' }}
            thumbColor={alert.enabled ? '#f97316' : '#71717a'}
            accessibilityRole="switch"
            accessibilityLabel={`${alert.enabled ? 'Disable' : 'Enable'} ${alert.name} alert`}
          />
        </View>
      </View>

      {/* Progress Bar */}
      <View className="h-2 bg-zinc-800 rounded-full overflow-hidden mb-2">
        <View
          className="h-full rounded-full"
          style={{
            width: `${progressWidth}%`,
            backgroundColor: progressColor,
            minWidth: alert.currentSpend > 0 ? 4 : 0,
          }}
        />
      </View>

      {/* Spend Info */}
      <View className="flex-row items-center justify-between">
        <Text className="text-zinc-400 text-sm">
          <Text style={{ color: progressColor, fontWeight: '600' }}>
            {formatCost(alert.currentSpend)}
          </Text>
          {' / '}
          {formatCost(alert.threshold)} {getPeriodLabel(alert.period)}
        </Text>
        <Text
          className="text-sm font-semibold"
          style={{ color: progressColor }}
        >
          {alert.percentUsed.toFixed(0)}%
        </Text>
      </View>

      {/* Exceeded Warning */}
      {alert.percentUsed > 100 && (
        <View className="flex-row items-center mt-2 bg-red-500/10 rounded-lg px-3 py-2">
          <Ionicons name="warning" size={14} color="#ef4444" />
          <Text className="text-red-400 text-xs ml-1.5 font-medium">
            Budget exceeded by {formatCost(alert.currentSpend - alert.threshold)}
          </Text>
        </View>
      )}
    </View>
  );
}

// ============================================================================
// Segmented Control
// ============================================================================

/**
 * Props for a segmented control option.
 */
interface SegmentOption<T extends string> {
  /** The value for this option */
  value: T;
  /** Display label */
  label: string;
}

/**
 * Props for the SegmentedControl component.
 */
interface SegmentedControlProps<T extends string> {
  /** Available options */
  options: SegmentOption<T>[];
  /** Currently selected value */
  selected: T;
  /** Callback when selection changes */
  onSelect: (value: T) => void;
  /** Accessibility label for the control */
  label: string;
}

/**
 * A segmented control (pill picker) for selecting from a set of options.
 *
 * @param props - Component props
 * @returns Rendered segmented control
 */
function SegmentedControl<T extends string>({
  options,
  selected,
  onSelect,
  label,
}: SegmentedControlProps<T>) {
  return (
    <View
      className="flex-row bg-zinc-800 rounded-xl p-1"
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
    >
      {options.map((option) => {
        const isSelected = option.value === selected;
        return (
          <Pressable
            key={option.value}
            onPress={() => onSelect(option.value)}
            className={`flex-1 py-2.5 rounded-lg items-center ${
              isSelected ? 'bg-zinc-700' : ''
            }`}
            accessibilityRole="radio"
            accessibilityState={{ checked: isSelected }}
            accessibilityLabel={option.label}
          >
            <Text
              className={`text-sm font-medium ${
                isSelected ? 'text-white' : 'text-zinc-500'
              }`}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ============================================================================
// Creation Form
// ============================================================================

/**
 * Props for the CreateAlertForm component.
 */
interface CreateAlertFormProps {
  /** Callback when the form is submitted */
  onSubmit: (input: CreateBudgetAlertInput) => Promise<void>;
  /** Callback to close the form */
  onCancel: () => void;
}

/**
 * Form for creating a new budget alert.
 * Includes name input, threshold amount, period selector, and action selector.
 *
 * @param props - Component props
 * @returns Rendered creation form
 */
function CreateAlertForm({ onSubmit, onCancel }: CreateAlertFormProps) {
  const [name, setName] = useState('');
  const [threshold, setThreshold] = useState('');
  const [period, setPeriod] = useState<BudgetAlertPeriod>('daily');
  const [action, setAction] = useState<BudgetAlertAction>('notify');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const periodOptions: SegmentOption<BudgetAlertPeriod>[] = [
    { value: 'daily', label: 'Daily' },
    { value: 'weekly', label: 'Weekly' },
    { value: 'monthly', label: 'Monthly' },
  ];

  const actionOptions: { value: BudgetAlertAction; label: string; description: string; icon: keyof typeof Ionicons.glyphMap }[] = [
    {
      value: 'notify',
      label: 'Notify',
      description: getActionDescription('notify'),
      icon: 'notifications-outline',
    },
    {
      value: 'slowdown',
      label: 'Slowdown',
      description: getActionDescription('slowdown'),
      icon: 'pause-circle-outline',
    },
    {
      value: 'stop',
      label: 'Stop',
      description: getActionDescription('stop'),
      icon: 'stop-circle-outline',
    },
  ];

  /**
   * Validate and submit the form.
   */
  const handleSubmit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      Alert.alert('Missing Name', 'Please enter a name for the alert.');
      return;
    }

    const thresholdNum = parseFloat(threshold);
    if (isNaN(thresholdNum) || thresholdNum <= 0) {
      Alert.alert('Invalid Threshold', 'Please enter a valid amount greater than $0.');
      return;
    }

    setIsSubmitting(true);
    try {
      await onSubmit({
        name: trimmedName,
        threshold: thresholdNum,
        period,
        action,
      });
      onCancel(); // Close form on success
    } catch {
      // Error is already set in the hook; Alert will be shown by the parent
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <View className="bg-zinc-900 rounded-2xl p-4 mb-4">
      <Text className="text-white text-lg font-semibold mb-4">New Budget Alert</Text>

      {/* Name Input */}
      <View className="mb-4">
        <Text className="text-zinc-400 text-sm font-medium mb-2">Name</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="e.g., Daily Limit"
          placeholderTextColor="#52525b"
          className="bg-zinc-800 text-white rounded-xl px-4 py-3 text-base"
          maxLength={50}
          autoFocus
          accessibilityLabel="Alert name"
          accessibilityHint="Enter a descriptive name for the budget alert"
        />
      </View>

      {/* Threshold Input */}
      <View className="mb-4">
        <Text className="text-zinc-400 text-sm font-medium mb-2">Threshold (USD)</Text>
        <View className="flex-row items-center bg-zinc-800 rounded-xl px-4">
          <Text className="text-zinc-500 text-lg mr-1">$</Text>
          <TextInput
            value={threshold}
            onChangeText={setThreshold}
            placeholder="0.00"
            placeholderTextColor="#52525b"
            className="flex-1 text-white py-3 text-base"
            keyboardType="decimal-pad"
            accessibilityLabel="Threshold amount in US dollars"
            accessibilityHint="Enter the spending limit that triggers the alert"
          />
        </View>
      </View>

      {/* Period Selector */}
      <View className="mb-4">
        <Text className="text-zinc-400 text-sm font-medium mb-2">Period</Text>
        <SegmentedControl
          options={periodOptions}
          selected={period}
          onSelect={setPeriod}
          label="Budget period"
        />
      </View>

      {/* Action Selector */}
      <View className="mb-5">
        <Text className="text-zinc-400 text-sm font-medium mb-2">Action</Text>
        {actionOptions.map((opt) => {
          const isSelected = opt.value === action;
          return (
            <Pressable
              key={opt.value}
              onPress={() => setAction(opt.value)}
              className={`flex-row items-center p-3 rounded-xl mb-2 ${
                isSelected ? 'bg-zinc-800 border border-zinc-600' : 'bg-zinc-800/50'
              }`}
              accessibilityRole="radio"
              accessibilityState={{ checked: isSelected }}
              accessibilityLabel={`${opt.label}: ${opt.description}`}
            >
              <View
                className="w-8 h-8 rounded-lg items-center justify-center mr-3"
                style={{
                  backgroundColor: isSelected
                    ? getActionBadgeColor(opt.value).bg
                    : '#3f3f4620',
                }}
              >
                <Ionicons
                  name={opt.icon}
                  size={18}
                  color={isSelected ? getActionBadgeColor(opt.value).text : '#71717a'}
                />
              </View>
              <View className="flex-1">
                <Text className={`text-sm font-medium ${isSelected ? 'text-white' : 'text-zinc-500'}`}>
                  {opt.label}
                </Text>
                <Text className="text-zinc-500 text-xs mt-0.5" numberOfLines={2}>
                  {opt.description}
                </Text>
              </View>
              {isSelected && (
                <Ionicons name="checkmark-circle" size={20} color="#f97316" />
              )}
            </Pressable>
          );
        })}
      </View>

      {/* Action Buttons */}
      <View className="flex-row gap-3">
        <Pressable
          onPress={onCancel}
          className="flex-1 bg-zinc-800 py-3.5 rounded-xl items-center active:opacity-80"
          accessibilityRole="button"
          accessibilityLabel="Cancel creating alert"
          disabled={isSubmitting}
        >
          <Text className="text-zinc-400 font-semibold">Cancel</Text>
        </Pressable>
        <Pressable
          onPress={handleSubmit}
          className="flex-1 bg-brand py-3.5 rounded-xl items-center flex-row justify-center active:opacity-80"
          accessibilityRole="button"
          accessibilityLabel="Save budget alert"
          disabled={isSubmitting}
          style={{ opacity: isSubmitting ? 0.6 : 1 }}
        >
          {isSubmitting ? (
            <ActivityIndicator size="small" color="white" />
          ) : (
            <>
              <Ionicons name="checkmark" size={18} color="white" />
              <Text className="text-white font-semibold ml-1.5">Save</Text>
            </>
          )}
        </Pressable>
      </View>
    </View>
  );
}

// ============================================================================
// Empty State
// ============================================================================

/**
 * Empty state shown when no budget alerts exist.
 *
 * @param props.onCreatePress - Callback when the "Create Alert" button is pressed
 * @returns Rendered empty state
 */
function EmptyState({ onCreatePress }: { onCreatePress: () => void }) {
  return (
    <View className="items-center justify-center py-16 px-6">
      <View className="w-20 h-20 rounded-3xl bg-yellow-500/10 items-center justify-center mb-6">
        <Ionicons name="notifications-off-outline" size={40} color="#eab308" />
      </View>
      <Text className="text-white text-xl font-bold text-center mb-2">
        No budget alerts yet
      </Text>
      <Text className="text-zinc-500 text-center text-base mb-8 leading-5">
        Create your first alert to monitor spending{'\n'}and avoid surprise costs
      </Text>
      <Pressable
        onPress={onCreatePress}
        className="bg-brand px-8 py-4 rounded-2xl flex-row items-center active:opacity-80"
        accessibilityRole="button"
        accessibilityLabel="Create your first budget alert"
      >
        <Ionicons name="add-circle-outline" size={20} color="white" />
        <Text className="text-white text-lg font-semibold ml-2">Create Alert</Text>
      </Pressable>
    </View>
  );
}

// ============================================================================
// Upgrade Prompt
// ============================================================================

/**
 * Upgrade prompt shown to free-tier users who cannot create budget alerts.
 *
 * WHY: Budget alerts are a paid feature. Free users see an explanation of
 * what they'd get and are directed to upgrade. This is not a dark pattern --
 * we are transparent about what the feature does and which plan unlocks it.
 *
 * @returns Rendered upgrade prompt
 */
function UpgradePrompt() {
  const router = useRouter();

  return (
    <View className="items-center justify-center py-16 px-6">
      <View className="w-20 h-20 rounded-3xl bg-brand/10 items-center justify-center mb-6">
        <Ionicons name="lock-closed" size={40} color="#f97316" />
      </View>
      <Text className="text-white text-xl font-bold text-center mb-2">
        Budget Alerts
      </Text>
      <Text className="text-zinc-500 text-center text-base mb-3 leading-5">
        Set spending thresholds and get notified{'\n'}when your AI costs approach limits
      </Text>
      <View className="bg-zinc-900 rounded-2xl p-4 mb-6 w-full">
        <Text className="text-zinc-400 text-sm font-medium mb-3">INCLUDED WITH PRO</Text>
        {[
          'Up to 3 budget alerts',
          'Daily, weekly, or monthly periods',
          'Push notifications when limits hit',
          'Auto-pause sessions on overspend',
        ].map((feature) => (
          <View key={feature} className="flex-row items-center mb-2">
            <Ionicons name="checkmark-circle" size={16} color="#22c55e" />
            <Text className="text-zinc-300 text-sm ml-2">{feature}</Text>
          </View>
        ))}
      </View>
      <Pressable
        onPress={() => {
          // WHY: Navigate to the settings screen where users can manage
          // their subscription. The settings screen has the upgrade flow.
          router.push('/(tabs)/settings');
        }}
        className="bg-brand px-8 py-4 rounded-2xl flex-row items-center active:opacity-80"
        accessibilityRole="button"
        accessibilityLabel="Upgrade to Pro to unlock budget alerts"
      >
        <Ionicons name="arrow-up-circle-outline" size={20} color="white" />
        <Text className="text-white text-lg font-semibold ml-2">Upgrade to Pro</Text>
      </Pressable>
    </View>
  );
}

// ============================================================================
// Main Screen
// ============================================================================

/**
 * Budget Alerts Screen
 *
 * Full management interface for budget alerts. Routes here from the costs tab
 * or directly via the stack navigator.
 *
 * States:
 * - Loading: Shows a centered spinner
 * - Free tier: Shows upgrade prompt
 * - No alerts: Shows empty state with create button
 * - Has alerts: Shows alert list with add button
 * - Creating: Shows inline creation form
 */
export default function BudgetAlertsScreen() {
  const {
    alerts,
    isLoading,
    error,
    createAlert,
    updateAlert,
    deleteAlert,
    tier,
    alertLimit,
  } = useBudgetAlerts();

  const [showCreateForm, setShowCreateForm] = useState(false);

  /**
   * Toggle an alert's enabled state.
   *
   * @param id - Alert UUID
   * @param enabled - New enabled state
   */
  const handleToggle = useCallback(
    (id: string, enabled: boolean) => {
      updateAlert(id, { enabled }).catch(() => {
        // Error is handled by the hook; show alert to user
        Alert.alert('Error', 'Failed to update alert. Please try again.');
      });
    },
    [updateAlert]
  );

  /**
   * Delete an alert by ID.
   *
   * @param id - Alert UUID
   */
  const handleDelete = useCallback(
    (id: string) => {
      deleteAlert(id).catch(() => {
        Alert.alert('Error', 'Failed to delete alert. Please try again.');
      });
    },
    [deleteAlert]
  );

  /**
   * Create a new alert from the form data.
   *
   * @param input - Alert creation input
   */
  const handleCreate = useCallback(
    async (input: CreateBudgetAlertInput) => {
      try {
        await createAlert(input);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create alert';
        Alert.alert('Error', message);
        throw err; // Re-throw so the form knows it failed
      }
    },
    [createAlert]
  );

  // Loading state
  if (isLoading) {
    return (
      <View className="flex-1 bg-zinc-950 items-center justify-center">
        <ActivityIndicator size="large" color="#f97316" />
        <Text className="text-zinc-500 mt-4">Loading alerts...</Text>
      </View>
    );
  }

  // Free tier - show upgrade prompt
  if (tier === 'free') {
    return (
      <ScrollView className="flex-1 bg-zinc-950" contentContainerStyle={{ flexGrow: 1 }}>
        <UpgradePrompt />
      </ScrollView>
    );
  }

  // Check if user can create more alerts
  const canCreateMore = alerts.length < alertLimit;

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-zinc-950"
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={100}
    >
      <ScrollView
        className="flex-1"
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 16,
          paddingBottom: 100,
          flexGrow: alerts.length === 0 && !showCreateForm ? 1 : undefined,
        }}
        keyboardShouldPersistTaps="handled"
      >
        {/* Error Banner */}
        {error && (
          <View className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 mb-4 flex-row items-center">
            <Ionicons name="alert-circle" size={18} color="#ef4444" />
            <Text className="text-red-400 text-sm ml-2 flex-1">{error}</Text>
          </View>
        )}

        {/* Tier Info */}
        <View className="flex-row items-center justify-between mb-4">
          <Text className="text-zinc-500 text-sm">
            {alerts.length} / {alertLimit} alerts used
          </Text>
          <View className="flex-row items-center">
            <View className="w-2 h-2 rounded-full bg-brand mr-1.5" />
            <Text className="text-zinc-500 text-sm capitalize">{tier} plan</Text>
          </View>
        </View>

        {/* Creation Form (shown inline when "Add Alert" is pressed) */}
        {showCreateForm && (
          <CreateAlertForm
            onSubmit={handleCreate}
            onCancel={() => setShowCreateForm(false)}
          />
        )}

        {/* Alerts List */}
        {alerts.length === 0 && !showCreateForm ? (
          <EmptyState onCreatePress={() => setShowCreateForm(true)} />
        ) : (
          alerts.map((alert) => (
            <AlertCard
              key={alert.id}
              alert={alert}
              onToggle={handleToggle}
              onDelete={handleDelete}
            />
          ))
        )}
      </ScrollView>

      {/* Floating Add Button (only shown when there are existing alerts and form is hidden) */}
      {alerts.length > 0 && !showCreateForm && (
        <View className="absolute bottom-8 left-4 right-4">
          <Pressable
            onPress={() => {
              if (!canCreateMore) {
                Alert.alert(
                  'Limit Reached',
                  `You've reached the maximum of ${alertLimit} alerts for your ${tier} plan. Upgrade to add more.`
                );
                return;
              }
              setShowCreateForm(true);
            }}
            className="bg-brand py-4 rounded-2xl flex-row items-center justify-center active:opacity-80"
            style={{ opacity: canCreateMore ? 1 : 0.5 }}
            accessibilityRole="button"
            accessibilityLabel={canCreateMore ? 'Add a new budget alert' : `Alert limit reached for ${tier} plan`}
          >
            <Ionicons name="add-circle-outline" size={22} color="white" />
            <Text className="text-white text-base font-semibold ml-2">Add Alert</Text>
          </Pressable>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}
