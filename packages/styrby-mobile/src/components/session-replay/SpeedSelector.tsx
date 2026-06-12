/**
 * SpeedSelector — dropdown for choosing playback speed.
 *
 * Extracted from SessionReplay.tsx (Cluster A2 split).
 *
 * @module components/session-replay/SpeedSelector
 */

import { useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { PlaybackSpeed } from './types';
import { SPEED_OPTIONS } from './constants';

/**
 * Dropdown for selecting playback speed.
 *
 * @param props.speed - Current speed.
 * @param props.onSpeedChange - Called with the newly selected speed.
 */
export function SpeedSelector({
  speed,
  onSpeedChange,
}: {
  speed: PlaybackSpeed;
  onSpeedChange: (speed: PlaybackSpeed) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <View className="relative">
      <Pressable
        onPress={() => setIsOpen(!isOpen)}
        className="flex-row items-center px-3 py-1.5 rounded-lg bg-zinc-800"
        accessibilityRole="button"
        accessibilityLabel={`Playback speed: ${speed}x`}
      >
        <Text className="text-white text-sm font-medium">{speed}x</Text>
        <Ionicons
          name={isOpen ? 'chevron-up' : 'chevron-down'}
          size={16}
          color="#71717a"
          style={{ marginLeft: 4 }}
        />
      </Pressable>

      {isOpen && (
        <View className="absolute bottom-full mb-1 right-0 bg-zinc-800 rounded-lg border border-zinc-700 overflow-hidden z-10">
          {SPEED_OPTIONS.map((option) => (
            <Pressable
              key={option}
              onPress={() => {
                onSpeedChange(option);
                setIsOpen(false);
              }}
              className={`px-4 py-2 ${speed === option ? 'bg-zinc-700' : ''}`}
              accessibilityRole="button"
              accessibilityLabel={`Set speed to ${option}x`}
            >
              <Text
                className={`text-sm ${
                  speed === option ? 'text-orange-500 font-medium' : 'text-white'
                }`}
              >
                {option}x
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}
