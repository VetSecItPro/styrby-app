/**
 * Session Tag Editor (Mobile)
 *
 * Inline tag editor for viewing and editing tags on a coding session.
 * Shows existing tags as removable chips and provides an "Add tag" button
 * that reveals a text input inline.
 *
 * WHY: Tags enable cost attribution by client or project. Developers
 * working on multiple client projects need to retroactively tag sessions
 * so they can generate accurate cost breakdowns for invoicing.
 *
 * @module components/SessionTagEditor
 */

import { View, Text, TextInput, Pressable } from 'react-native';
import { useState, useCallback, useRef } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';

// ============================================================================
// Types
// ============================================================================

/**
 * Props for the SessionTagEditor component.
 */
interface SessionTagEditorProps {
  /** The session ID to update tags on */
  sessionId: string;
  /** Initial tags from the session data */
  initialTags: string[];
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Maximum number of tags allowed per session.
 * WHY: The DB has a constraint (sessions_tags_limit) allowing up to 50,
 * but the web app limits to 10 for UX. We match that here for consistency.
 */
const MAX_TAGS = 10;

/**
 * Maximum character length for a single tag.
 */
const MAX_TAG_LENGTH = 50;

/**
 * Strip any characters from a tag that don't match the safe character set.
 *
 * @param tag - Raw tag string (already lowercased)
 * @returns Sanitized tag with unsafe characters removed
 */
function sanitizeTag(tag: string): string {
  return tag.replace(/[^a-z0-9\-_. ]/g, '');
}

// ============================================================================
// Component
// ============================================================================

/**
 * Renders editable tag chips with add/remove functionality.
 *
 * Tags are persisted to the `sessions.tags` column in Supabase on every
 * change. Uses optimistic updates for instant feedback, reverting on failure.
 *
 * @param props - Component props with sessionId and initial tags
 * @returns Tag chips with inline add input
 *
 * @example
 * <SessionTagEditor sessionId="abc-123" initialTags={["acme-corp", "billing"]} />
 */
export function SessionTagEditor({ sessionId, initialTags }: SessionTagEditorProps) {
  // WHY: Filter initialTags through the safe character regex. Tags from the DB
  // should already be clean, but this guards against schema drift or direct DB
  // edits that bypass application-level validation.
  const [tags, setTags] = useState<string[]>(
    initialTags.map((t) => sanitizeTag(t.toLowerCase())).filter((t) => t.length > 0),
  );
  const [isAdding, setIsAdding] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<TextInput>(null);

  /**
   * WHY: Tracks whether onSubmitEditing has already fired for the current input.
   * Both onSubmitEditing and onBlur can call handleAddTag — without this guard,
   * both fire in quick succession (especially on Android), which causes a
   * "Tag already exists" flash because the tag is added by onSubmitEditing
   * before onBlur runs. We reset this flag inside the onBlur setTimeout so it
   * is cleared after both events have had a chance to fire.
   */
  const didSubmitRef = useRef(false);

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
      const { error: updateError } = await supabase
        .from('sessions')
        .update({ tags: newTags })
        .eq('id', sessionId);

      if (updateError) {
        setError('Failed to save tags');
        return false;
      }
      return true;
    } catch {
      setError('Failed to save tags');
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [sessionId]);

  /**
   * Adds a new tag from the input field.
   * Validates for duplicates, empty strings, and constraints.
   */
  const handleAddTag = useCallback(async () => {
    const newTag = sanitizeTag(inputValue.trim().toLowerCase());
    if (!newTag) {
      setIsAdding(false);
      setInputValue('');
      return;
    }

    // Validate tag constraints
    if (newTag.length > MAX_TAG_LENGTH) {
      setError(`Tags must be ${MAX_TAG_LENGTH} characters or fewer`);
      return;
    }
    if (tags.includes(newTag)) {
      setError('Tag already exists');
      setInputValue('');
      return;
    }
    if (tags.length >= MAX_TAGS) {
      setError(`Maximum of ${MAX_TAGS} tags per session`);
      return;
    }

    // Optimistic update — show the tag immediately before the server responds
    const previousTags = [...tags];
    const newTags = [...tags, newTag];
    setTags(newTags);
    setInputValue('');
    setIsAdding(false);

    const success = await saveTags(newTags);
    if (!success) {
      // Revert on failure so UI stays in sync with the database
      setTags(previousTags);
    }
  }, [inputValue, tags, saveTags]);

  /**
   * Removes a tag by value.
   *
   * @param tagToRemove - The tag string to remove
   */
  const handleRemoveTag = useCallback(async (tagToRemove: string) => {
    if (isSaving) return;

    // Optimistic update
    const previousTags = [...tags];
    const newTags = tags.filter((t) => t !== tagToRemove);
    setTags(newTags);

    const success = await saveTags(newTags);
    if (!success) {
      setTags(previousTags);
    }
  }, [tags, isSaving, saveTags]);

  /**
   * Opens the inline add-tag input and focuses it.
   */
  const handleShowInput = useCallback(() => {
    setError(null);
    setIsAdding(true);
    // WHY: Small delay to let the TextInput mount before focusing.
    // React Native needs a frame to render the component before focus works.
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  return (
    <View className="mx-4 mb-4">
      <Text className="text-zinc-400 text-xs font-medium uppercase tracking-wide mb-2">
        Tags
      </Text>

      <View className="flex-row flex-wrap items-center">
        {/* Existing tags as removable chips */}
        {tags.map((tag) => (
          <View
            key={tag}
            className="flex-row items-center bg-zinc-800 rounded-full px-3 py-1 mr-2 mb-2"
          >
            <Text className="text-zinc-300 text-sm">{tag}</Text>
            <Pressable
              onPress={() => handleRemoveTag(tag)}
              disabled={isSaving}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`Remove tag ${tag}`}
            >
              <Text className="text-zinc-500 ml-1 text-sm">✕</Text>
            </Pressable>
          </View>
        ))}

        {/* Add tag: either a button or inline input */}
        {isAdding ? (
          <TextInput
            ref={inputRef}
            value={inputValue}
            onChangeText={(text) => {
              setInputValue(text);
              setError(null);
            }}
            onSubmitEditing={() => {
              // Mark that submit fired so onBlur does not double-call handleAddTag.
              didSubmitRef.current = true;
              handleAddTag();
            }}
            onBlur={() => {
              // WHY: Small delay to allow onSubmitEditing to fire first on Android.
              // Without this, blur fires before submit and the tag is lost.
              // We also check didSubmitRef to prevent a double-call when both
              // onSubmitEditing and onBlur fire for the same interaction.
              setTimeout(() => {
                if (!didSubmitRef.current) {
                  if (inputValue.trim()) {
                    handleAddTag();
                  } else {
                    setIsAdding(false);
                    setInputValue('');
                  }
                }
                // Reset the flag so the next add interaction starts clean.
                didSubmitRef.current = false;
              }, 150);
            }}
            placeholder="tag name"
            placeholderTextColor="#71717a"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            maxLength={MAX_TAG_LENGTH}
            className="bg-zinc-800 rounded-lg px-3 py-2 text-white text-sm mb-2"
            style={{ minWidth: 100 }}
            accessibilityLabel="Enter tag name"
          />
        ) : (
          <Pressable
            onPress={handleShowInput}
            disabled={isSaving || tags.length >= MAX_TAGS}
            className="flex-row items-center border border-dashed border-zinc-600 rounded-full px-3 py-1 mb-2"
            style={tags.length >= MAX_TAGS ? { opacity: 0.4 } : undefined}
            accessibilityRole="button"
            accessibilityLabel="Add a tag"
          >
            <Ionicons name="add" size={14} color="#71717a" />
            <Text className="text-zinc-500 text-sm ml-1">Add tag</Text>
          </Pressable>
        )}
      </View>

      {/* Error message */}
      {error && (
        <Text className="text-red-400 text-xs mt-1" accessibilityRole="alert">
          {error}
        </Text>
      )}
    </View>
  );
}
