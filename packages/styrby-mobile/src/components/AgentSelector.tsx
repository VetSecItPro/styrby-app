/**
 * Agent Selector Component
 *
 * Dropdown selector for choosing which AI agent to communicate with.
 * Supports Claude, Codex (OpenAI), and Gemini agents.
 *
 * @module components/AgentSelector
 */

import { View, Text, Pressable, Modal } from 'react-native';
import { useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import type { AgentType } from 'styrby-shared';

// ============================================================================
// Types
// ============================================================================

/**
 * Props for the AgentSelector component.
 */
export interface AgentSelectorProps {
  /** Currently selected agent */
  selectedAgent: AgentType | null;
  /** Callback when agent is selected */
  onSelect: (agent: AgentType) => void;
  /** Whether the selector is disabled */
  disabled?: boolean;
  /** Optional list of available agents (defaults to all) */
  availableAgents?: AgentType[];
}

/**
 * Configuration for each agent type.
 */
export interface AgentConfig {
  /** Display name */
  name: string;
  /** Brand color */
  color: string;
  /** Background color with opacity */
  bgColor: string;
  /** Description text */
  description: string;
  /** Icon name */
  icon: keyof typeof Ionicons.glyphMap;
}

// ============================================================================
// Agent Configuration
// ============================================================================

/**
 * Configuration for each supported agent type.
 */
export const AGENT_CONFIG: Record<AgentType, AgentConfig> = {
  claude: {
    name: 'Claude',
    color: '#f97316', // orange-500
    bgColor: 'rgba(249, 115, 22, 0.1)',
    description: 'Anthropic Claude Code',
    icon: 'code-slash',
  },
  codex: {
    name: 'Codex',
    color: '#22c55e', // green-500
    bgColor: 'rgba(34, 197, 94, 0.1)',
    description: 'OpenAI Codex CLI',
    icon: 'logo-github',
  },
  gemini: {
    name: 'Gemini',
    color: '#3b82f6', // blue-500
    bgColor: 'rgba(59, 130, 246, 0.1)',
    description: 'Google Gemini CLI',
    icon: 'sparkles',
  },
  opencode: {
    name: 'OpenCode',
    color: '#8b5cf6', // violet-500
    bgColor: 'rgba(139, 92, 246, 0.1)',
    description: 'Open Source AI Coding',
    icon: 'code-working',
  },
  aider: {
    name: 'Aider',
    color: '#ec4899', // pink-500
    bgColor: 'rgba(236, 72, 153, 0.1)',
    description: 'Aider Pair Programming',
    icon: 'people',
  },
};

/**
 * Default list of all agents.
 * Includes all supported AI coding agents.
 */
const ALL_AGENTS: AgentType[] = ['claude', 'codex', 'gemini', 'opencode', 'aider'];

// ============================================================================
// Component
// ============================================================================

/**
 * Agent selector dropdown component.
 *
 * Displays the currently selected agent and opens a modal to select
 * a different agent when pressed.
 *
 * @param props - Component props
 * @returns React element
 *
 * @example
 * const [agent, setAgent] = useState<AgentType>('claude');
 *
 * <AgentSelector
 *   selectedAgent={agent}
 *   onSelect={setAgent}
 * />
 */
export function AgentSelector({
  selectedAgent,
  onSelect,
  disabled = false,
  availableAgents = ALL_AGENTS,
}: AgentSelectorProps) {
  const [modalVisible, setModalVisible] = useState(false);

  const currentConfig = selectedAgent ? AGENT_CONFIG[selectedAgent] : null;

  /**
   * Handles agent selection from the modal.
   *
   * @param agent - The selected agent type
   */
  const handleSelect = (agent: AgentType) => {
    onSelect(agent);
    setModalVisible(false);
  };

  return (
    <>
      {/* Selector Button */}
      <Pressable
        onPress={() => !disabled && setModalVisible(true)}
        disabled={disabled}
        className={`flex-row items-center px-3 py-2 rounded-xl ${
          disabled ? 'opacity-50' : ''
        }`}
        style={{
          backgroundColor: currentConfig?.bgColor || 'rgba(113, 113, 122, 0.1)',
          borderWidth: 1,
          borderColor: currentConfig?.color
            ? `${currentConfig.color}30`
            : 'rgba(113, 113, 122, 0.2)',
        }}
      >
        {currentConfig ? (
          <>
            <View
              className="w-6 h-6 rounded-lg items-center justify-center"
              style={{ backgroundColor: currentConfig.color }}
            >
              <Text className="text-white text-xs font-bold">
                {currentConfig.name[0]}
              </Text>
            </View>
            <Text
              className="text-sm font-medium ml-2"
              style={{ color: currentConfig.color }}
            >
              {currentConfig.name}
            </Text>
          </>
        ) : (
          <>
            <View className="w-6 h-6 rounded-lg items-center justify-center bg-zinc-700">
              <Ionicons name="help" size={14} color="#a1a1aa" />
            </View>
            <Text className="text-sm font-medium ml-2 text-zinc-400">
              Select Agent
            </Text>
          </>
        )}
        <Ionicons
          name="chevron-down"
          size={16}
          color={currentConfig?.color || '#71717a'}
          style={{ marginLeft: 4 }}
        />
      </Pressable>

      {/* Selection Modal */}
      <Modal
        visible={modalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setModalVisible(false)}
      >
        <Pressable
          className="flex-1 bg-black/50 justify-end"
          onPress={() => setModalVisible(false)}
        >
          <Pressable
            className="bg-zinc-900 rounded-t-3xl p-6"
            onPress={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <View className="flex-row items-center justify-between mb-4">
              <Text className="text-white text-lg font-semibold">
                Select Agent
              </Text>
              <Pressable
                onPress={() => setModalVisible(false)}
                className="p-2"
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Ionicons name="close" size={24} color="#71717a" />
              </Pressable>
            </View>

            {/* Agent Options */}
            <View className="space-y-2">
              {availableAgents.map((agent) => {
                const config = AGENT_CONFIG[agent];
                const isSelected = selectedAgent === agent;

                return (
                  <Pressable
                    key={agent}
                    onPress={() => handleSelect(agent)}
                    className={`flex-row items-center p-4 rounded-xl ${
                      isSelected ? '' : 'bg-zinc-800/50'
                    }`}
                    style={
                      isSelected
                        ? {
                            backgroundColor: config.bgColor,
                            borderWidth: 2,
                            borderColor: config.color,
                          }
                        : undefined
                    }
                  >
                    <View
                      className="w-10 h-10 rounded-xl items-center justify-center"
                      style={{ backgroundColor: config.color }}
                    >
                      <Ionicons name={config.icon} size={20} color="white" />
                    </View>
                    <View className="flex-1 ml-3">
                      <Text
                        className="text-base font-semibold"
                        style={{ color: isSelected ? config.color : '#fafafa' }}
                      >
                        {config.name}
                      </Text>
                      <Text className="text-sm text-zinc-500">
                        {config.description}
                      </Text>
                    </View>
                    {isSelected && (
                      <Ionicons
                        name="checkmark-circle"
                        size={24}
                        color={config.color}
                      />
                    )}
                  </Pressable>
                );
              })}
            </View>

            {/* Bottom safe area */}
            <View className="h-6" />
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

// ============================================================================
// Compact Variant
// ============================================================================

/**
 * Compact horizontal pill selector for agents.
 * Useful for inline agent selection in chat headers.
 *
 * @param props - Component props
 * @returns React element
 *
 * @example
 * <AgentSelectorPills
 *   selectedAgent={agent}
 *   onSelect={setAgent}
 * />
 */
export function AgentSelectorPills({
  selectedAgent,
  onSelect,
  disabled = false,
  availableAgents = ALL_AGENTS,
}: AgentSelectorProps) {
  return (
    <View className="flex-row">
      {availableAgents.map((agent) => {
        const config = AGENT_CONFIG[agent];
        const isSelected = selectedAgent === agent;

        return (
          <Pressable
            key={agent}
            onPress={() => !disabled && onSelect(agent)}
            disabled={disabled}
            className={`flex-row items-center px-3 py-1.5 rounded-full mr-2 ${
              isSelected ? '' : 'opacity-50'
            } ${disabled ? 'opacity-30' : ''}`}
            style={{
              backgroundColor: isSelected ? config.bgColor : 'transparent',
            }}
          >
            <View
              className="w-4 h-4 rounded-md items-center justify-center"
              style={{ backgroundColor: config.color }}
            >
              <Text className="text-white text-xs font-bold">
                {config.name[0]}
              </Text>
            </View>
            <Text
              className="text-sm font-medium ml-2"
              style={{ color: isSelected ? config.color : '#71717a' }}
            >
              {config.name}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
