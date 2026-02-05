/**
 * Permission Card Component
 *
 * Displays a permission request from an agent with risk level
 * and approve/deny actions. Includes visual feedback when a
 * decision is made (color change, disabled buttons, status text).
 */

import { View, Text, Pressable, Animated } from 'react-native';
import { useState, useRef, useCallback, useEffect } from 'react';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import type { AgentType } from 'styrby-shared';

/**
 * Risk levels for permissions
 */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/**
 * The decision state of a permission card after the user acts on it.
 * - 'pending': user has not yet acted
 * - 'approved': user approved the request
 * - 'denied': user denied the request
 */
export type PermissionDecision = 'pending' | 'approved' | 'denied';

/**
 * Permission request data received from the CLI agent via the relay.
 *
 * @property id - Unique identifier for this permission request
 * @property sessionId - The session in which the agent made this request
 * @property agentType - Which AI agent is requesting the permission
 * @property type - Category of permission (e.g., 'file_write', 'command_execute')
 * @property description - Human-readable explanation of what the agent wants to do
 * @property details - Additional context about the request
 * @property riskLevel - Assessed severity of the requested action
 * @property timestamp - ISO 8601 timestamp of when the request was created
 * @property filePath - File path affected, if applicable
 * @property command - Shell command to execute, if applicable
 */
export interface PermissionRequest {
  id: string;
  sessionId: string;
  agentType: AgentType;
  type: string;
  description: string;
  details?: string;
  riskLevel: RiskLevel;
  timestamp: string;
  filePath?: string;
  command?: string;
}

/**
 * Props for the PermissionCard component.
 *
 * @property permission - The permission request data to display
 * @property onApprove - Callback when the user approves the request
 * @property onDeny - Callback when the user denies the request
 * @property isLoading - Whether the parent is processing (external loading state)
 */
interface PermissionCardProps {
  permission: PermissionRequest;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  isLoading?: boolean;
}

/**
 * Visual configuration for each risk level.
 */
const RISK_CONFIG: Record<RiskLevel, { label: string; color: string; bgColor: string; icon: keyof typeof Ionicons.glyphMap }> = {
  low: {
    label: 'Low Risk',
    color: '#22c55e',
    bgColor: 'rgba(34, 197, 94, 0.1)',
    icon: 'shield-checkmark',
  },
  medium: {
    label: 'Medium Risk',
    color: '#eab308',
    bgColor: 'rgba(234, 179, 8, 0.1)',
    icon: 'shield-half',
  },
  high: {
    label: 'High Risk',
    color: '#f97316',
    bgColor: 'rgba(249, 115, 22, 0.1)',
    icon: 'warning',
  },
  critical: {
    label: 'Critical',
    color: '#ef4444',
    bgColor: 'rgba(239, 68, 68, 0.15)',
    icon: 'alert-circle',
  },
};

/**
 * Brand colors for each agent type.
 */
const AGENT_COLORS: Record<AgentType, string> = {
  claude: '#f97316',
  codex: '#22c55e',
  gemini: '#3b82f6',
  opencode: '#8b5cf6',
  aider: '#ec4899',
};

/**
 * Icons for each permission type.
 */
const PERMISSION_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  file_write: 'document-text',
  file_delete: 'trash',
  command_execute: 'terminal',
  api_call: 'globe',
  network_request: 'cloud',
  default: 'help-circle',
};

/**
 * Visual configuration for the decided state of the card (approved/denied).
 * WHY: After the user takes action, the card must clearly communicate what
 * happened to prevent confusion and accidental double-taps.
 */
const DECISION_CONFIG: Record<Exclude<PermissionDecision, 'pending'>, {
  label: string;
  color: string;
  bgColor: string;
  icon: keyof typeof Ionicons.glyphMap;
}> = {
  approved: {
    label: 'Approved',
    color: '#22c55e',
    bgColor: 'rgba(34, 197, 94, 0.15)',
    icon: 'checkmark-circle',
  },
  denied: {
    label: 'Denied',
    color: '#ef4444',
    bgColor: 'rgba(239, 68, 68, 0.15)',
    icon: 'close-circle',
  },
};

/**
 * Renders a permission request card with risk level, action details,
 * and approve/deny buttons. After the user acts, the card transitions
 * to show a visual confirmation (color change, status badge, disabled buttons).
 *
 * @param props - Component props
 * @returns React element for the permission card
 *
 * @example
 * <PermissionCard
 *   permission={permissionData}
 *   onApprove={(id) => handleApprove(id)}
 *   onDeny={(id) => handleDeny(id)}
 * />
 */
export function PermissionCard({ permission, onApprove, onDeny, isLoading }: PermissionCardProps) {
  const riskConfig = RISK_CONFIG[permission.riskLevel];
  const agentColor = AGENT_COLORS[permission.agentType] ?? '#71717a';
  const permissionIcon = PERMISSION_ICONS[permission.type] || PERMISSION_ICONS.default;

  /**
   * WHY: Track the decision state locally so the card can show feedback
   * immediately, before the parent removes the permission from the list.
   * This prevents the card from disappearing with no visual confirmation.
   */
  const [decision, setDecision] = useState<PermissionDecision>('pending');
  const [isActing, setIsActing] = useState(false);

  /**
   * WHY: Animate the card background when a decision is made to draw
   * the user's attention to the feedback. A subtle opacity flash
   * communicates that the action was registered.
   */
  const feedbackOpacity = useRef(new Animated.Value(0)).current;

  /**
   * Plays the feedback animation when a decision is made.
   * Flashes the decision color overlay then fades it to a steady state.
   */
  useEffect(() => {
    if (decision !== 'pending') {
      Animated.sequence([
        Animated.timing(feedbackOpacity, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.timing(feedbackOpacity, {
          toValue: 0.6,
          duration: 300,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [decision, feedbackOpacity]);

  /**
   * Handles the approve button press.
   * Sets local decision state, triggers haptic feedback, then calls the parent callback.
   * Prevents double-taps by checking the isActing flag.
   */
  const handleApprove = useCallback(async () => {
    if (isActing || decision !== 'pending') return;
    setIsActing(true);
    setDecision('approved');
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    onApprove(permission.id);
  }, [isActing, decision, permission.id, onApprove]);

  /**
   * Handles the deny button press.
   * Sets local decision state, triggers haptic feedback, then calls the parent callback.
   * Prevents double-taps by checking the isActing flag.
   */
  const handleDeny = useCallback(async () => {
    if (isActing || decision !== 'pending') return;
    setIsActing(true);
    setDecision('denied');
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    onDeny(permission.id);
  }, [isActing, decision, permission.id, onDeny]);

  const isPending = decision === 'pending';
  const decisionConfig = decision !== 'pending' ? DECISION_CONFIG[decision] : null;
  const buttonsDisabled = isLoading || isActing || !isPending;

  return (
    <View
      className="mx-4 my-2 rounded-2xl overflow-hidden"
      style={{ backgroundColor: riskConfig.bgColor }}
      accessibilityRole="none"
      accessibilityLabel={`Permission request: ${permission.description}. Risk level: ${riskConfig.label}`}
    >
      {/* Decision feedback overlay */}
      {decisionConfig && (
        <Animated.View
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: decisionConfig.bgColor,
            opacity: feedbackOpacity,
            borderRadius: 16,
            zIndex: 0,
          }}
          pointerEvents="none"
        />
      )}

      {/* Risk Banner */}
      <View
        className="flex-row items-center justify-between px-4 py-2"
        style={{ backgroundColor: `${riskConfig.color}15` }}
      >
        <View className="flex-row items-center">
          <Ionicons name={riskConfig.icon} size={16} color={riskConfig.color} />
          <Text style={{ color: riskConfig.color }} className="text-sm font-semibold ml-2">
            {riskConfig.label}
          </Text>
        </View>
        <View className="flex-row items-center">
          {/* Decision badge (shown after approve/deny) */}
          {decisionConfig && (
            <View className="flex-row items-center mr-3">
              <Ionicons name={decisionConfig.icon} size={14} color={decisionConfig.color} />
              <Text
                style={{ color: decisionConfig.color }}
                className="text-xs font-bold ml-1"
              >
                {decisionConfig.label}
              </Text>
            </View>
          )}
          <View style={{ backgroundColor: agentColor }} className="w-2 h-2 rounded-full" />
          <Text className="text-zinc-400 text-xs ml-2 capitalize">{permission.agentType}</Text>
        </View>
      </View>

      {/* Content */}
      <View className="p-4">
        {/* Header */}
        <View className="flex-row items-start">
          <View
            className="w-10 h-10 rounded-xl items-center justify-center"
            style={{ backgroundColor: `${riskConfig.color}20` }}
          >
            <Ionicons name={permissionIcon} size={20} color={riskConfig.color} />
          </View>
          <View className="flex-1 ml-3">
            <Text className="text-zinc-100 font-semibold text-base">
              {permission.description}
            </Text>
            <Text className="text-zinc-500 text-sm mt-1 capitalize">
              {permission.type.replace(/_/g, ' ')}
            </Text>
          </View>
        </View>

        {/* Details */}
        {(permission.filePath || permission.command || permission.details) && (
          <View className="mt-3 bg-zinc-900/50 rounded-lg p-3">
            {permission.filePath && (
              <View className="flex-row items-center mb-2">
                <Ionicons name="folder-outline" size={14} color="#71717a" />
                <Text className="text-zinc-400 text-sm ml-2 font-mono" numberOfLines={1}>
                  {permission.filePath}
                </Text>
              </View>
            )}
            {permission.command && (
              <View className="flex-row items-start">
                <Ionicons name="chevron-forward" size={14} color="#71717a" />
                <Text className="text-zinc-300 text-sm ml-2 font-mono flex-1" numberOfLines={3}>
                  {permission.command}
                </Text>
              </View>
            )}
            {permission.details && !permission.filePath && !permission.command && (
              <Text className="text-zinc-400 text-sm">{permission.details}</Text>
            )}
          </View>
        )}

        {/* Actions */}
        <View className="flex-row mt-4">
          <Pressable
            onPress={handleApprove}
            disabled={buttonsDisabled}
            className={`flex-1 flex-row items-center justify-center py-3 rounded-xl mr-2 ${
              decision === 'approved'
                ? 'bg-green-500'
                : buttonsDisabled
                  ? 'bg-green-500/30'
                  : 'bg-green-500'
            }`}
            style={{ opacity: buttonsDisabled && decision !== 'approved' ? 0.4 : 1 }}
            accessibilityRole="button"
            accessibilityLabel={`Approve ${permission.description}`}
            accessibilityState={{ disabled: buttonsDisabled }}
          >
            <Ionicons
              name={decision === 'approved' ? 'checkmark-circle' : 'checkmark'}
              size={20}
              color="white"
            />
            <Text className="text-white font-semibold ml-2">
              {decision === 'approved' ? 'Approved' : 'Approve'}
            </Text>
          </Pressable>
          <Pressable
            onPress={handleDeny}
            disabled={buttonsDisabled}
            className={`flex-1 flex-row items-center justify-center py-3 rounded-xl ml-2 ${
              decision === 'denied'
                ? 'bg-red-500/60'
                : buttonsDisabled
                  ? 'bg-zinc-700/50'
                  : 'bg-zinc-700'
            }`}
            style={{ opacity: buttonsDisabled && decision !== 'denied' ? 0.4 : 1 }}
            accessibilityRole="button"
            accessibilityLabel={`Deny ${permission.description}`}
            accessibilityState={{ disabled: buttonsDisabled }}
          >
            <Ionicons
              name={decision === 'denied' ? 'close-circle' : 'close'}
              size={20}
              color={decision === 'denied' ? 'white' : '#a1a1aa'}
            />
            <Text
              className="font-semibold ml-2"
              style={{ color: decision === 'denied' ? 'white' : '#d4d4d8' }}
            >
              {decision === 'denied' ? 'Denied' : 'Deny'}
            </Text>
          </Pressable>
        </View>

        {/* Quick actions for low risk (only when still pending) */}
        {permission.riskLevel === 'low' && isPending && (
          <Pressable
            onPress={handleApprove}
            disabled={buttonsDisabled}
            className="mt-2 flex-row items-center justify-center py-2"
            accessibilityRole="button"
            accessibilityLabel="Open settings to auto-approve low risk permissions"
          >
            <Text className="text-zinc-500 text-sm">
              Auto-approve low risk?{' '}
              <Text className="text-brand">Settings</Text>
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}
