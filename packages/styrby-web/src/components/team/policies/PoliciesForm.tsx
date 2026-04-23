'use client';

/**
 * PoliciesForm
 *
 * Editable form for team policy settings: auto_approve_rules, blocked_tools,
 * and budget_per_seat_usd. Changes are saved via PATCH /api/teams/[id]/policies.
 *
 * WHY client component: all inputs require useState; the save button triggers
 * a fetch mutation. Server-rendering a form with no interactivity would defeat
 * the purpose.
 *
 * WHY Zod validation in the client too:
 *   We validate client-side to give instant feedback before a network round-trip.
 *   The server re-validates with the same Zod schema — client validation is UX
 *   only, server validation is the security boundary.
 *
 * @module components/team/policies/PoliciesForm
 */

import { useState, useCallback } from 'react';
import { Shield, Plus, Trash2, Save } from 'lucide-react';
import { PatchTeamPolicyBodySchema } from '@styrby/shared';
import type { TeamPolicySettings } from '@styrby/shared';

// ============================================================================
// Types
// ============================================================================

export interface PoliciesFormProps {
  /** Current policy settings fetched by the server component. */
  initial: TeamPolicySettings;
  /** Team ID — used in the PATCH API URL. */
  teamId: string;
  /** Whether the current user is allowed to edit (owner/admin). */
  canEdit: boolean;
}

// ============================================================================
// Helper: Tag Input
// ============================================================================

/**
 * A simple chip-based tag input for editing string arrays.
 *
 * @param props.value - Current list of strings
 * @param props.onChange - Called when the list changes
 * @param props.placeholder - Placeholder text for the new-item input
 * @param props.disabled - Whether editing is disabled
 * @param props.ariaLabel - Accessible label for the text input
 * @returns Rendered tag input
 */
function TagInput({
  value,
  onChange,
  placeholder,
  disabled,
  ariaLabel,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  disabled: boolean;
  ariaLabel: string;
}) {
  const [draft, setDraft] = useState('');

  /**
   * Adds the current draft as a new tag on Enter or comma.
   *
   * @param e - KeyboardEvent from the input
   */
  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const trimmed = draft.trim().replace(/,$/, '');
      if (trimmed && !value.includes(trimmed)) {
        onChange([...value, trimmed]);
        setDraft('');
      }
    }
    if (e.key === 'Backspace' && draft === '' && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  }

  /**
   * Removes a tag by index.
   *
   * @param idx - Index of the tag to remove
   */
  function removeTag(idx: number) {
    onChange(value.filter((_, i) => i !== idx));
  }

  return (
    <div
      className={`min-h-10 flex flex-wrap gap-1.5 items-center p-2 bg-zinc-900 border border-zinc-700 rounded-lg focus-within:border-orange-500 transition-colors ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      {value.map((tag, idx) => (
        <span
          key={idx}
          className="inline-flex items-center gap-1 px-2 py-0.5 bg-zinc-700 rounded-md text-zinc-200 text-xs font-mono"
        >
          {tag}
          {!disabled && (
            <button
              onClick={() => removeTag(idx)}
              className="hover:text-red-400 transition-colors ml-0.5"
              aria-label={`Remove ${tag}`}
              type="button"
            >
              <Trash2 size={10} aria-hidden />
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          aria-label={ariaLabel}
          className="bg-transparent text-zinc-300 text-xs placeholder-zinc-600 outline-none flex-1 min-w-20"
        />
      )}
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

/**
 * Team policies editor.
 *
 * Shows current policy settings and, for owners/admins, allows editing them.
 * Validates inputs client-side before sending to the server. All saves are
 * partial — only changed fields are sent.
 *
 * @param props - See {@link PoliciesFormProps}
 */
export function PoliciesForm({ initial, teamId, canEdit }: PoliciesFormProps) {
  const [autoApproveRules, setAutoApproveRules] = useState<string[]>(initial.auto_approve_rules);
  const [blockedTools, setBlockedTools] = useState<string[]>(initial.blocked_tools);
  const [budgetPerSeat, setBudgetPerSeat] = useState<string>(
    initial.budget_per_seat_usd !== null ? String(initial.budget_per_seat_usd) : '',
  );

  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  /**
   * Returns true when local state differs from the initial (committed) values.
   * Prevents unnecessary API calls when nothing changed.
   */
  const isDirty = useCallback((): boolean => {
    const budgetNum = budgetPerSeat === '' ? null : parseFloat(budgetPerSeat);
    return (
      JSON.stringify(autoApproveRules) !== JSON.stringify(initial.auto_approve_rules) ||
      JSON.stringify(blockedTools) !== JSON.stringify(initial.blocked_tools) ||
      budgetNum !== initial.budget_per_seat_usd
    );
  }, [autoApproveRules, blockedTools, budgetPerSeat, initial]);

  /**
   * Validates and sends changed fields to PATCH /api/teams/[id]/policies.
   * Uses Zod schema on the client for instant feedback before the round-trip.
   */
  async function handleSave() {
    setSaveError(null);
    setSaveSuccess(false);

    const budgetNum = budgetPerSeat === '' ? null : parseFloat(budgetPerSeat);

    // Client-side Zod validation (same schema the server uses)
    const patch = {
      auto_approve_rules: autoApproveRules,
      blocked_tools: blockedTools,
      budget_per_seat_usd: budgetNum,
    };

    const result = PatchTeamPolicyBodySchema.safeParse(patch);
    if (!result.success) {
      setSaveError(result.error.errors.map((e) => e.message).join(', '));
      return;
    }

    if (!Number.isNaN(budgetNum) && budgetNum !== null && budgetNum < 0) {
      setSaveError('Budget per seat must be 0 or greater');
      return;
    }

    setIsSaving(true);
    try {
      const res = await fetch(`/api/teams/${teamId}/policies`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });

      if (!res.ok) {
        const data = await res.json() as { error?: string };
        setSaveError(data.error ?? 'Failed to save policies');
        return;
      }

      setSaveSuccess(true);
      // Clear success indicator after 3 seconds
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch {
      setSaveError('Network error - please try again');
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="space-y-8">
      {/* Auto-approve rules */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <Shield size={16} className="text-green-400" aria-hidden />
          <h3 className="text-zinc-200 font-medium text-sm">Auto-approve rules</h3>
        </div>
        <p className="text-zinc-500 text-xs mb-3">
          Tool names that are automatically allowed without requiring human review.
          Press Enter or comma to add a tool name.
        </p>
        <TagInput
          value={autoApproveRules}
          onChange={setAutoApproveRules}
          placeholder={canEdit ? 'Add tool name and press Enter...' : 'No rules configured'}
          disabled={!canEdit}
          ariaLabel="Auto-approve rule tool name"
        />
        {autoApproveRules.length === 0 && (
          <p className="text-zinc-400 text-xs mt-1.5 flex items-center gap-1">
            <Plus size={11} aria-hidden />
            No tools are auto-approved - all tool calls require human review.
          </p>
        )}
      </div>

      {/* Blocked tools */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <Shield size={16} className="text-red-400" aria-hidden />
          <h3 className="text-zinc-200 font-medium text-sm">Blocked tools</h3>
        </div>
        <p className="text-zinc-500 text-xs mb-3">
          Tool names that are blocked outright. Takes precedence over auto-approve rules.
          Press Enter or comma to add.
        </p>
        <TagInput
          value={blockedTools}
          onChange={setBlockedTools}
          placeholder={canEdit ? 'Add tool name and press Enter...' : 'No blocked tools'}
          disabled={!canEdit}
          ariaLabel="Blocked tool name"
        />
        {blockedTools.length === 0 && (
          <p className="text-zinc-400 text-xs mt-1.5">
            No tools are blocked.
          </p>
        )}
      </div>

      {/* Budget per seat */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <h3 className="text-zinc-200 font-medium text-sm">Budget per seat (USD/month)</h3>
        </div>
        <p className="text-zinc-500 text-xs mb-3">
          Monthly spend limit per member. Leave blank for no limit. Triggers an alert
          when any member exceeds this threshold.
        </p>
        <div className="relative max-w-40">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 text-sm pointer-events-none">
            $
          </span>
          <input
            type="number"
            min="0"
            max="100000"
            step="1"
            value={budgetPerSeat}
            onChange={(e) => setBudgetPerSeat(e.target.value)}
            disabled={!canEdit}
            placeholder="Unlimited"
            aria-label="Budget per seat in USD per month"
            className="w-full pl-6 pr-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-zinc-300 text-sm focus:outline-none focus:border-orange-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          />
        </div>
      </div>

      {/* Save button + feedback */}
      {canEdit && (
        <div className="flex items-center gap-4 pt-2 border-t border-zinc-800">
          <button
            onClick={() => void handleSave()}
            disabled={isSaving || !isDirty()}
            className="inline-flex items-center gap-2 px-5 py-2 bg-orange-500 hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
          >
            <Save size={15} aria-hidden />
            {isSaving ? 'Saving...' : 'Save changes'}
          </button>

          {saveSuccess && (
            <span className="text-green-400 text-sm" role="status">
              Saved successfully
            </span>
          )}

          {saveError && (
            <span className="text-red-400 text-sm" role="alert">
              {saveError}
            </span>
          )}
        </div>
      )}

      {!canEdit && (
        <p className="text-zinc-500 text-xs pt-2 border-t border-zinc-800">
          Only team owners and admins can edit policies.
        </p>
      )}
    </div>
  );
}
