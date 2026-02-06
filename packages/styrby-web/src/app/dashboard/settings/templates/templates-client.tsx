'use client';

/**
 * Templates client component - handles all template interactions.
 *
 * Manages the state for template list, create/edit modal, and all CRUD
 * operations. Uses optimistic updates for responsive UX and falls back
 * to error states if operations fail.
 */

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { TemplateCard } from './template-card';
import { TemplateForm } from './template-form';
import {
  contextTemplateFromRow,
  type ContextTemplate,
  type ContextTemplateRow,
  type CreateContextTemplateInput,
  type UpdateContextTemplateInput,
} from '@styrby/shared';

/* ──────────────────────────── Types ──────────────────────────── */

/**
 * Props for the TemplatesClient component.
 */
interface TemplatesClientProps {
  /** Initial templates fetched server-side */
  initialTemplates: ContextTemplate[];
  /** Current user's ID */
  userId: string;
}

/* ──────────────────────────── Icons ──────────────────────────── */

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
    </svg>
  );
}

function DocumentTextIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
      />
    </svg>
  );
}

/* ──────────────────────────── Component ──────────────────────── */

/**
 * Client component for managing context templates.
 *
 * WHY optimistic updates: Template operations (create, edit, delete)
 * should feel instant. We update the local state immediately and only
 * revert if the server operation fails. This provides better UX than
 * waiting for server responses.
 *
 * @param props - TemplatesClient configuration
 */
export function TemplatesClient({ initialTemplates, userId }: TemplatesClientProps) {
  const router = useRouter();
  const supabase = createClient();

  // Template list state
  const [templates, setTemplates] = useState<ContextTemplate[]>(initialTemplates);

  // Modal state
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<ContextTemplate | null>(null);

  // Error state
  const [error, setError] = useState<string | null>(null);

  /**
   * Opens the create template modal.
   */
  const handleCreate = useCallback(() => {
    setEditingTemplate(null);
    setIsFormOpen(true);
    setError(null);
  }, []);

  /**
   * Opens the edit template modal.
   */
  const handleEdit = useCallback((template: ContextTemplate) => {
    setEditingTemplate(template);
    setIsFormOpen(true);
    setError(null);
  }, []);

  /**
   * Closes the modal.
   */
  const handleCloseForm = useCallback(() => {
    setIsFormOpen(false);
    setEditingTemplate(null);
  }, []);

  /**
   * Creates or updates a template.
   */
  const handleSubmit = useCallback(
    async (
      data: CreateContextTemplateInput | UpdateContextTemplateInput,
      templateId?: string
    ) => {
      setError(null);

      if (templateId) {
        // Update existing template
        const { data: updated, error: updateError } = await supabase
          .from('context_templates')
          .update({
            name: data.name,
            description: data.description ?? null,
            content: data.content,
            variables: data.variables ?? [],
            is_default: data.isDefault ?? false,
          })
          .eq('id', templateId)
          .select()
          .single();

        if (updateError) {
          throw new Error(updateError.message);
        }

        // Update local state
        const updatedTemplate = contextTemplateFromRow(updated as ContextTemplateRow);

        setTemplates((prev) =>
          prev.map((t) => {
            if (t.id === templateId) {
              return updatedTemplate;
            }
            // If we're setting a new default, unset others
            if (updatedTemplate.isDefault && t.isDefault) {
              return { ...t, isDefault: false };
            }
            return t;
          })
        );
      } else {
        // Create new template
        const createData = data as CreateContextTemplateInput;
        const { data: created, error: createError } = await supabase
          .from('context_templates')
          .insert({
            user_id: userId,
            name: createData.name,
            description: createData.description ?? null,
            content: createData.content,
            variables: createData.variables ?? [],
            is_default: createData.isDefault ?? false,
          })
          .select()
          .single();

        if (createError) {
          throw new Error(createError.message);
        }

        // Update local state
        const newTemplate = contextTemplateFromRow(created as ContextTemplateRow);

        setTemplates((prev) => {
          // If new template is default, unset others
          if (newTemplate.isDefault) {
            return [newTemplate, ...prev.map((t) => ({ ...t, isDefault: false }))];
          }
          return [newTemplate, ...prev];
        });
      }

      // Refresh server state
      router.refresh();
    },
    [supabase, userId, router]
  );

  /**
   * Deletes a template.
   */
  const handleDelete = useCallback(
    async (templateId: string) => {
      setError(null);

      // Optimistic delete
      const previousTemplates = templates;
      setTemplates((prev) => prev.filter((t) => t.id !== templateId));

      const { error: deleteError } = await supabase
        .from('context_templates')
        .delete()
        .eq('id', templateId);

      if (deleteError) {
        // Revert on error
        setTemplates(previousTemplates);
        setError(`Failed to delete template: ${deleteError.message}`);
        throw new Error(deleteError.message);
      }

      // Refresh server state
      router.refresh();
    },
    [supabase, templates, router]
  );

  /**
   * Sets a template as the default.
   */
  const handleSetDefault = useCallback(
    async (templateId: string) => {
      setError(null);

      // Optimistic update
      const previousTemplates = templates;
      setTemplates((prev) =>
        prev.map((t) => ({
          ...t,
          isDefault: t.id === templateId,
        }))
      );

      const { error: updateError } = await supabase
        .from('context_templates')
        .update({ is_default: true })
        .eq('id', templateId);

      if (updateError) {
        // Revert on error
        setTemplates(previousTemplates);
        setError(`Failed to set default: ${updateError.message}`);
        throw new Error(updateError.message);
      }

      // Refresh server state (trigger ensures only one default)
      router.refresh();
    },
    [supabase, templates, router]
  );

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100">Context Templates</h1>
          <p className="text-sm text-zinc-500 mt-1">
            Create reusable context that can be injected into agent sessions.
          </p>
        </div>
        <button
          onClick={handleCreate}
          className="flex items-center gap-2 rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 transition-colors"
          aria-label="Create new template"
        >
          <PlusIcon className="h-4 w-4" />
          Create Template
        </button>
      </div>

      {/* Error message */}
      {error && (
        <div className="mb-6 p-4 rounded-lg bg-red-500/10 border border-red-500/20">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* Templates grid */}
      {templates.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-700 bg-zinc-900/50 p-12 text-center">
          <DocumentTextIcon className="h-12 w-12 mx-auto text-zinc-600 mb-4" />
          <h3 className="text-lg font-medium text-zinc-300 mb-2">No templates yet</h3>
          <p className="text-sm text-zinc-500 mb-6 max-w-md mx-auto">
            Context templates let you define reusable project context with variables
            that get substituted at runtime.
          </p>
          <button
            onClick={handleCreate}
            className="inline-flex items-center gap-2 rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 transition-colors"
            aria-label="Create your first template"
          >
            <PlusIcon className="h-4 w-4" />
            Create Your First Template
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {templates.map((template) => (
            <TemplateCard
              key={template.id}
              template={template}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onSetDefault={handleSetDefault}
            />
          ))}
        </div>
      )}

      {/* Create/Edit Form Modal */}
      <TemplateForm
        isOpen={isFormOpen}
        onClose={handleCloseForm}
        template={editingTemplate}
        onSubmit={handleSubmit}
      />
    </>
  );
}
