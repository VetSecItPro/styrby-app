'use client';

/**
 * Template form modal - create/edit context templates.
 *
 * Renders a modal dialog with form fields for template name, description,
 * content (with variable placeholders), and a dynamic variables editor.
 * Handles both creating new templates and editing existing ones.
 */

import { useState, useCallback, useEffect } from 'react';
import { cn } from '@/lib/utils';
import {
  extractVariableNames,
  validateTemplateVariables,
  type ContextTemplate,
  type ContextTemplateVariable,
  type CreateContextTemplateInput,
  type UpdateContextTemplateInput,
} from '@styrby/shared';

/* ──────────────────────────── Types ──────────────────────────── */

/**
 * Props for the TemplateForm component.
 */
interface TemplateFormProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback to close the modal */
  onClose: () => void;
  /** Template to edit (null for create mode) */
  template: ContextTemplate | null;
  /** Callback when form is submitted */
  onSubmit: (
    data: CreateContextTemplateInput | UpdateContextTemplateInput,
    templateId?: string
  ) => Promise<void>;
}

/**
 * Form state for the template.
 */
interface FormState {
  name: string;
  description: string;
  content: string;
  variables: ContextTemplateVariable[];
  isDefault: boolean;
}

/* ──────────────────────────── Icons ──────────────────────────── */

function XIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
    </svg>
  );
}

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
      />
    </svg>
  );
}

function AlertIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
      />
    </svg>
  );
}

/* ──────────────────────────── Component ──────────────────────── */

/**
 * Renders a modal form for creating or editing context templates.
 *
 * WHY: Context templates need careful editing since they include
 * variable placeholders that must be defined. This form validates
 * that all {{variables}} in content have corresponding definitions.
 *
 * @param props - TemplateForm configuration
 */
export function TemplateForm({ isOpen, onClose, template, onSubmit }: TemplateFormProps) {
  const isEditMode = template !== null;

  // Form state
  const [formState, setFormState] = useState<FormState>({
    name: '',
    description: '',
    content: '',
    variables: [],
    isDefault: false,
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Validation state
  const [missingVariables, setMissingVariables] = useState<string[]>([]);

  /**
   * Reset form when modal opens or template changes.
   */
  useEffect(() => {
    if (isOpen) {
      if (template) {
        setFormState({
          name: template.name,
          description: template.description || '',
          content: template.content,
          variables: template.variables,
          isDefault: template.isDefault,
        });
      } else {
        setFormState({
          name: '',
          description: '',
          content: '',
          variables: [],
          isDefault: false,
        });
      }
      setError(null);
      setMissingVariables([]);
    }
  }, [isOpen, template]);

  /**
   * Validate variables whenever content changes.
   */
  useEffect(() => {
    const result = validateTemplateVariables(formState.content, formState.variables);
    setMissingVariables(result.missingVariables);
  }, [formState.content, formState.variables]);

  /**
   * Updates a form field value.
   */
  const handleFieldChange = useCallback(
    (field: keyof FormState, value: string | boolean | ContextTemplateVariable[]) => {
      setFormState((prev) => ({ ...prev, [field]: value }));
      setError(null);
    },
    []
  );

  /**
   * Adds a new variable definition.
   */
  const handleAddVariable = useCallback(() => {
    setFormState((prev) => ({
      ...prev,
      variables: [
        ...prev.variables,
        { name: '', description: '', defaultValue: '' },
      ],
    }));
  }, []);

  /**
   * Updates a specific variable.
   */
  const handleUpdateVariable = useCallback(
    (index: number, field: keyof ContextTemplateVariable, value: string) => {
      setFormState((prev) => ({
        ...prev,
        variables: prev.variables.map((v, i) =>
          i === index ? { ...v, [field]: value } : v
        ),
      }));
    },
    []
  );

  /**
   * Removes a variable by index.
   */
  const handleRemoveVariable = useCallback((index: number) => {
    setFormState((prev) => ({
      ...prev,
      variables: prev.variables.filter((_, i) => i !== index),
    }));
  }, []);

  /**
   * Auto-detects variables from content and adds missing definitions.
   */
  const handleAutoDetectVariables = useCallback(() => {
    const detectedNames = extractVariableNames(formState.content);
    const existingNames = new Set(formState.variables.map((v) => v.name));

    const newVariables: ContextTemplateVariable[] = detectedNames
      .filter((name) => !existingNames.has(name))
      .map((name) => ({
        name,
        description: '',
        defaultValue: '',
      }));

    if (newVariables.length > 0) {
      setFormState((prev) => ({
        ...prev,
        variables: [...prev.variables, ...newVariables],
      }));
    }
  }, [formState.content, formState.variables]);

  /**
   * Submits the form.
   */
  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);

      // Validate required fields
      if (!formState.name.trim()) {
        setError('Template name is required');
        return;
      }
      if (!formState.content.trim()) {
        setError('Template content is required');
        return;
      }

      // Check for undefined variables
      if (missingVariables.length > 0) {
        setError(
          `Define all variables used in content: ${missingVariables.map((v) => `{{${v}}}`).join(', ')}`
        );
        return;
      }

      // Validate variable names
      for (const variable of formState.variables) {
        if (!variable.name.trim()) {
          setError('All variables must have a name');
          return;
        }
      }

      setSubmitting(true);

      try {
        const data: CreateContextTemplateInput | UpdateContextTemplateInput = {
          name: formState.name.trim(),
          description: formState.description.trim() || undefined,
          content: formState.content,
          variables: formState.variables.filter((v) => v.name.trim()),
          isDefault: formState.isDefault,
        };

        await onSubmit(data, template?.id);
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save template');
      } finally {
        setSubmitting(false);
      }
    },
    [formState, missingVariables, template, onSubmit, onClose]
  );

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="template-form-title"
    >
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl bg-zinc-900 border border-zinc-700 shadow-xl mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
          <h2 id="template-form-title" className="text-lg font-semibold text-zinc-100">
            {isEditMode ? 'Edit Template' : 'Create Template'}
          </h2>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
            aria-label="Close modal"
          >
            <XIcon className="h-5 w-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          {/* Error message */}
          {error && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
              <AlertIcon className="h-5 w-5 text-red-400 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          {/* Name field */}
          <div>
            <label htmlFor="template-name" className="block text-sm font-medium text-zinc-300 mb-2">
              Name <span className="text-red-400">*</span>
            </label>
            <input
              id="template-name"
              type="text"
              value={formState.name}
              onChange={(e) => handleFieldChange('name', e.target.value)}
              placeholder="e.g., Code Review, Bug Fix, New Feature"
              className="w-full rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
            />
          </div>

          {/* Description field */}
          <div>
            <label
              htmlFor="template-description"
              className="block text-sm font-medium text-zinc-300 mb-2"
            >
              Description
            </label>
            <input
              id="template-description"
              type="text"
              value={formState.description}
              onChange={(e) => handleFieldChange('description', e.target.value)}
              placeholder="When to use this template"
              className="w-full rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
            />
          </div>

          {/* Content field */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label
                htmlFor="template-content"
                className="block text-sm font-medium text-zinc-300"
              >
                Content <span className="text-red-400">*</span>
              </label>
              <span className="text-xs text-zinc-500">
                Use {'{{variable_name}}'} for placeholders
              </span>
            </div>
            <textarea
              id="template-content"
              value={formState.content}
              onChange={(e) => handleFieldChange('content', e.target.value)}
              placeholder="Enter your template content here. Use {{variable_name}} syntax for placeholders that will be substituted at runtime."
              rows={10}
              className="w-full rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 font-mono focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500 resize-y"
            />
          </div>

          {/* Variables section */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <label className="block text-sm font-medium text-zinc-300">
                Variables
                {missingVariables.length > 0 && (
                  <span className="ml-2 text-xs text-yellow-400">
                    ({missingVariables.length} undefined in content)
                  </span>
                )}
              </label>
              <div className="flex gap-2">
                {missingVariables.length > 0 && (
                  <button
                    type="button"
                    onClick={handleAutoDetectVariables}
                    className="flex items-center gap-1 text-xs text-orange-500 hover:text-orange-400 transition-colors"
                  >
                    Auto-detect
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleAddVariable}
                  className="flex items-center gap-1 text-xs text-orange-500 hover:text-orange-400 transition-colors"
                >
                  <PlusIcon className="h-3.5 w-3.5" />
                  Add Variable
                </button>
              </div>
            </div>

            {formState.variables.length === 0 ? (
              <p className="text-sm text-zinc-500 py-3 text-center border border-dashed border-zinc-700 rounded-lg">
                No variables defined. Add variables to make your template dynamic.
              </p>
            ) : (
              <div className="space-y-3">
                {formState.variables.map((variable, index) => (
                  <div
                    key={index}
                    className={cn(
                      'rounded-lg border p-3 space-y-3',
                      missingVariables.includes(variable.name)
                        ? 'border-yellow-500/50 bg-yellow-500/5'
                        : 'border-zinc-700 bg-zinc-800/50'
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex-1 grid grid-cols-3 gap-3">
                        <div>
                          <label className="block text-xs text-zinc-400 mb-1">
                            Name <span className="text-red-400">*</span>
                          </label>
                          <input
                            type="text"
                            value={variable.name}
                            onChange={(e) =>
                              handleUpdateVariable(index, 'name', e.target.value)
                            }
                            placeholder="variable_name"
                            className="w-full rounded-lg border border-zinc-600 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 placeholder-zinc-500 font-mono focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-zinc-400 mb-1">Description</label>
                          <input
                            type="text"
                            value={variable.description}
                            onChange={(e) =>
                              handleUpdateVariable(index, 'description', e.target.value)
                            }
                            placeholder="What this variable is for"
                            className="w-full rounded-lg border border-zinc-600 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 placeholder-zinc-500 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-zinc-400 mb-1">Default Value</label>
                          <input
                            type="text"
                            value={variable.defaultValue}
                            onChange={(e) =>
                              handleUpdateVariable(index, 'defaultValue', e.target.value)
                            }
                            placeholder="Default if not provided"
                            className="w-full rounded-lg border border-zinc-600 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 placeholder-zinc-500 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                          />
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRemoveVariable(index)}
                        className="mt-5 p-1.5 text-zinc-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                        aria-label="Remove variable"
                      >
                        <TrashIcon className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Set as default toggle */}
          <div className="flex items-center justify-between py-3 border-t border-zinc-800">
            <div>
              <p className="text-sm font-medium text-zinc-100">Set as Default</p>
              <p className="text-xs text-zinc-500">
                Automatically apply this template to new sessions
              </p>
            </div>
            <label className="relative inline-flex cursor-pointer items-center">
              <input
                type="checkbox"
                className="peer sr-only"
                checked={formState.isDefault}
                onChange={(e) => handleFieldChange('isDefault', e.target.checked)}
                aria-label="Set as default template"
              />
              <div className="h-6 w-11 rounded-full bg-zinc-700 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-all peer-checked:bg-orange-500 peer-checked:after:translate-x-full" />
            </label>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-4 border-t border-zinc-800">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-lg border border-zinc-600 px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? 'Saving...' : isEditMode ? 'Save Changes' : 'Create Template'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
