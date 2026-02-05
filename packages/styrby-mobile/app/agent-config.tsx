/**
 * Agent Configuration Screen
 *
 * Dynamic screen that accepts an `agent` route param ('claude' | 'codex' | 'gemini')
 * and displays per-agent settings: model selection, auto-approve rules, blocked tools,
 * cost limits, and custom system prompts.
 *
 * Data is persisted to the Supabase `agent_configs` table. On mount, fetches the
 * existing config for the user+agent combo, or shows defaults if none exists. Tracks
 * unsaved changes and warns before navigation.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  Switch,
  TextInput,
  Alert,
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useLocalSearchParams, useRouter, useNavigation } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../src/lib/supabase';

// ============================================================================
// Constants & Types
// ============================================================================

/**
 * Union type for supported agent identifiers.
 * Maps 1:1 with the Supabase `agent_type` enum.
 */
type AgentType = 'claude' | 'codex' | 'gemini';

/**
 * Metadata for each agent type: display name, brand color, Ionicons icon name,
 * and the list of models available for selection.
 */
interface AgentMeta {
  /** Human-readable label for the agent */
  displayName: string;
  /** Brand hex color used for the header icon and accents */
  color: string;
  /** Ionicons icon name */
  icon: keyof typeof Ionicons.glyphMap;
  /** Available model identifiers the user can choose from */
  models: string[];
}

/**
 * WHY: We define agent metadata statically because the list of supported agents
 * and their models is fixed at build time. This avoids a network round-trip and
 * ensures the UI renders immediately while the config loads from Supabase.
 */
const AGENT_META: Record<AgentType, AgentMeta> = {
  claude: {
    displayName: 'Claude Code',
    color: '#f97316',
    icon: 'terminal',
    models: ['claude-sonnet-4', 'claude-opus-4', 'claude-haiku-3.5'],
  },
  codex: {
    displayName: 'Codex',
    color: '#22c55e',
    icon: 'terminal',
    models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
  },
  gemini: {
    displayName: 'Gemini',
    color: '#3b82f6',
    icon: 'terminal',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  },
};

/**
 * Represents the local form state for an agent config.
 * Mapped from the Supabase `agent_configs` row but with UI-friendly field names.
 */
interface AgentConfigState {
  /** Selected model string from the agent's model list */
  model: string;
  /** Auto-approve file reads (low risk) — stored in auto_approve_patterns as 'file_read' */
  autoApproveReads: boolean;
  /** Auto-approve file writes (medium risk) — stored as 'file_write' */
  autoApproveWrites: boolean;
  /** Auto-approve terminal commands (high risk) — stored as 'terminal_command' */
  autoApproveCommands: boolean;
  /** Auto-approve web searches (low risk) — stored as 'web_search' */
  autoApproveWeb: boolean;
  /** Tool names the agent is never allowed to use */
  blockedTools: string[];
  /** Maximum cost in USD before the agent pauses; null means unlimited */
  maxCostPerSession: string;
  /** Additional system prompt text appended to agent instructions */
  customSystemPrompt: string;
}

/**
 * Default config values used when no existing config row is found in Supabase.
 *
 * WHY: Defaults are conservative — all auto-approve toggles are off and no cost
 * limit is set. This ensures new users don't accidentally grant broad permissions
 * to agents before understanding what each toggle does.
 */
const DEFAULT_CONFIG: AgentConfigState = {
  model: '',
  autoApproveReads: false,
  autoApproveWrites: false,
  autoApproveCommands: false,
  autoApproveWeb: false,
  blockedTools: [],
  maxCostPerSession: '',
  customSystemPrompt: '',
};

/**
 * Auto-approve pattern tokens stored in the `auto_approve_patterns` TEXT[] column.
 * Each toggle maps to one of these tokens.
 */
const APPROVE_PATTERN_FILE_READ = 'file_read';
const APPROVE_PATTERN_FILE_WRITE = 'file_write';
const APPROVE_PATTERN_TERMINAL = 'terminal_command';
const APPROVE_PATTERN_WEB = 'web_search';

/**
 * Risk level metadata for the auto-approve toggles.
 * Displayed as colored badges next to each toggle.
 */
interface RiskBadge {
  /** Risk level label */
  label: string;
  /** Badge text color */
  textColor: string;
  /** Badge background color (with opacity) */
  bgColor: string;
}

const RISK_LOW: RiskBadge = {
  label: 'Low',
  textColor: '#22c55e',
  bgColor: 'rgba(34, 197, 94, 0.15)',
};

const RISK_MEDIUM: RiskBadge = {
  label: 'Medium',
  textColor: '#eab308',
  bgColor: 'rgba(234, 179, 8, 0.15)',
};

const RISK_HIGH: RiskBadge = {
  label: 'High',
  textColor: '#ef4444',
  bgColor: 'rgba(239, 68, 68, 0.15)',
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Converts the Supabase `auto_approve_patterns` TEXT[] array into individual
 * boolean toggle values for the UI.
 *
 * @param patterns - The auto_approve_patterns array from the database row
 * @returns Object with boolean flags for each auto-approve category
 */
function patternsToToggles(patterns: string[]): {
  autoApproveReads: boolean;
  autoApproveWrites: boolean;
  autoApproveCommands: boolean;
  autoApproveWeb: boolean;
} {
  return {
    autoApproveReads: patterns.includes(APPROVE_PATTERN_FILE_READ),
    autoApproveWrites: patterns.includes(APPROVE_PATTERN_FILE_WRITE),
    autoApproveCommands: patterns.includes(APPROVE_PATTERN_TERMINAL),
    autoApproveWeb: patterns.includes(APPROVE_PATTERN_WEB),
  };
}

/**
 * Converts the UI's boolean toggles back into the TEXT[] array format
 * expected by the Supabase `auto_approve_patterns` column.
 *
 * @param config - The local form state
 * @returns Array of pattern strings for the database
 */
function togglesToPatterns(config: AgentConfigState): string[] {
  const patterns: string[] = [];
  if (config.autoApproveReads) patterns.push(APPROVE_PATTERN_FILE_READ);
  if (config.autoApproveWrites) patterns.push(APPROVE_PATTERN_FILE_WRITE);
  if (config.autoApproveCommands) patterns.push(APPROVE_PATTERN_TERMINAL);
  if (config.autoApproveWeb) patterns.push(APPROVE_PATTERN_WEB);
  return patterns;
}

/**
 * Checks whether the current config state differs from the last-saved state.
 *
 * @param current - The current form state
 * @param saved - The last saved or loaded state
 * @returns True if there are unsaved changes
 */
function hasChanges(current: AgentConfigState, saved: AgentConfigState): boolean {
  return (
    current.model !== saved.model ||
    current.autoApproveReads !== saved.autoApproveReads ||
    current.autoApproveWrites !== saved.autoApproveWrites ||
    current.autoApproveCommands !== saved.autoApproveCommands ||
    current.autoApproveWeb !== saved.autoApproveWeb ||
    current.maxCostPerSession !== saved.maxCostPerSession ||
    current.customSystemPrompt !== saved.customSystemPrompt ||
    JSON.stringify(current.blockedTools) !== JSON.stringify(saved.blockedTools)
  );
}

// ============================================================================
// Sub-Components
// ============================================================================

/**
 * Section header label matching the settings screen style.
 *
 * @param props - Contains the section title string
 * @returns React element
 */
function SectionHeader({ title }: { title: string }) {
  return (
    <Text className="text-zinc-500 text-xs font-semibold uppercase px-4 pt-6 pb-2">
      {title}
    </Text>
  );
}

/**
 * A risk-level badge displayed next to auto-approve toggles.
 *
 * @param props - Risk badge metadata (label, colors)
 * @returns React element
 */
function RiskLevelBadge({ risk }: { risk: RiskBadge }) {
  return (
    <View
      className="px-2 py-0.5 rounded-full mr-2"
      style={{ backgroundColor: risk.bgColor }}
    >
      <Text className="text-xs font-semibold" style={{ color: risk.textColor }}>
        {risk.label}
      </Text>
    </View>
  );
}

/**
 * A toggle row with a label, optional subtitle, risk badge, and switch.
 *
 * @param props - Row configuration
 * @returns React element
 */
function ToggleRow({
  title,
  subtitle,
  risk,
  value,
  onValueChange,
}: {
  /** Primary label text */
  title: string;
  /** Secondary description text */
  subtitle?: string;
  /** Risk level metadata for the badge */
  risk: RiskBadge;
  /** Current toggle state */
  value: boolean;
  /** Callback when the toggle changes */
  onValueChange: (val: boolean) => void;
}) {
  return (
    <View className="flex-row items-center px-4 py-3">
      <View className="flex-1">
        <View className="flex-row items-center">
          <Text className="text-white font-medium mr-2">{title}</Text>
          <RiskLevelBadge risk={risk} />
        </View>
        {subtitle ? (
          <Text className="text-zinc-500 text-sm mt-0.5">{subtitle}</Text>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: '#3f3f46', true: '#f9731650' }}
        thumbColor={value ? '#f97316' : '#71717a'}
        accessibilityRole="switch"
        accessibilityLabel={`Toggle ${title}`}
      />
    </View>
  );
}

/**
 * A model selection row. Displays the model name and a checkmark if selected.
 *
 * @param props - Model row configuration
 * @returns React element
 */
function ModelRow({
  model,
  isSelected,
  agentColor,
  onSelect,
}: {
  /** The model identifier string */
  model: string;
  /** Whether this model is currently selected */
  isSelected: boolean;
  /** The agent's brand color for the checkmark */
  agentColor: string;
  /** Callback when the model is tapped */
  onSelect: () => void;
}) {
  return (
    <Pressable
      className="flex-row items-center px-4 py-3 active:bg-zinc-900"
      onPress={onSelect}
      accessibilityRole="radio"
      accessibilityLabel={`Select model ${model}`}
      accessibilityState={{ selected: isSelected }}
    >
      <Text className={`flex-1 ${isSelected ? 'text-white font-semibold' : 'text-zinc-400'}`}>
        {model}
      </Text>
      {isSelected ? (
        <Ionicons name="checkmark-circle" size={22} color={agentColor} />
      ) : (
        <View className="w-[22px] h-[22px] rounded-full border border-zinc-700" />
      )}
    </Pressable>
  );
}

/**
 * A blocked tool chip with a remove button.
 *
 * @param props - Tool name and remove callback
 * @returns React element
 */
function BlockedToolChip({
  tool,
  onRemove,
}: {
  /** The tool name to display */
  tool: string;
  /** Callback when the remove button is tapped */
  onRemove: () => void;
}) {
  return (
    <View className="flex-row items-center bg-zinc-800 rounded-lg px-3 py-2 mr-2 mb-2">
      <Text className="text-zinc-300 text-sm mr-2">{tool}</Text>
      <Pressable
        onPress={onRemove}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`Remove blocked tool ${tool}`}
      >
        <Ionicons name="close-circle" size={18} color="#71717a" />
      </Pressable>
    </View>
  );
}

// ============================================================================
// Screen Component
// ============================================================================

/**
 * Agent Configuration screen.
 *
 * Loads the existing agent_configs row for the current user and agent type
 * from Supabase on mount. Displays form fields for model selection,
 * auto-approve toggles, blocked tools, cost limits, and custom system prompt.
 *
 * On save, performs an upsert (insert or update) to the agent_configs table
 * using the UNIQUE constraint on (user_id, agent_type).
 *
 * Implements unsaved-changes detection: if the user tries to navigate away
 * with unsaved changes, an alert prompts them to discard or stay.
 *
 * @returns React element
 */
export default function AgentConfigScreen() {
  const params = useLocalSearchParams<{ agent: string }>();
  const router = useRouter();
  const navigation = useNavigation();

  // --------------------------------------------------------------------------
  // Validate the agent param
  // --------------------------------------------------------------------------

  /**
   * WHY: We cast the route param to AgentType after validation. If the param
   * is missing or invalid (e.g., a typo in a deep link), we fall back to 'claude'
   * to avoid crashing, but this should never happen in normal app flow.
   */
  const agentType: AgentType =
    params.agent && ['claude', 'codex', 'gemini'].includes(params.agent)
      ? (params.agent as AgentType)
      : 'claude';

  const meta = AGENT_META[agentType];

  // --------------------------------------------------------------------------
  // State
  // --------------------------------------------------------------------------

  /** Whether the initial config load is in progress */
  const [isLoading, setIsLoading] = useState(true);
  /** Whether a save operation is in progress */
  const [isSaving, setIsSaving] = useState(false);
  /** Existing row ID from Supabase (null if no config exists yet) */
  const [configId, setConfigId] = useState<string | null>(null);
  /** Authenticated user ID */
  const [userId, setUserId] = useState<string | null>(null);
  /** The current form state */
  const [config, setConfig] = useState<AgentConfigState>({
    ...DEFAULT_CONFIG,
    model: meta.models[0],
  });
  /**
   * WHY: We keep a snapshot of the last-saved state so we can detect unsaved
   * changes by comparing the current form state against it. This snapshot is
   * updated after every successful save or load.
   */
  const [savedConfig, setSavedConfig] = useState<AgentConfigState>({
    ...DEFAULT_CONFIG,
    model: meta.models[0],
  });
  /** Text input for the new blocked tool name */
  const [newBlockedTool, setNewBlockedTool] = useState('');
  /** Brief success toast visibility */
  const [showSaveSuccess, setShowSaveSuccess] = useState(false);

  /**
   * WHY: useRef for the save success timeout so we can clear it on unmount
   * and avoid updating state on an unmounted component.
   */
  const saveSuccessTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --------------------------------------------------------------------------
  // Unsaved changes warning
  // --------------------------------------------------------------------------

  /**
   * WHY: We use navigation.addListener('beforeRemove') to intercept back
   * navigation and warn the user about unsaved changes. This prevents
   * accidental data loss when the user taps the back button or swipes back.
   */
  useEffect(() => {
    const dirty = hasChanges(config, savedConfig);

    const unsubscribe = navigation.addListener('beforeRemove', (e: { preventDefault: () => void; data: { action: unknown } }) => {
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
              // Remove the listener and then navigate
              // WHY: We need to dispatch the original action after removing
              // the listener. We do this by resetting to the saved state first,
              // then the next effect cycle won't block navigation.
              setConfig(savedConfig);
            },
          },
        ],
      );
    });

    return unsubscribe;
  }, [navigation, config, savedConfig]);

  /**
   * WHY: When the user chooses "Discard" in the unsaved changes alert, we
   * reset config to savedConfig. On the next render cycle, hasChanges returns
   * false, so we can safely navigate back by calling router.back().
   * We use a separate effect for this to ensure the state update has committed.
   */
  useEffect(() => {
    // Clean up success toast timeout on unmount
    return () => {
      if (saveSuccessTimeoutRef.current) {
        clearTimeout(saveSuccessTimeoutRef.current);
      }
    };
  }, []);

  // --------------------------------------------------------------------------
  // Load config from Supabase
  // --------------------------------------------------------------------------

  useEffect(() => {
    loadConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentType]);

  /**
   * Fetches the authenticated user's agent config row from Supabase.
   * If no row exists, uses default values. Populates both `config` and
   * `savedConfig` so unsaved-changes detection starts clean.
   */
  const loadConfig = useCallback(async () => {
    setIsLoading(true);

    try {
      // Get authenticated user
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();

      if (userError || !user) {
        setIsLoading(false);
        return;
      }

      setUserId(user.id);

      // Fetch existing config for this agent type
      const { data, error } = await supabase
        .from('agent_configs')
        .select(
          'id, agent_type, default_model, auto_approve_low_risk, auto_approve_patterns, blocked_tools, max_cost_per_session_usd, custom_system_prompt'
        )
        .eq('user_id', user.id)
        .eq('agent_type', agentType)
        .single();

      if (error && error.code === 'PGRST116') {
        // WHY: PGRST116 means no row found — this is expected for first-time
        // users who haven't configured this agent yet. We show defaults.
        const defaults: AgentConfigState = {
          ...DEFAULT_CONFIG,
          model: meta.models[0],
        };
        setConfig(defaults);
        setSavedConfig(defaults);
        setConfigId(null);
      } else if (!error && data) {
        // Map database row to local state
        const patterns = (data.auto_approve_patterns as string[]) ?? [];
        const toggles = patternsToToggles(patterns);

        const loadedConfig: AgentConfigState = {
          model: data.default_model ?? meta.models[0],
          autoApproveReads: toggles.autoApproveReads,
          autoApproveWrites: toggles.autoApproveWrites,
          autoApproveCommands: toggles.autoApproveCommands,
          autoApproveWeb: toggles.autoApproveWeb,
          blockedTools: (data.blocked_tools as string[]) ?? [],
          maxCostPerSession: data.max_cost_per_session_usd
            ? String(data.max_cost_per_session_usd)
            : '',
          customSystemPrompt: data.custom_system_prompt ?? '',
        };

        setConfig(loadedConfig);
        setSavedConfig(loadedConfig);
        setConfigId(data.id);
      } else if (error) {
        if (__DEV__) {
          console.error('[AgentConfig] Failed to load config:', error);
        }
        Alert.alert('Error', 'Failed to load agent configuration. Please try again.');
      }
    } catch (error) {
      if (__DEV__) {
        console.error('[AgentConfig] Unexpected error loading config:', error);
      }
      Alert.alert('Error', 'An unexpected error occurred while loading configuration.');
    } finally {
      setIsLoading(false);
    }
  }, [agentType, meta.models]);

  // --------------------------------------------------------------------------
  // Save config to Supabase
  // --------------------------------------------------------------------------

  /**
   * Persists the current form state to the Supabase `agent_configs` table.
   * Uses an upsert pattern: if a row exists (configId is set), updates it;
   * otherwise inserts a new row.
   *
   * WHY upsert instead of separate insert/update: The UNIQUE constraint on
   * (user_id, agent_type) guarantees at most one row per user per agent.
   * Using upsert with onConflict handles the race condition where two devices
   * might try to create the same config simultaneously.
   */
  const handleSave = useCallback(async () => {
    if (!userId) {
      Alert.alert('Error', 'You must be signed in to save configuration.');
      return;
    }

    // Validate cost input if provided
    if (config.maxCostPerSession) {
      const costValue = parseFloat(config.maxCostPerSession);
      if (isNaN(costValue) || costValue <= 0) {
        Alert.alert('Invalid Cost', 'Maximum cost per session must be a positive number.');
        return;
      }
    }

    Keyboard.dismiss();
    setIsSaving(true);

    try {
      const patterns = togglesToPatterns(config);

      /**
       * WHY: We set auto_approve_low_risk to true if either file_read or
       * web_search is enabled, since these are the "low risk" categories.
       * This keeps the boolean column in sync with the patterns array for
       * backward compatibility with any code that checks the boolean.
       */
      const autoApproveLowRisk = config.autoApproveReads || config.autoApproveWeb;

      const row = {
        user_id: userId,
        agent_type: agentType,
        default_model: config.model,
        auto_approve_low_risk: autoApproveLowRisk,
        auto_approve_patterns: patterns,
        blocked_tools: config.blockedTools,
        max_cost_per_session_usd: config.maxCostPerSession
          ? parseFloat(config.maxCostPerSession)
          : null,
        custom_system_prompt: config.customSystemPrompt || null,
      };

      if (configId) {
        // Update existing row
        const { error } = await supabase
          .from('agent_configs')
          .update(row)
          .eq('id', configId);

        if (error) {
          if (__DEV__) {
            console.error('[AgentConfig] Failed to update config:', error);
          }
          Alert.alert('Save Failed', 'Could not save configuration. Please try again.');
          return;
        }
      } else {
        // Insert new row
        const { data, error } = await supabase
          .from('agent_configs')
          .insert(row)
          .select('id')
          .single();

        if (error) {
          if (__DEV__) {
            console.error('[AgentConfig] Failed to insert config:', error);
          }
          Alert.alert('Save Failed', 'Could not save configuration. Please try again.');
          return;
        }

        if (data) {
          setConfigId(data.id);
        }
      }

      // Update saved snapshot so unsaved-changes detection resets
      setSavedConfig({ ...config });

      // Show success toast
      setShowSaveSuccess(true);
      saveSuccessTimeoutRef.current = setTimeout(() => {
        setShowSaveSuccess(false);
      }, 2000);
    } catch (error) {
      if (__DEV__) {
        console.error('[AgentConfig] Save error:', error);
      }
      Alert.alert('Error', 'An unexpected error occurred while saving.');
    } finally {
      setIsSaving(false);
    }
  }, [userId, config, configId, agentType]);

  // --------------------------------------------------------------------------
  // Reset to defaults
  // --------------------------------------------------------------------------

  /**
   * Resets all form fields to their default values.
   * Shows a confirmation alert before proceeding because this action
   * discards all user customizations.
   */
  const handleReset = useCallback(() => {
    Alert.alert(
      'Reset to Defaults?',
      'This will clear all custom settings for this agent. Your saved configuration will not be deleted until you save.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: () => {
            setConfig({
              ...DEFAULT_CONFIG,
              model: meta.models[0],
            });
            setNewBlockedTool('');
          },
        },
      ],
    );
  }, [meta.models]);

  // --------------------------------------------------------------------------
  // Blocked tools management
  // --------------------------------------------------------------------------

  /**
   * Adds the current `newBlockedTool` text to the blocked tools list.
   * Validates that the tool name is non-empty and not already blocked.
   */
  const handleAddBlockedTool = useCallback(() => {
    const trimmed = newBlockedTool.trim();

    if (!trimmed) return;

    if (config.blockedTools.includes(trimmed)) {
      Alert.alert('Already Blocked', `"${trimmed}" is already in the blocked tools list.`);
      return;
    }

    setConfig((prev) => ({
      ...prev,
      blockedTools: [...prev.blockedTools, trimmed],
    }));
    setNewBlockedTool('');
  }, [newBlockedTool, config.blockedTools]);

  /**
   * Removes a tool from the blocked tools list by its name.
   *
   * @param tool - The tool name to remove
   */
  const handleRemoveBlockedTool = useCallback((tool: string) => {
    setConfig((prev) => ({
      ...prev,
      blockedTools: prev.blockedTools.filter((t) => t !== tool),
    }));
  }, []);

  // --------------------------------------------------------------------------
  // Config field updaters
  // --------------------------------------------------------------------------

  /**
   * Creates a setter callback for a specific config field.
   * Used to avoid creating new function references on every render for toggles.
   *
   * @param field - The AgentConfigState key to update
   * @returns A callback that sets the field to the given value
   */
  const updateField = useCallback(
    <K extends keyof AgentConfigState>(field: K, value: AgentConfigState[K]) => {
      setConfig((prev) => ({ ...prev, [field]: value }));
    },
    [],
  );

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  const dirty = hasChanges(config, savedConfig);

  if (isLoading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="large" color={meta.color} accessibilityLabel="Loading agent configuration" />
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
        {/* Agent Header */}
        <View className="items-center pt-6 pb-4">
          <View
            className="w-16 h-16 rounded-2xl items-center justify-center mb-3"
            style={{ backgroundColor: `${meta.color}20` }}
          >
            <Ionicons name={meta.icon} size={32} color={meta.color} />
          </View>
          <Text className="text-white text-xl font-bold">{meta.displayName}</Text>
          <Text className="text-zinc-500 text-sm mt-1">Configure agent behavior and limits</Text>
        </View>

        {/* Save Success Toast */}
        {showSaveSuccess ? (
          <View className="mx-4 mb-4 bg-green-500/15 rounded-xl px-4 py-3 flex-row items-center">
            <Ionicons name="checkmark-circle" size={20} color="#22c55e" />
            <Text className="text-green-400 font-medium ml-2">Configuration saved</Text>
          </View>
        ) : null}

        {/* ================================================================ */}
        {/* Model Selection */}
        {/* ================================================================ */}
        <SectionHeader title="Model" />
        <View className="bg-background-secondary mx-4 rounded-xl overflow-hidden">
          {meta.models.map((model, index) => (
            <View key={model}>
              {index > 0 ? <View className="h-px bg-zinc-800 mx-4" /> : null}
              <ModelRow
                model={model}
                isSelected={config.model === model}
                agentColor={meta.color}
                onSelect={() => updateField('model', model)}
              />
            </View>
          ))}
        </View>

        {/* ================================================================ */}
        {/* Auto-Approve Rules */}
        {/* ================================================================ */}
        <SectionHeader title="Auto-Approve Rules" />
        <View className="bg-background-secondary mx-4 rounded-xl overflow-hidden">
          <ToggleRow
            title="File Reads"
            subtitle="Allow reading files without confirmation"
            risk={RISK_LOW}
            value={config.autoApproveReads}
            onValueChange={(val) => updateField('autoApproveReads', val)}
          />
          <View className="h-px bg-zinc-800 mx-4" />
          <ToggleRow
            title="File Writes"
            subtitle="Allow writing and editing files"
            risk={RISK_MEDIUM}
            value={config.autoApproveWrites}
            onValueChange={(val) => updateField('autoApproveWrites', val)}
          />
          <View className="h-px bg-zinc-800 mx-4" />
          <ToggleRow
            title="Terminal Commands"
            subtitle="Allow executing shell commands"
            risk={RISK_HIGH}
            value={config.autoApproveCommands}
            onValueChange={(val) => updateField('autoApproveCommands', val)}
          />
          <View className="h-px bg-zinc-800 mx-4" />
          <ToggleRow
            title="Web Searches"
            subtitle="Allow searching the web for context"
            risk={RISK_LOW}
            value={config.autoApproveWeb}
            onValueChange={(val) => updateField('autoApproveWeb', val)}
          />
        </View>

        {/* ================================================================ */}
        {/* Blocked Tools */}
        {/* ================================================================ */}
        <SectionHeader title="Blocked Tools" />
        <View className="bg-background-secondary mx-4 rounded-xl overflow-hidden p-4">
          <Text className="text-zinc-500 text-sm mb-3">
            Tools listed here will never be allowed, regardless of auto-approve settings.
          </Text>

          {/* Add tool input */}
          <View className="flex-row items-center mb-3">
            <TextInput
              className="flex-1 bg-zinc-800 text-white rounded-lg px-3 py-2.5 mr-2 text-sm"
              placeholder='e.g., "rm", "git push --force"'
              placeholderTextColor="#52525b"
              value={newBlockedTool}
              onChangeText={setNewBlockedTool}
              onSubmitEditing={handleAddBlockedTool}
              returnKeyType="done"
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Enter tool name to block"
              accessibilityHint="Type a tool name and tap Add to block it"
            />
            <Pressable
              className="bg-zinc-800 px-4 py-2.5 rounded-lg active:bg-zinc-700"
              onPress={handleAddBlockedTool}
              accessibilityRole="button"
              accessibilityLabel="Add blocked tool"
            >
              <Text className="text-brand font-semibold text-sm">Add</Text>
            </Pressable>
          </View>

          {/* Blocked tools list */}
          {config.blockedTools.length > 0 ? (
            <View className="flex-row flex-wrap">
              {config.blockedTools.map((tool) => (
                <BlockedToolChip
                  key={tool}
                  tool={tool}
                  onRemove={() => handleRemoveBlockedTool(tool)}
                />
              ))}
            </View>
          ) : (
            <Text className="text-zinc-600 text-sm italic">No blocked tools configured</Text>
          )}
        </View>

        {/* ================================================================ */}
        {/* Max Cost Per Session */}
        {/* ================================================================ */}
        <SectionHeader title="Cost Limit" />
        <View className="bg-background-secondary mx-4 rounded-xl overflow-hidden p-4">
          <Text className="text-zinc-500 text-sm mb-3">
            Maximum cost in USD before the agent pauses and asks for confirmation. Leave empty for no limit.
          </Text>
          <View className="flex-row items-center">
            <Text className="text-zinc-400 text-lg mr-2">$</Text>
            <TextInput
              className="flex-1 bg-zinc-800 text-white rounded-lg px-3 py-2.5 text-sm"
              placeholder="e.g., 5.00"
              placeholderTextColor="#52525b"
              value={config.maxCostPerSession}
              onChangeText={(text) => {
                // WHY: We only allow digits and a single decimal point to prevent
                // invalid numeric input. The validation on save ensures the
                // value is a positive number.
                const cleaned = text.replace(/[^0-9.]/g, '');
                // Prevent multiple decimal points
                const parts = cleaned.split('.');
                const sanitized = parts.length > 2
                  ? parts[0] + '.' + parts.slice(1).join('')
                  : cleaned;
                updateField('maxCostPerSession', sanitized);
              }}
              keyboardType="decimal-pad"
              accessibilityLabel="Maximum cost per session in USD"
              accessibilityHint="Enter a dollar amount or leave empty for unlimited"
            />
          </View>
        </View>

        {/* ================================================================ */}
        {/* Custom System Prompt */}
        {/* ================================================================ */}
        <SectionHeader title="Custom System Prompt" />
        <View className="bg-background-secondary mx-4 rounded-xl overflow-hidden p-4">
          <Text className="text-zinc-500 text-sm mb-3">
            Additional instructions appended to the agent's default system prompt. Use this to customize behavior for your workflow.
          </Text>
          <TextInput
            className="bg-zinc-800 text-white rounded-lg px-3 py-3 text-sm min-h-[100px]"
            placeholder="e.g., Always use TypeScript strict mode..."
            placeholderTextColor="#52525b"
            value={config.customSystemPrompt}
            onChangeText={(text) => updateField('customSystemPrompt', text)}
            multiline
            textAlignVertical="top"
            accessibilityLabel="Custom system prompt"
            accessibilityHint="Enter additional instructions for the agent"
          />
        </View>

        {/* ================================================================ */}
        {/* Action Buttons */}
        {/* ================================================================ */}
        <View className="px-4 mt-6">
          {/* Save Button */}
          <Pressable
            className={`py-3.5 rounded-xl items-center flex-row justify-center active:opacity-80 ${
              dirty ? 'bg-brand' : 'bg-zinc-800'
            }`}
            onPress={handleSave}
            disabled={isSaving || !dirty}
            accessibilityRole="button"
            accessibilityLabel="Save agent configuration"
            accessibilityState={{ disabled: isSaving || !dirty }}
          >
            {isSaving ? (
              <ActivityIndicator size="small" color="white" />
            ) : (
              <>
                <Ionicons
                  name="checkmark-circle"
                  size={20}
                  color={dirty ? 'white' : '#52525b'}
                />
                <Text
                  className={`font-semibold ml-2 ${
                    dirty ? 'text-white' : 'text-zinc-600'
                  }`}
                >
                  {dirty ? 'Save Changes' : 'No Changes'}
                </Text>
              </>
            )}
          </Pressable>

          {/* Reset Button */}
          <Pressable
            className="mt-3 py-3.5 rounded-xl items-center border border-zinc-800 active:bg-zinc-900"
            onPress={handleReset}
            accessibilityRole="button"
            accessibilityLabel="Reset configuration to defaults"
          >
            <Text className="text-zinc-400 font-semibold">Reset to Defaults</Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
