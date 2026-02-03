/**
 * Permission Card Component
 *
 * Displays a permission request from an agent with risk level
 * and approve/deny actions.
 */

import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { AgentType } from 'styrby-shared';

/**
 * Risk levels for permissions
 */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/**
 * Permission request data
 */
export interface PermissionRequest {
  id: string;
  sessionId: string;
  agentType: AgentType;
  type: string; // e.g., 'file_write', 'command_execute', 'api_call'
  description: string;
  details?: string;
  riskLevel: RiskLevel;
  timestamp: string;
  filePath?: string;
  command?: string;
}

interface PermissionCardProps {
  permission: PermissionRequest;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  isLoading?: boolean;
}

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

const AGENT_COLORS: Record<AgentType, string> = {
  claude: '#f97316',
  codex: '#22c55e',
  gemini: '#3b82f6',
};

const PERMISSION_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  file_write: 'document-text',
  file_delete: 'trash',
  command_execute: 'terminal',
  api_call: 'globe',
  network_request: 'cloud',
  default: 'help-circle',
};

export function PermissionCard({ permission, onApprove, onDeny, isLoading }: PermissionCardProps) {
  const riskConfig = RISK_CONFIG[permission.riskLevel];
  const agentColor = AGENT_COLORS[permission.agentType];
  const permissionIcon = PERMISSION_ICONS[permission.type] || PERMISSION_ICONS.default;

  return (
    <View
      className="mx-4 my-2 rounded-2xl overflow-hidden"
      style={{ backgroundColor: riskConfig.bgColor }}
    >
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
                <Ionicons name="chevron-forward" size={14} color="#71717a" className="mt-0.5" />
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
            onPress={() => onApprove(permission.id)}
            disabled={isLoading}
            className={`flex-1 flex-row items-center justify-center py-3 rounded-xl mr-2 ${
              isLoading ? 'bg-green-500/30' : 'bg-green-500'
            }`}
          >
            <Ionicons name="checkmark" size={20} color="white" />
            <Text className="text-white font-semibold ml-2">Approve</Text>
          </Pressable>
          <Pressable
            onPress={() => onDeny(permission.id)}
            disabled={isLoading}
            className={`flex-1 flex-row items-center justify-center py-3 rounded-xl ml-2 ${
              isLoading ? 'bg-zinc-700/50' : 'bg-zinc-700'
            }`}
          >
            <Ionicons name="close" size={20} color="#a1a1aa" />
            <Text className="text-zinc-300 font-semibold ml-2">Deny</Text>
          </Pressable>
        </View>

        {/* Quick actions for low risk */}
        {permission.riskLevel === 'low' && (
          <Pressable
            onPress={() => onApprove(permission.id)}
            className="mt-2 flex-row items-center justify-center py-2"
          >
            <Text className="text-zinc-500 text-sm">
              Auto-approve low risk?{' '}
              <Text className="text-brand">Settings →</Text>
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}
