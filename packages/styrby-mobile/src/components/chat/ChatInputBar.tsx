/**
 * ChatInputBar
 *
 * Bottom input area for the chat screen: multi-line text field plus the
 * send / stop / voice controls.
 *
 * WHY a dedicated component: The orchestrator owns input state and the
 * send/stop/voice handlers. This component owns layout and which control
 * is visible based on `isAgentThinking`. Splitting allows the input bar
 * to be skinned independently and unit-tested in isolation.
 */

import { View, TextInput, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { VoiceInputConfig } from 'styrby-shared';
import { StopButtonIcon } from '../StopButton';
import { VoiceInput } from '../VoiceInput';

/**
 * Props for {@link ChatInputBar}.
 */
export interface ChatInputBarProps {
  /** Current text in the input field */
  inputText: string;
  /** Called whenever the input text changes */
  onChangeText: (text: string) => void;
  /** Called when the user taps send (after `canSend` becomes true) */
  onSend: () => Promise<void>;
  /** Called when the user taps the stop control while the agent is generating */
  onStop: () => Promise<void>;
  /** Called with a voice transcript when voice input completes */
  onVoiceTranscript: (text: string) => void;
  /** Whether the relay is connected (drives placeholder + editability) */
  isConnected: boolean;
  /** Whether the agent is currently generating (swaps send -> stop button) */
  isAgentThinking: boolean;
  /** Whether the send button should be enabled */
  canSend: boolean;
  /** Voice config from SecureStore (null = mic button hidden) */
  voiceConfig: VoiceInputConfig | null;
}

/**
 * Renders the input row with a context-sensitive primary action button.
 *
 * @param props - {@link ChatInputBarProps}
 * @returns React element for the input bar
 */
export function ChatInputBar({
  inputText,
  onChangeText,
  onSend,
  onStop,
  onVoiceTranscript,
  isConnected,
  isAgentThinking,
  canSend,
  voiceConfig,
}: ChatInputBarProps) {
  return (
    <View className="border-t border-zinc-800 p-4 pb-6">
      <View className="flex-row items-end bg-background-secondary rounded-2xl px-4 py-2">
        <TextInput
          className="flex-1 text-white text-base py-2 max-h-32"
          placeholder={
            isConnected ? 'Message your agent...' : 'Connect to start chatting'
          }
          placeholderTextColor="#71717a"
          value={inputText}
          onChangeText={onChangeText}
          multiline
          editable={isConnected}
          accessibilityLabel="Message input"
          accessibilityHint="Type a message to send to your AI agent"
        />
        {/* WHY: Show the stop button instead of the send button when the agent
         * is actively generating, so the user can cancel without needing a
         * separate UI element. The StopButtonIcon variant fits cleanly in the
         * same circular button space as the send button. */}
        {isAgentThinking ? (
          <StopButtonIcon
            isRunning={isAgentThinking}
            onStop={onStop}
            accessibilityLabel="Stop agent generation"
          />
        ) : (
          <>
            {/* WHY: Voice input button only shown when config is loaded and enabled.
             * The VoiceInput component handles its own state (recording, transcribing,
             * confirm modal). On transcript, we populate the input field so the user
             * can review and edit before the normal send flow kicks in. */}
            <VoiceInput
              config={voiceConfig}
              onTranscript={onVoiceTranscript}
              disabled={!isConnected}
            />
            <Pressable
              onPress={onSend}
              disabled={!canSend}
              className={`ml-2 w-10 h-10 rounded-full items-center justify-center ${
                canSend ? 'bg-brand' : 'bg-zinc-800'
              }`}
              accessibilityRole="button"
              accessibilityLabel="Send message"
              accessibilityState={{ disabled: !canSend }}
            >
              <Ionicons
                name="send"
                size={20}
                color={canSend ? 'white' : '#71717a'}
              />
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}
