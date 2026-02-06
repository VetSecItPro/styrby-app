/**
 * useContextTemplates Hook
 *
 * Manages context templates for the mobile app: fetching, creating, updating,
 * deleting, and setting defaults. Provides loading/error states and optimistic
 * updates for a responsive UI.
 */

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import type {
  ContextTemplate,
  ContextTemplateRow,
  CreateContextTemplateInput,
  UpdateContextTemplateInput,
  ContextTemplateVariable,
} from 'styrby-shared';
import { contextTemplateFromRow } from 'styrby-shared';

// ============================================================================
// Types
// ============================================================================

/**
 * Return type for the useContextTemplates hook.
 */
export interface UseContextTemplatesResult {
  /** Array of user's context templates */
  templates: ContextTemplate[];

  /** True while templates are loading */
  isLoading: boolean;

  /** True while a create/update/delete operation is in progress */
  isMutating: boolean;

  /** Error message from the last failed operation */
  error: string | null;

  /** Refresh templates from the database */
  refresh: () => Promise<void>;

  /** Create a new template */
  createTemplate: (input: CreateContextTemplateInput) => Promise<ContextTemplate | null>;

  /** Update an existing template */
  updateTemplate: (id: string, input: UpdateContextTemplateInput) => Promise<boolean>;

  /** Delete a template */
  deleteTemplate: (id: string) => Promise<boolean>;

  /** Set a template as the default (unsets any existing default) */
  setDefaultTemplate: (id: string) => Promise<boolean>;
}

// ============================================================================
// Hook Implementation
// ============================================================================

/**
 * Hook for managing context templates.
 *
 * Fetches templates on mount and provides CRUD operations with optimistic
 * updates for responsive UI feedback.
 *
 * @returns Object with templates, loading states, and mutation functions
 *
 * @example
 * const { templates, isLoading, createTemplate } = useContextTemplates();
 *
 * const handleCreate = async () => {
 *   const newTemplate = await createTemplate({
 *     name: 'My Template',
 *     content: 'Context for {{project}}',
 *     variables: [{ name: 'project', description: 'Project name', defaultValue: '' }],
 *   });
 * };
 */
export function useContextTemplates(): UseContextTemplatesResult {
  const [templates, setTemplates] = useState<ContextTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isMutating, setIsMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --------------------------------------------------------------------------
  // Fetch Templates
  // --------------------------------------------------------------------------

  /**
   * Fetches the authenticated user's templates from Supabase.
   * Called on mount and when refresh is invoked.
   */
  const fetchTemplates = useCallback(async () => {
    try {
      setError(null);

      // Get the authenticated user
      const { data: { user }, error: userError } = await supabase.auth.getUser();
      if (userError || !user) {
        setError('Not authenticated');
        setIsLoading(false);
        return;
      }

      // Fetch templates for this user, sorted by name
      const { data, error: fetchError } = await supabase
        .from('context_templates')
        .select('*')
        .eq('user_id', user.id)
        .order('is_default', { ascending: false })
        .order('name', { ascending: true });

      if (fetchError) {
        setError(fetchError.message);
        return;
      }

      // Transform database rows to ContextTemplate objects
      const transformed = (data as ContextTemplateRow[]).map(contextTemplateFromRow);
      setTemplates(transformed);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load templates';
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * Public refresh function that resets loading state.
   */
  const refresh = useCallback(async () => {
    setIsLoading(true);
    await fetchTemplates();
  }, [fetchTemplates]);

  // Fetch on mount
  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  // --------------------------------------------------------------------------
  // Create Template
  // --------------------------------------------------------------------------

  /**
   * Creates a new context template.
   *
   * @param input - The template creation input
   * @returns The created template, or null if creation failed
   */
  const createTemplate = useCallback(
    async (input: CreateContextTemplateInput): Promise<ContextTemplate | null> => {
      setIsMutating(true);
      setError(null);

      try {
        // Get the authenticated user
        const { data: { user }, error: userError } = await supabase.auth.getUser();
        if (userError || !user) {
          setError('Not authenticated');
          return null;
        }

        // If setting as default, unset any existing default first
        if (input.isDefault) {
          await supabase
            .from('context_templates')
            .update({ is_default: false })
            .eq('user_id', user.id)
            .eq('is_default', true);
        }

        // Insert the new template
        const { data, error: insertError } = await supabase
          .from('context_templates')
          .insert({
            user_id: user.id,
            name: input.name,
            description: input.description ?? null,
            content: input.content,
            variables: input.variables ?? [],
            is_default: input.isDefault ?? false,
          })
          .select()
          .single();

        if (insertError) {
          setError(insertError.message);
          return null;
        }

        const created = contextTemplateFromRow(data as ContextTemplateRow);

        // Update local state with the new template
        setTemplates((prev) => {
          // If new template is default, mark others as non-default
          const updated = input.isDefault
            ? prev.map((t) => ({ ...t, isDefault: false }))
            : prev;

          // Insert at the beginning if default, else sort by name
          return input.isDefault
            ? [created, ...updated]
            : [...updated, created].sort((a, b) => {
                if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
                return a.name.localeCompare(b.name);
              });
        });

        return created;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create template';
        setError(message);
        return null;
      } finally {
        setIsMutating(false);
      }
    },
    []
  );

  // --------------------------------------------------------------------------
  // Update Template
  // --------------------------------------------------------------------------

  /**
   * Updates an existing context template.
   *
   * @param id - The template ID to update
   * @param input - The fields to update
   * @returns True if update succeeded, false otherwise
   */
  const updateTemplate = useCallback(
    async (id: string, input: UpdateContextTemplateInput): Promise<boolean> => {
      setIsMutating(true);
      setError(null);

      try {
        // Get the authenticated user for default handling
        const { data: { user }, error: userError } = await supabase.auth.getUser();
        if (userError || !user) {
          setError('Not authenticated');
          return false;
        }

        // If setting as default, unset any existing default first
        if (input.isDefault) {
          await supabase
            .from('context_templates')
            .update({ is_default: false })
            .eq('user_id', user.id)
            .eq('is_default', true);
        }

        // Build the update object, only including provided fields
        const updateData: Record<string, unknown> = {};
        if (input.name !== undefined) updateData.name = input.name;
        if (input.description !== undefined) updateData.description = input.description;
        if (input.content !== undefined) updateData.content = input.content;
        if (input.variables !== undefined) updateData.variables = input.variables;
        if (input.isDefault !== undefined) updateData.is_default = input.isDefault;

        const { error: updateError } = await supabase
          .from('context_templates')
          .update(updateData)
          .eq('id', id);

        if (updateError) {
          setError(updateError.message);
          return false;
        }

        // Update local state
        setTemplates((prev) => {
          const updated = prev.map((t) => {
            if (t.id === id) {
              return {
                ...t,
                name: input.name ?? t.name,
                description: input.description !== undefined ? input.description : t.description,
                content: input.content ?? t.content,
                variables: input.variables ?? t.variables,
                isDefault: input.isDefault ?? t.isDefault,
              };
            }
            // If another template is being set as default, unset this one
            if (input.isDefault && t.isDefault) {
              return { ...t, isDefault: false };
            }
            return t;
          });

          // Re-sort after update
          return updated.sort((a, b) => {
            if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
        });

        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to update template';
        setError(message);
        return false;
      } finally {
        setIsMutating(false);
      }
    },
    []
  );

  // --------------------------------------------------------------------------
  // Delete Template
  // --------------------------------------------------------------------------

  /**
   * Deletes a context template.
   *
   * @param id - The template ID to delete
   * @returns True if deletion succeeded, false otherwise
   */
  const deleteTemplate = useCallback(async (id: string): Promise<boolean> => {
    setIsMutating(true);
    setError(null);

    // Optimistic update: remove from local state immediately
    const previousTemplates = templates;
    setTemplates((prev) => prev.filter((t) => t.id !== id));

    try {
      const { error: deleteError } = await supabase
        .from('context_templates')
        .delete()
        .eq('id', id);

      if (deleteError) {
        // Revert optimistic update on failure
        setTemplates(previousTemplates);
        setError(deleteError.message);
        return false;
      }

      return true;
    } catch (err) {
      // Revert optimistic update on failure
      setTemplates(previousTemplates);
      const message = err instanceof Error ? err.message : 'Failed to delete template';
      setError(message);
      return false;
    } finally {
      setIsMutating(false);
    }
  }, [templates]);

  // --------------------------------------------------------------------------
  // Set Default Template
  // --------------------------------------------------------------------------

  /**
   * Sets a template as the default, unsetting any previous default.
   *
   * @param id - The template ID to set as default
   * @returns True if operation succeeded, false otherwise
   */
  const setDefaultTemplate = useCallback(async (id: string): Promise<boolean> => {
    return updateTemplate(id, { isDefault: true });
  }, [updateTemplate]);

  // --------------------------------------------------------------------------
  // Return
  // --------------------------------------------------------------------------

  return {
    templates,
    isLoading,
    isMutating,
    error,
    refresh,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    setDefaultTemplate,
  };
}
