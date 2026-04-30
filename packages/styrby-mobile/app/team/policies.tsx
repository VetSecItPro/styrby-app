/**
 * Team Policies Screen (Mobile) - Phase 2.3
 *
 * /team/policies
 *
 * Mobile parity of the web /dashboard/team/[teamId]/policies page.
 * Allows team owners and admins to view and edit:
 *   - auto_approve_rules (tool names)
 *   - blocked_tools (tool names)
 *   - budget_per_seat_usd
 *
 * All saves go through the web API route (PATCH /api/teams/[id]/policies)
 * so the server-side validation and audit_log writes are always executed.
 *
 * Navigation:
 *   - Deep-links back to the invitations screen (Phase 2.2) and members screen
 *
 * @module app/team/policies
 */

import {
  View,
  Text,
  ScrollView,
  Pressable,
  TextInput,
  ActivityIndicator,
} from 'react-native';
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTeamManagement } from '../../src/hooks/useTeamManagement';
import { getApiBaseUrl } from '../../src/lib/config';
import type { TeamPolicySettings } from '@styrby/shared';
import { PatchTeamPolicyBodySchema } from '@styrby/shared';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Fetches the team's current policy settings from the web API.
 *
 * @param teamId - Team UUID
 * @returns Policy settings or null on error
 */
async function fetchPolicies(teamId: string): Promise<TeamPolicySettings | null> {
  try {
    const res = await fetch(`${getApiBaseUrl()}/api/teams/${teamId}/policies`);
    if (!res.ok) return null;
    const data = (await res.json()) as { policies: TeamPolicySettings };
    return data.policies;
  } catch {
    return null;
  }
}

// ============================================================================
// Tag List Editor
// ============================================================================

interface TagListEditorProps {
  /** Current list of tags */
  tags: string[];
  /** Called when the list changes */
  onChange: (next: string[]) => void;
  /** Whether the field is read-only */
  readOnly: boolean;
  /** Accessible label for the text input */
  inputLabel: string;
  /** Placeholder text */
  placeholder: string;
}

/**
 * Mobile-friendly tag input for editing string arrays.
 *
 * Tags are displayed as chips. New tags are added by typing and tapping
 * the "Add" button (mobile lacks a keyboard Enter equivalent for this pattern).
 *
 * @param props - See {@link TagListEditorProps}
 */
function TagListEditor({ tags, onChange, readOnly, inputLabel, placeholder }: TagListEditorProps) {
  const [draft, setDraft] = useState('');

  /**
   * Adds the current draft as a new tag.
   */
  function addTag() {
    const trimmed = draft.trim();
    if (trimmed && !tags.includes(trimmed)) {
      onChange([...tags, trimmed]);
      setDraft('');
    }
  }

  /**
   * Removes a tag by index.
   *
   * @param idx - Index of the tag to remove
   */
  function removeTag(idx: number) {
    onChange(tags.filter((_, i) => i !== idx));
  }

  return (
    <View>
      {/* Chips */}
      <View className="flex-row flex-wrap gap-2 mb-2">
        {tags.map((tag, idx) => (
          <View
            key={idx}
            className="flex-row items-center bg-zinc-800 rounded-lg px-2.5 py-1 gap-1.5"
          >
            <Text className="text-zinc-200 text-xs font-mono">{tag}</Text>
            {!readOnly && (
              <Pressable
                onPress={() => removeTag(idx)}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${tag}`}
                className="ml-0.5"
              >
                <Ionicons name="close" size={12} color="#71717a" />
              </Pressable>
            )}
          </View>
        ))}
        {tags.length === 0 && (
          <Text className="text-zinc-600 text-xs">None configured.</Text>
        )}
      </View>

      {/* New tag input */}
      {!readOnly && (
        <View className="flex-row items-center gap-2">
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={placeholder}
            placeholderTextColor="#52525b"
            className="flex-1 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-zinc-300 text-sm font-mono"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={addTag}
            accessibilityLabel={inputLabel}
          />
          <Pressable
            onPress={addTag}
            disabled={!draft.trim()}
            className="bg-zinc-700 px-3 py-2 rounded-lg active:opacity-80 disabled:opacity-40"
            accessibilityRole="button"
            accessibilityLabel="Add tag"
          >
            <Ionicons name="add" size={18} color="#f97316" />
          </Pressable>
        </View>
      )}
    </View>
  );
}

// ============================================================================
// Screen
// ============================================================================

/**
 * Team policies screen.
 *
 * Loads team data via useTeamManagement, then fetches the current policy
 * settings from the API. Renders an editable form for owners/admins and a
 * read-only view for plain members.
 */
export default function TeamPoliciesScreen() {
  const router = useRouter();
  const {
    team,
    currentUserRole,
    isLoading: teamLoading,
  } = useTeamManagement();

  const [policies, setPolicies] = useState<TeamPolicySettings | null>(null);
  const [isLoadingPolicies, setIsLoadingPolicies] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Editable state (mirrors the fetched policies)
  const [autoApprove, setAutoApprove] = useState<string[]>([]);
  const [blockedTools, setBlockedTools] = useState<string[]>([]);
  const [budgetPerSeat, setBudgetPerSeat] = useState<string>('');

  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const canEdit = currentUserRole === 'owner' || currentUserRole === 'admin';

  // ── Load policies ─────────────────────────────────────────────────────────

  const loadPolicies = useCallback(async () => {
    if (!team) return;
    setIsLoadingPolicies(true);
    setLoadError(null);

    const result = await fetchPolicies(team.id);
    if (result) {
      setPolicies(result);
      setAutoApprove(result.auto_approve_rules);
      setBlockedTools(result.blocked_tools);
      setBudgetPerSeat(result.budget_per_seat_usd !== null ? String(result.budget_per_seat_usd) : '');
    } else {
      setLoadError('Failed to load team policies. Pull to retry.');
    }
    setIsLoadingPolicies(false);
  }, [team]);

  useEffect(() => {
    void loadPolicies();
  }, [loadPolicies]);

  // ── Save handler ──────────────────────────────────────────────────────────

  /**
   * Validates and sends the changed policy fields to the API.
   * Validates with the same Zod schema the server uses.
   */
  async function handleSave() {
    if (!team) return;
    setSaveError(null);
    setSaveSuccess(false);

    const budgetNum = budgetPerSeat === '' ? null : parseFloat(budgetPerSeat);
    if (budgetPerSeat !== '' && (Number.isNaN(budgetNum) || (budgetNum !== null && budgetNum < 0))) {
      setSaveError('Budget per seat must be a number 0 or greater');
      return;
    }

    const patch = {
      auto_approve_rules: autoApprove,
      blocked_tools: blockedTools,
      budget_per_seat_usd: budgetNum,
    };

    const result = PatchTeamPolicyBodySchema.safeParse(patch);
    if (!result.success) {
      setSaveError(result.error.errors.map((e) => e.message).join(', '));
      return;
    }

    setIsSaving(true);
    try {
      const res = await fetch(`${getApiBaseUrl()}/api/teams/${team.id}/policies`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setSaveError(data.error ?? 'Failed to save policies');
        return;
      }

      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
      // Reload policies to confirm server accepted
      await loadPolicies();
    } catch {
      setSaveError('Network error - please try again');
    } finally {
      setIsSaving(false);
    }
  }

  // ── Loading states ────────────────────────────────────────────────────────

  if (teamLoading || isLoadingPolicies) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="large" color="#f97316" />
        <Text className="text-zinc-500 mt-4 text-sm">Loading policies...</Text>
      </View>
    );
  }

  if (!team) {
    return (
      <View className="flex-1 bg-background items-center justify-center px-6">
        <Ionicons name="shield-outline" size={48} color="#52525b" />
        <Text className="text-white text-lg font-semibold mt-4">No Team Found</Text>
        <Pressable
          onPress={() => router.back()}
          className="bg-brand px-6 py-3 rounded-xl mt-6 active:opacity-80"
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Text className="text-white font-semibold">Go back</Text>
        </Pressable>
      </View>
    );
  }

  // ── Main render ───────────────────────────────────────────────────────────

  return (
    <ScrollView className="flex-1 bg-background" contentContainerStyle={{ paddingBottom: 48 }}>
      {/* Header */}
      <View className="px-4 py-4 border-b border-zinc-800 flex-row items-center justify-between">
        <View>
          <Text className="text-white text-lg font-semibold">{team.name}</Text>
          <Text className="text-zinc-500 text-sm">Team Policies</Text>
        </View>

        {/* Navigation links */}
        <View className="flex-row gap-2">
          <Pressable
            onPress={() => router.push('/team/members' as never)}
            className="px-3 py-1.5 bg-zinc-800 rounded-lg active:opacity-80"
            accessibilityRole="link"
            accessibilityLabel="Go to members"
          >
            <Text className="text-zinc-300 text-xs font-medium">Members</Text>
          </Pressable>
          <Pressable
            onPress={() => router.push('/team/invitations' as never)}
            className="px-3 py-1.5 bg-orange-500/10 border border-orange-500/30 rounded-lg active:opacity-80"
            accessibilityRole="link"
            accessibilityLabel="Go to invitations"
          >
            <Text className="text-orange-400 text-xs font-medium">Invitations</Text>
          </Pressable>
        </View>
      </View>

      {loadError && (
        <View className="mx-4 mt-4 bg-red-500/10 rounded-lg px-3 py-2">
          <Text className="text-red-400 text-sm">{loadError}</Text>
        </View>
      )}

      {policies && (
        <View className="px-4 py-6 space-y-8">
          {/* Auto-approve rules */}
          <View className="space-y-2">
            <View className="flex-row items-center gap-2 mb-1">
              <Ionicons name="checkmark-circle" size={16} color="#22c55e" />
              <Text className="text-zinc-200 font-medium text-sm">Auto-approve rules</Text>
            </View>
            <Text className="text-zinc-500 text-xs mb-3">
              Tool names that run without human review.
            </Text>
            <TagListEditor
              tags={autoApprove}
              onChange={setAutoApprove}
              readOnly={!canEdit}
              inputLabel="New auto-approve tool name"
              placeholder="e.g. read_file"
            />
          </View>

          <View className="h-px bg-zinc-800 my-2" />

          {/* Blocked tools */}
          <View className="space-y-2">
            <View className="flex-row items-center gap-2 mb-1">
              <Ionicons name="ban" size={16} color="#ef4444" />
              <Text className="text-zinc-200 font-medium text-sm">Blocked tools</Text>
            </View>
            <Text className="text-zinc-500 text-xs mb-3">
              Tool names blocked outright. Overrides auto-approve.
            </Text>
            <TagListEditor
              tags={blockedTools}
              onChange={setBlockedTools}
              readOnly={!canEdit}
              inputLabel="New blocked tool name"
              placeholder="e.g. delete_file"
            />
          </View>

          <View className="h-px bg-zinc-800 my-2" />

          {/* Budget per seat */}
          <View>
            <Text className="text-zinc-200 font-medium text-sm mb-1">
              Budget per seat (USD/month)
            </Text>
            <Text className="text-zinc-500 text-xs mb-3">
              Leave blank for no limit.
            </Text>
            <View className="flex-row items-center">
              <Text className="text-zinc-500 text-sm mr-1">$</Text>
              <TextInput
                value={budgetPerSeat}
                onChangeText={setBudgetPerSeat}
                placeholder="Unlimited"
                placeholderTextColor="#52525b"
                keyboardType="numeric"
                editable={canEdit}
                className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-zinc-300 text-sm w-32"
                accessibilityLabel="Budget per seat in USD per month"
              />
            </View>
          </View>

          {/* Save button */}
          {canEdit && (
            <View className="pt-2">
              <Pressable
                onPress={() => void handleSave()}
                disabled={isSaving}
                className={`py-3 rounded-xl items-center ${isSaving ? 'bg-zinc-700' : 'bg-brand active:opacity-80'}`}
                accessibilityRole="button"
                accessibilityLabel="Save policy changes"
              >
                {isSaving ? (
                  <ActivityIndicator color="#ffffff" size="small" />
                ) : (
                  <Text className="text-white font-semibold">Save changes</Text>
                )}
              </Pressable>

              {saveSuccess && (
                <Text className="text-green-400 text-sm text-center mt-3" accessibilityRole="none">
                  Saved successfully
                </Text>
              )}

              {saveError && (
                <Text className="text-red-400 text-sm text-center mt-3" accessibilityRole="alert">
                  {saveError}
                </Text>
              )}
            </View>
          )}

          {!canEdit && (
            <Text className="text-zinc-600 text-xs text-center pt-2">
              Only team owners and admins can edit policies.
            </Text>
          )}
        </View>
      )}
    </ScrollView>
  );
}
