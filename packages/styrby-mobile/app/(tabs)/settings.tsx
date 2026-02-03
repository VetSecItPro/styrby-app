/**
 * Settings Screen
 *
 * User preferences, account settings, and app configuration.
 */

import { View, Text, ScrollView, Pressable, Switch } from 'react-native';
import { useState } from 'react';
import { Ionicons } from '@expo/vector-icons';

interface SettingRowProps {
  icon: keyof typeof Ionicons.glyphMap;
  iconColor?: string;
  title: string;
  subtitle?: string;
  onPress?: () => void;
  trailing?: React.ReactNode;
}

function SettingRow({
  icon,
  iconColor = '#71717a',
  title,
  subtitle,
  onPress,
  trailing,
}: SettingRowProps) {
  return (
    <Pressable
      className="flex-row items-center px-4 py-3 active:bg-zinc-900"
      onPress={onPress}
      disabled={!onPress && !trailing}
    >
      <View
        className="w-8 h-8 rounded-lg items-center justify-center mr-3"
        style={{ backgroundColor: `${iconColor}20` }}
      >
        <Ionicons name={icon} size={18} color={iconColor} />
      </View>
      <View className="flex-1">
        <Text className="text-white font-medium">{title}</Text>
        {subtitle && <Text className="text-zinc-500 text-sm">{subtitle}</Text>}
      </View>
      {trailing || (onPress && <Ionicons name="chevron-forward" size={20} color="#71717a" />)}
    </Pressable>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <Text className="text-zinc-500 text-xs font-semibold uppercase px-4 py-2 bg-background">
      {title}
    </Text>
  );
}

export default function SettingsScreen() {
  const [pushEnabled, setPushEnabled] = useState(true);
  const [hapticEnabled, setHapticEnabled] = useState(true);

  return (
    <ScrollView className="flex-1 bg-background">
      {/* Account Section */}
      <SectionHeader title="Account" />
      <View className="bg-background-secondary">
        <SettingRow
          icon="person"
          iconColor="#f97316"
          title="Profile"
          subtitle="user@example.com"
          onPress={() => {}}
        />
        <SettingRow
          icon="card"
          iconColor="#22c55e"
          title="Subscription"
          subtitle="Pro Plan"
          onPress={() => {}}
        />
        <SettingRow
          icon="stats-chart"
          iconColor="#3b82f6"
          title="Usage & Costs"
          subtitle="$12.45 this month"
          onPress={() => {}}
        />
      </View>

      {/* Agents Section */}
      <SectionHeader title="Agents" />
      <View className="bg-background-secondary">
        <SettingRow
          icon="terminal"
          iconColor="#f97316"
          title="Claude Code"
          subtitle="Connected"
          onPress={() => {}}
        />
        <SettingRow
          icon="terminal"
          iconColor="#22c55e"
          title="Codex"
          subtitle="Not connected"
          onPress={() => {}}
        />
        <SettingRow
          icon="terminal"
          iconColor="#3b82f6"
          title="Gemini"
          subtitle="Not connected"
          onPress={() => {}}
        />
      </View>

      {/* Preferences Section */}
      <SectionHeader title="Preferences" />
      <View className="bg-background-secondary">
        <SettingRow
          icon="notifications"
          iconColor="#eab308"
          title="Push Notifications"
          trailing={
            <Switch
              value={pushEnabled}
              onValueChange={setPushEnabled}
              trackColor={{ false: '#3f3f46', true: '#f9731650' }}
              thumbColor={pushEnabled ? '#f97316' : '#71717a'}
            />
          }
        />
        <SettingRow
          icon="phone-portrait"
          iconColor="#8b5cf6"
          title="Haptic Feedback"
          trailing={
            <Switch
              value={hapticEnabled}
              onValueChange={setHapticEnabled}
              trackColor={{ false: '#3f3f46', true: '#f9731650' }}
              thumbColor={hapticEnabled ? '#f97316' : '#71717a'}
            />
          }
        />
        <SettingRow
          icon="shield-checkmark"
          iconColor="#06b6d4"
          title="Auto-Approve Low Risk"
          onPress={() => {}}
        />
        <SettingRow
          icon="moon"
          iconColor="#6366f1"
          title="Quiet Hours"
          subtitle="10:00 PM - 7:00 AM"
          onPress={() => {}}
        />
      </View>

      {/* Support Section */}
      <SectionHeader title="Support" />
      <View className="bg-background-secondary">
        <SettingRow
          icon="help-circle"
          iconColor="#71717a"
          title="Help & FAQ"
          onPress={() => {}}
        />
        <SettingRow
          icon="chatbox"
          iconColor="#71717a"
          title="Send Feedback"
          onPress={() => {}}
        />
        <SettingRow
          icon="document-text"
          iconColor="#71717a"
          title="Privacy Policy"
          onPress={() => {}}
        />
        <SettingRow
          icon="document-text"
          iconColor="#71717a"
          title="Terms of Service"
          onPress={() => {}}
        />
      </View>

      {/* Sign Out */}
      <View className="mt-4 mb-8">
        <Pressable className="mx-4 py-3 rounded-xl border border-red-500/30 items-center active:bg-red-500/10">
          <Text className="text-red-500 font-semibold">Sign Out</Text>
        </Pressable>
      </View>

      {/* Version */}
      <Text className="text-zinc-600 text-center text-xs mb-8">
        Styrby v0.1.0 (1)
      </Text>
    </ScrollView>
  );
}
