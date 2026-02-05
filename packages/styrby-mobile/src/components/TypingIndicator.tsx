/**
 * Typing Indicator Component
 *
 * Displays an animated indicator when an AI agent is "thinking"
 * or processing a request. Shows the agent type and optional status text.
 *
 * @module components/TypingIndicator
 */

import { View, Text, Animated, Easing } from 'react-native';
import { useEffect, useRef } from 'react';
import { Ionicons } from '@expo/vector-icons';
import type { AgentType } from 'styrby-shared';

// ============================================================================
// Types
// ============================================================================

/**
 * Agent state for the typing indicator.
 */
export type AgentState = 'idle' | 'thinking' | 'executing' | 'waiting_permission';

/**
 * Props for the TypingIndicator component.
 */
export interface TypingIndicatorProps {
  /** The agent that is processing */
  agentType: AgentType;
  /** Current agent state */
  state: AgentState;
  /** Optional custom status text */
  statusText?: string;
  /** Size variant */
  size?: 'small' | 'medium' | 'large';
}

// ============================================================================
// Agent Configuration
// ============================================================================

/**
 * Colors for each agent type.
 */
const AGENT_COLORS: Record<AgentType, string> = {
  claude: '#f97316', // orange-500
  codex: '#22c55e', // green-500
  gemini: '#3b82f6', // blue-500
  opencode: '#8b5cf6', // violet-500
  aider: '#ec4899', // pink-500
};

/**
 * Agent names for display.
 */
const AGENT_NAMES: Record<AgentType, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  opencode: 'OpenCode',
  aider: 'Aider',
};

/**
 * Status text for each state.
 */
const STATE_TEXT: Record<AgentState, string> = {
  idle: '',
  thinking: 'is thinking',
  executing: 'is executing',
  waiting_permission: 'needs permission',
};

/**
 * Icon for each state.
 */
const STATE_ICON: Record<AgentState, keyof typeof Ionicons.glyphMap> = {
  idle: 'ellipse',
  thinking: 'ellipsis-horizontal',
  executing: 'terminal',
  waiting_permission: 'shield-checkmark',
};

// ============================================================================
// Size Configuration
// ============================================================================

const SIZE_CONFIG = {
  small: {
    container: 'px-2 py-1',
    dot: 4,
    spacing: 4,
    text: 'text-xs',
    agentDot: 12,
  },
  medium: {
    container: 'px-3 py-2',
    dot: 6,
    spacing: 6,
    text: 'text-sm',
    agentDot: 16,
  },
  large: {
    container: 'px-4 py-3',
    dot: 8,
    spacing: 8,
    text: 'text-base',
    agentDot: 20,
  },
};

// ============================================================================
// Animated Dot Component
// ============================================================================

interface AnimatedDotProps {
  color: string;
  size: number;
  delay: number;
}

/**
 * Single animated dot in the typing indicator.
 */
function AnimatedDot({ color, size, delay }: AnimatedDotProps) {
  const scaleAnim = useRef(new Animated.Value(0.4)).current;
  const opacityAnim = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.parallel([
          Animated.timing(scaleAnim, {
            toValue: 1,
            duration: 400,
            easing: Easing.ease,
            useNativeDriver: true,
          }),
          Animated.timing(opacityAnim, {
            toValue: 1,
            duration: 400,
            easing: Easing.ease,
            useNativeDriver: true,
          }),
        ]),
        Animated.parallel([
          Animated.timing(scaleAnim, {
            toValue: 0.4,
            duration: 400,
            easing: Easing.ease,
            useNativeDriver: true,
          }),
          Animated.timing(opacityAnim, {
            toValue: 0.3,
            duration: 400,
            easing: Easing.ease,
            useNativeDriver: true,
          }),
        ]),
      ])
    );

    animation.start();
    return () => animation.stop();
  }, [delay, scaleAnim, opacityAnim]);

  return (
    <Animated.View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
        transform: [{ scale: scaleAnim }],
        opacity: opacityAnim,
      }}
    />
  );
}

// ============================================================================
// Component
// ============================================================================

/**
 * Typing indicator showing agent is processing.
 *
 * Displays an animated set of dots along with the agent name and status.
 * Only renders when state is not 'idle'.
 *
 * @param props - Component props
 * @returns React element or null if idle
 *
 * @example
 * <TypingIndicator
 *   agentType="claude"
 *   state="thinking"
 * />
 */
export function TypingIndicator({
  agentType,
  state,
  statusText,
  size = 'medium',
}: TypingIndicatorProps) {
  // Don't render for idle state
  if (state === 'idle') {
    return null;
  }

  const config = SIZE_CONFIG[size];
  const color = AGENT_COLORS[agentType];
  const agentName = AGENT_NAMES[agentType];
  const displayText = statusText || STATE_TEXT[state];

  return (
    <View
      className={`flex-row items-center ${config.container} rounded-xl`}
      style={{
        backgroundColor: `${color}10`,
        borderWidth: 1,
        borderColor: `${color}30`,
      }}
    >
      {/* Agent Indicator */}
      <View
        className="rounded-md items-center justify-center"
        style={{
          backgroundColor: color,
          width: config.agentDot,
          height: config.agentDot,
        }}
      >
        <Text
          className="text-white font-bold"
          style={{ fontSize: config.agentDot * 0.5 }}
        >
          {agentName[0]}
        </Text>
      </View>

      {/* Animated Dots */}
      <View
        className="flex-row items-center mx-2"
        style={{ gap: config.spacing }}
      >
        <AnimatedDot color={color} size={config.dot} delay={0} />
        <AnimatedDot color={color} size={config.dot} delay={150} />
        <AnimatedDot color={color} size={config.dot} delay={300} />
      </View>

      {/* Status Text */}
      <Text
        className={`font-medium ${config.text}`}
        style={{ color }}
      >
        {displayText}
      </Text>
    </View>
  );
}

// ============================================================================
// Inline Variant
// ============================================================================

/**
 * Inline typing indicator for chat message lists.
 * Styled to match the ChatMessage component.
 *
 * @param props - Component props
 * @returns React element or null if idle
 *
 * @example
 * <TypingIndicatorInline
 *   agentType="claude"
 *   state="thinking"
 * />
 */
export function TypingIndicatorInline({
  agentType,
  state,
  statusText,
}: Omit<TypingIndicatorProps, 'size'>) {
  // Don't render for idle state
  if (state === 'idle') {
    return null;
  }

  const color = AGENT_COLORS[agentType];
  const agentName = AGENT_NAMES[agentType];
  const displayText = statusText || STATE_TEXT[state];
  const stateIcon = STATE_ICON[state];

  return (
    <View className="px-4 py-3 items-start">
      {/* Agent indicator - matches ChatMessage style */}
      <View className="flex-row items-center mb-2">
        <View
          className="w-5 h-5 rounded-md items-center justify-center"
          style={{ backgroundColor: color }}
        >
          <Text className="text-white text-xs font-bold">{agentName[0]}</Text>
        </View>
        <Text className="text-zinc-400 text-sm ml-2">{agentName}</Text>
        <View className="ml-2 flex-row items-center">
          <Ionicons name={stateIcon} size={14} color={color} />
          <Text className="text-sm ml-1" style={{ color }}>
            {displayText}
          </Text>
        </View>
      </View>

      {/* Message bubble with typing dots */}
      <View
        className="rounded-2xl rounded-bl-md px-4 py-3 bg-zinc-800"
        style={{
          borderLeftWidth: 3,
          borderLeftColor: color,
        }}
      >
        <View className="flex-row items-center" style={{ gap: 6 }}>
          <AnimatedDot color={color} size={8} delay={0} />
          <AnimatedDot color={color} size={8} delay={150} />
          <AnimatedDot color={color} size={8} delay={300} />
        </View>
      </View>
    </View>
  );
}

// ============================================================================
// Minimal Variant
// ============================================================================

/**
 * Minimal typing indicator with just dots.
 * Useful for compact spaces like input areas.
 *
 * @param props - Component props
 * @returns React element or null if idle
 *
 * @example
 * <TypingIndicatorMinimal
 *   agentType="claude"
 *   state="thinking"
 * />
 */
export function TypingIndicatorMinimal({
  agentType,
  state,
}: Pick<TypingIndicatorProps, 'agentType' | 'state'>) {
  // Don't render for idle state
  if (state === 'idle') {
    return null;
  }

  const color = AGENT_COLORS[agentType];

  return (
    <View className="flex-row items-center" style={{ gap: 4 }}>
      <AnimatedDot color={color} size={6} delay={0} />
      <AnimatedDot color={color} size={6} delay={150} />
      <AnimatedDot color={color} size={6} delay={300} />
    </View>
  );
}
