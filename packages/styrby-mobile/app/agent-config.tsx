/**
 * Agent Configuration Screen — Orchestrator
 *
 * Dynamic screen that accepts an `agent` route param (any of the 11 supported
 * AgentType values) and displays per-agent settings: model selection,
 * auto-approve rules, blocked tools, cost limits, and custom system prompts.
 *
 * Data is persisted to the Supabase `agent_configs` table. On mount, fetches
 * the existing config for the user+agent combo, or shows defaults if none
 * exists. Tracks unsaved changes and warns before navigation.
 *
 * WHY orchestrator pattern: This file owns the route-param parsing, the
 * navigation guard, and top-level layout only. Form state, Supabase IO, and
 * each visual section live in `src/components/agent-config/`. Per CLAUDE.md
 * "Component-First Architecture" rules — no monolith page files.
 *
 * @see src/components/agent-config — sub-components and hook
 */

import { useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import {
  ActionButtons,
  AgentHeader,
  AGENT_META,
  ALL_AGENT_IDS,
  AutoApproveSection,
  BlockedToolsSection,
  CostLimitSection,
  CustomPromptSection,
  ModelSection,
  SaveSuccessToast,
} from '@/components/agent-config';
import { useAgentConfig } from '@/components/agent-config/use-agent-config';
import type { AgentType } from '@/types/agent-config';

/**
 * Agent Configuration screen.
 *
 * On save, performs an upsert (insert or update) to the agent_configs table
 * using the UNIQUE constraint on (user_id, agent_type). Implements
 * unsaved-changes detection: if the user tries to navigate away with unsaved
 * changes, an alert prompts them to discard or stay.
 *
 * @returns React element
 */
export default function AgentConfigScreen() {
  const params = useLocalSearchParams<{ agent: string }>();
  const navigation = useNavigation();

  /**
   * WHY: We cast the route param to AgentType after validating it against
   * ALL_AGENT_IDS. If the param is missing or invalid (e.g., a typo in a
   * deep link), we fall back to 'claude' to avoid crashing. In normal app
   * flow this guard should never trigger — AgentSelector only emits valid ids.
   */
  const agentType: AgentType =
    params.agent && (ALL_AGENT_IDS as string[]).includes(params.agent)
      ? (params.agent as AgentType)
      : 'claude';

  const meta = AGENT_META[agentType];

  const {
    config,
    isLoading,
    isSaving,
    dirty,
    showSaveSuccess,
    newBlockedTool,
    setNewBlockedTool,
    updateField,
    addBlockedTool,
    removeBlockedTool,
    save,
    reset,
    savedConfig,
    discardChanges,
  } = useAgentConfig(agentType, meta);

  /**
   * WHY: We use navigation.addListener('beforeRemove') to intercept back
   * navigation and warn the user about unsaved changes. This prevents
   * accidental data loss when the user taps the back button or swipes back.
   */
  useEffect(() => {
    const unsubscribe = navigation.addListener(
      'beforeRemove',
      (e: { preventDefault: () => void; data: { action: unknown } }) => {
        if (!dirty) return;

        // Prevent the default back action
        e.preventDefault();

        Alert.alert(
          'Discard Changes?',
          'You have unsaved changes. Are you sure you want to discard them?',
          [
            { text: 'Keep Editing', style: 'cancel' },
            {
              text: 'Discard',
              style: 'destructive',
              onPress: () => {
                // WHY: Reset to the saved state so the next render no longer
                // marks the form dirty. The next user-triggered back action
                // then proceeds normally because this listener short-circuits.
                discardChanges();
              },
            },
          ],
        );
      },
    );

    return unsubscribe;
  }, [navigation, dirty, savedConfig, discardChanges]);

  if (isLoading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator
          size="large"
          color={meta.color}
          accessibilityLabel="Loading agent configuration"
        />
        <Text className="text-zinc-500 mt-4 text-sm">Loading configuration...</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-background"
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={100}
    >
      <ScrollView
        className="flex-1"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 40 }}
      >
        <AgentHeader meta={meta} />

        <SaveSuccessToast visible={showSaveSuccess} />

        <ModelSection
          meta={meta}
          selectedModel={config.model}
          onSelect={(model) => updateField('model', model)}
        />

        <AutoApproveSection config={config} onToggle={updateField} />

        <BlockedToolsSection
          blockedTools={config.blockedTools}
          newBlockedTool={newBlockedTool}
          onNewBlockedToolChange={setNewBlockedTool}
          onAdd={addBlockedTool}
          onRemove={removeBlockedTool}
        />

        <CostLimitSection
          value={config.maxCostPerSession}
          onChange={(text) => updateField('maxCostPerSession', text)}
        />

        <CustomPromptSection
          value={config.customSystemPrompt}
          onChange={(text) => updateField('customSystemPrompt', text)}
        />

        <ActionButtons dirty={dirty} isSaving={isSaving} onSave={save} onReset={reset} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
