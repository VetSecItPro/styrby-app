/**
 * Agent Configuration — useAgentConfig hook
 *
 * Encapsulates all Supabase IO and form state for the Agent Configuration
 * screen: initial load, save (insert vs update), reset, blocked-tools list
 * management, unsaved-changes detection, and the success-toast lifecycle.
 *
 * WHY: Splitting the data layer out of the orchestrator keeps the screen file
 * focused on layout. Pure SQL helpers and row mapping live in
 * `agent-config-io.ts` so this hook stays small and reads top-to-bottom.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Keyboard } from 'react-native';
import { supabase } from '@/lib/supabase';
import type { AgentConfigState, AgentMeta, AgentType } from '@/types/agent-config';
import {
  buildRow,
  fetchAgentConfig,
  insertAgentConfig,
  mapRowToState,
  updateAgentConfig,
} from './agent-config-io';
import { DEFAULT_CONFIG } from './constants';
import { hasChanges } from './utils';

/**
 * Public surface returned by {@link useAgentConfig}.
 *
 * WHY: Returning a single object keeps the orchestrator's destructure
 * stable as the hook grows additional fields in future iterations.
 */
export interface UseAgentConfigResult {
  /** Current form state (controlled). */
  config: AgentConfigState;
  /** True while the initial Supabase fetch is in flight. */
  isLoading: boolean;
  /** True while a save request is in flight. */
  isSaving: boolean;
  /** True when there are unsaved changes vs the last-saved snapshot. */
  dirty: boolean;
  /** Visibility of the brief save-success toast. */
  showSaveSuccess: boolean;
  /** Controlled value for the new-blocked-tool input. */
  newBlockedTool: string;
  /** Setter for the new-blocked-tool input. */
  setNewBlockedTool: (value: string) => void;
  /** Update a single field on the form state. */
  updateField: <K extends keyof AgentConfigState>(field: K, value: AgentConfigState[K]) => void;
  /** Add the current `newBlockedTool` value to the blocked tools list. */
  addBlockedTool: () => void;
  /** Remove a tool from the blocked list. */
  removeBlockedTool: (tool: string) => void;
  /** Persist the form state to Supabase. */
  save: () => Promise<void>;
  /** Reset the form to the agent's defaults (with a confirmation alert). */
  reset: () => void;
  /** Snapshot of the last-saved state (used by the orchestrator's nav guard). */
  savedConfig: AgentConfigState;
  /** Forcibly overwrite the current form state with the saved snapshot. */
  discardChanges: () => void;
}

/**
 * Loads, edits, and saves the agent_configs row for the active user/agent.
 *
 * @param agentType - The validated agent identifier from the route param.
 * @param meta - Static metadata for the agent (used for default model fallback).
 * @returns Form state + handlers consumed by the orchestrator.
 */
export function useAgentConfig(agentType: AgentType, meta: AgentMeta): UseAgentConfigResult {
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [configId, setConfigId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  const initial: AgentConfigState = { ...DEFAULT_CONFIG, model: meta.models[0] };
  const [config, setConfig] = useState<AgentConfigState>(initial);
  /**
   * WHY: We keep a snapshot of the last-saved state so we can detect unsaved
   * changes by comparing the current form state against it. Updated after
   * every successful save or load.
   */
  const [savedConfig, setSavedConfig] = useState<AgentConfigState>(initial);

  const [newBlockedTool, setNewBlockedTool] = useState('');
  const [showSaveSuccess, setShowSaveSuccess] = useState(false);

  /**
   * WHY: useRef for the save success timeout so we can clear it on unmount
   * and avoid updating state on an unmounted component.
   */
  const saveSuccessTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Fetches the authenticated user's agent config row from Supabase.
   * If no row exists, uses default values. Populates both `config` and
   * `savedConfig` so unsaved-changes detection starts clean.
   */
  const loadConfig = useCallback(async () => {
    setIsLoading(true);

    try {
      const { data: { user }, error: userError } = await supabase.auth.getUser();

      if (userError || !user) {
        setIsLoading(false);
        return;
      }

      setUserId(user.id);

      const { data, error } = await fetchAgentConfig(user.id, agentType);

      if (error && error.code === 'PGRST116') {
        // WHY: PGRST116 means no row found — expected for first-time users
        // who haven't configured this agent yet. Show defaults.
        const defaults: AgentConfigState = { ...DEFAULT_CONFIG, model: meta.models[0] };
        setConfig(defaults);
        setSavedConfig(defaults);
        setConfigId(null);
      } else if (!error && data) {
        const loaded = mapRowToState(data, meta.models[0]);
        setConfig(loaded);
        setSavedConfig(loaded);
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

  useEffect(() => {
    loadConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentType]);

  // Clean up success toast timeout on unmount
  useEffect(() => {
    return () => {
      if (saveSuccessTimeoutRef.current) {
        clearTimeout(saveSuccessTimeoutRef.current);
      }
    };
  }, []);

  /**
   * Persists the current form state to the Supabase `agent_configs` table.
   * Uses an upsert pattern: if a row exists (configId is set), updates it;
   * otherwise inserts a new row.
   *
   * WHY upsert pattern: The UNIQUE constraint on (user_id, agent_type)
   * guarantees at most one row per user per agent. Insert-or-update keeps
   * the local `configId` in sync after the first save.
   */
  const save = useCallback(async () => {
    if (!userId) {
      Alert.alert('Error', 'You must be signed in to save configuration.');
      return;
    }

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
      const row = buildRow(userId, agentType, config);

      if (configId) {
        const { error } = await updateAgentConfig(configId, row);
        if (error) {
          if (__DEV__) console.error('[AgentConfig] Failed to update config:', error);
          Alert.alert('Save Failed', 'Could not save configuration. Please try again.');
          return;
        }
      } else {
        const { data, error } = await insertAgentConfig(row);
        if (error) {
          if (__DEV__) console.error('[AgentConfig] Failed to insert config:', error);
          Alert.alert('Save Failed', 'Could not save configuration. Please try again.');
          return;
        }
        if (data) setConfigId(data.id);
      }

      // Update saved snapshot so unsaved-changes detection resets
      setSavedConfig({ ...config });

      setShowSaveSuccess(true);
      saveSuccessTimeoutRef.current = setTimeout(() => {
        setShowSaveSuccess(false);
      }, 2000);
    } catch (error) {
      if (__DEV__) console.error('[AgentConfig] Save error:', error);
      Alert.alert('Error', 'An unexpected error occurred while saving.');
    } finally {
      setIsSaving(false);
    }
  }, [userId, config, configId, agentType]);

  /**
   * Resets all form fields to defaults after a confirmation alert.
   */
  const reset = useCallback(() => {
    Alert.alert(
      'Reset to Defaults?',
      'This will clear all custom settings for this agent. Your saved configuration will not be deleted until you save.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: () => {
            setConfig({ ...DEFAULT_CONFIG, model: meta.models[0] });
            setNewBlockedTool('');
          },
        },
      ],
    );
  }, [meta.models]);

  /**
   * Adds the current `newBlockedTool` text to the blocked tools list.
   * Validates that the tool name is non-empty and not already blocked.
   */
  const addBlockedTool = useCallback(() => {
    const trimmed = newBlockedTool.trim();
    if (!trimmed) return;

    if (config.blockedTools.includes(trimmed)) {
      Alert.alert('Already Blocked', `"${trimmed}" is already in the blocked tools list.`);
      return;
    }

    setConfig((prev) => ({ ...prev, blockedTools: [...prev.blockedTools, trimmed] }));
    setNewBlockedTool('');
  }, [newBlockedTool, config.blockedTools]);

  /**
   * Removes a tool from the blocked tools list by its name.
   *
   * @param tool - The tool name to remove
   */
  const removeBlockedTool = useCallback((tool: string) => {
    setConfig((prev) => ({
      ...prev,
      blockedTools: prev.blockedTools.filter((t) => t !== tool),
    }));
  }, []);

  /**
   * Creates a setter callback for a specific config field.
   *
   * @param field - The AgentConfigState key to update
   * @param value - The new value to assign
   */
  const updateField = useCallback(
    <K extends keyof AgentConfigState>(field: K, value: AgentConfigState[K]) => {
      setConfig((prev) => ({ ...prev, [field]: value }));
    },
    [],
  );

  /**
   * Resets the form to the saved snapshot — used by the unsaved-changes
   * discard path so the orchestrator's nav guard stops blocking.
   */
  const discardChanges = useCallback(() => {
    setConfig(savedConfig);
  }, [savedConfig]);

  const dirty = hasChanges(config, savedConfig);

  return {
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
  };
}
