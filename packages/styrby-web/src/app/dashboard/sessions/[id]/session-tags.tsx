'use client';

/**
 * Session Tag Editor
 *
 * Client component for viewing and editing tags on a session.
 * Shows existing tags as removable badges and provides an input
 * to add new tags. Persists changes to Supabase via the client.
 *
 * WHY: Tags enable cost attribution by client or project. Developers
 * working on multiple client projects need to retroactively tag sessions
 * so they can generate accurate cost breakdowns for invoicing.
 *
 * @module dashboard/sessions/[id]/session-tags
 */

import { useState, useCallback, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';

/* ──────────────────────────── Types ──────────────────────────── */

/**
 * Props for the SessionTagEditor component.
 */
interface SessionTagEditorProps {
  /** The session ID to update tags on */
  sessionId: string;
  /** Initial tags from server-fetched session data */
  initialTags: string[];
}

/* ──────────────────────────── Component ──────────────────────── */

/**
 * Renders editable tag badges with add/remove functionality.
 *
 * Tags are persisted to the `sessions.tags` column in Supabase on every
 * change. The component uses optimistic updates for instant feedback,
 * reverting on failure.
 *
 * @param props - Component props with sessionId and initial tags
 * @returns Tag badges with inline add input
 *
 * @example
 * <SessionTagEditor sessionId="abc-123" initialTags={["acme-corp"]} />
 */
export function SessionTagEditor({ sessionId, initialTags }: SessionTagEditorProps) {
  const [tags, setTags] = useState<string[]>(initialTags);
  const [inputValue, setInputValue] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * Persists the given tags array to Supabase.
   *
   * @param newTags - The full tags array to save
   * @returns True if the save succeeded, false otherwise
   */
  const saveTags = useCallback(async (newTags: string[]): Promise<boolean> => {
    setIsSaving(true);
    setError(null);
    try {
      const supabase = createClient();
      const { error: updateError } = await supabase
        .from('sessions')
        .update({ tags: newTags })
        .eq('id', sessionId);

      if (updateError) {
        setError('Failed to save tags. Please try again.');
        return false;
      }
      return true;
    } catch {
      setError('Failed to save tags. Please try again.');
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [sessionId]);

  /**
   * Adds a new tag from the input field.
   * Validates for duplicates, empty strings, and max length.
   */
  const handleAddTag = useCallback(async () => {
    const newTag = inputValue.trim().toLowerCase();
    if (!newTag) return;

    // Validate tag constraints
    if (newTag.length > 50) {
      setError('Tags must be 50 characters or fewer.');
      return;
    }
    if (tags.includes(newTag)) {
      setError('This tag already exists on this session.');
      return;
    }
    if (tags.length >= 10) {
      setError('Maximum of 10 tags per session.');
      return;
    }

    // Optimistic update
    const previousTags = [...tags];
    const newTags = [...tags, newTag];
    setTags(newTags);
    setInputValue('');

    const success = await saveTags(newTags);
    if (!success) {
      // Revert on failure
      setTags(previousTags);
    }
  }, [inputValue, tags, saveTags]);

  /**
   * Removes a tag by value.
   *
   * @param tagToRemove - The tag string to remove
   */
  const handleRemoveTag = useCallback(async (tagToRemove: string) => {
    const previousTags = [...tags];
    const newTags = tags.filter((t) => t !== tagToRemove);
    setTags(newTags);

    const success = await saveTags(newTags);
    if (!success) {
      setTags(previousTags);
    }
  }, [tags, saveTags]);

  /**
   * Handles keyboard events on the tag input.
   * Enter and comma both add the current value as a tag.
   * Backspace on an empty input removes the last tag.
   */
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      handleAddTag();
    } else if (e.key === 'Backspace' && !inputValue && tags.length > 0) {
      handleRemoveTag(tags[tags.length - 1]);
    }
  }, [handleAddTag, handleRemoveTag, inputValue, tags]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Existing tags as removable badges */}
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 border border-amber-500/20 px-2.5 py-0.5 text-xs font-medium text-amber-500"
        >
          {tag}
          <button
            onClick={() => handleRemoveTag(tag)}
            disabled={isSaving}
            className="ml-0.5 hover:text-amber-300 transition-colors disabled:opacity-50"
            aria-label={`Remove tag ${tag}`}
          >
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </span>
      ))}

      {/* Add tag input */}
      <input
        ref={inputRef}
        type="text"
        value={inputValue}
        onChange={(e) => {
          setInputValue(e.target.value);
          setError(null);
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          if (inputValue.trim()) {
            handleAddTag();
          }
        }}
        placeholder={tags.length === 0 ? 'Add tags (e.g., client name)...' : 'Add tag...'}
        disabled={isSaving}
        aria-label="Add a tag to this session"
        className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-xs text-zinc-100 placeholder-zinc-500 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 w-36 disabled:opacity-50"
      />

      {/* Error message */}
      {error && (
        <p className="text-xs text-red-400 w-full mt-1" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
