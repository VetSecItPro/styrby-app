'use client';

/**
 * Template card component - displays a context template with actions.
 *
 * Renders a styled card showing template name, description, and variable count.
 * Provides actions for using (copy to clipboard), editing, setting as default,
 * and deleting the template.
 */

import { useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import type { ContextTemplate } from '@styrby/shared';

/* ──────────────────────────── Types ──────────────────────────── */

/**
 * Props for the TemplateCard component.
 */
interface TemplateCardProps {
  /** The context template to display */
  template: ContextTemplate;
  /** Callback when edit button is clicked */
  onEdit: (template: ContextTemplate) => void;
  /** Callback when delete is confirmed */
  onDelete: (templateId: string) => Promise<void>;
  /** Callback when set as default is clicked */
  onSetDefault: (templateId: string) => Promise<void>;
}

/* ──────────────────────────── Icons ──────────────────────────── */

function DocumentDuplicateIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
      />
    </svg>
  );
}

function PencilIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
      />
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

function StarIcon({ className, filled }: { className?: string; filled?: boolean }) {
  return (
    <svg
      className={className}
      fill={filled ? 'currentColor' : 'none'}
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"
      />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  );
}

function VariableIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4"
      />
    </svg>
  );
}

/* ──────────────────────────── Component ──────────────────────── */

/**
 * Renders a context template card with actions.
 *
 * WHY: Context templates need quick actions and visual feedback.
 * The card shows key info at a glance and provides one-click access
 * to common operations like copying content and setting as default.
 *
 * @param props - TemplateCard configuration
 */
export function TemplateCard({ template, onEdit, onDelete, onSetDefault }: TemplateCardProps) {
  const [copied, setCopied] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [settingDefault, setSettingDefault] = useState(false);

  /**
   * Copies the template content to clipboard.
   * Shows a temporary "Copied!" feedback.
   */
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(template.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
    }
  }, [template.content]);

  /**
   * Handles the delete action with confirmation.
   */
  const handleDelete = useCallback(async () => {
    setDeleting(true);
    try {
      await onDelete(template.id);
    } finally {
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  }, [template.id, onDelete]);

  /**
   * Handles setting this template as the default.
   */
  const handleSetDefault = useCallback(async () => {
    if (template.isDefault) return;
    setSettingDefault(true);
    try {
      await onSetDefault(template.id);
    } finally {
      setSettingDefault(false);
    }
  }, [template.id, template.isDefault, onSetDefault]);

  const variableCount = template.variables.length;
  const truncatedContent =
    template.content.length > 150 ? template.content.substring(0, 150) + '...' : template.content;

  return (
    <div
      className={cn(
        'rounded-xl border bg-zinc-900 p-4 transition-all duration-200 hover:border-zinc-700',
        template.isDefault ? 'border-orange-500/50' : 'border-zinc-800'
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-zinc-100 truncate">{template.name}</h3>
            {template.isDefault && (
              <span className="inline-flex items-center rounded-full bg-orange-500/10 px-2 py-0.5 text-xs font-medium text-orange-400">
                Default
              </span>
            )}
          </div>
          {template.description && (
            <p className="text-sm text-zinc-500 mt-1 line-clamp-2">{template.description}</p>
          )}
        </div>
      </div>

      {/* Content preview */}
      <div className="rounded-lg bg-zinc-800/50 border border-zinc-700 p-3 mb-4">
        <pre className="text-xs text-zinc-400 whitespace-pre-wrap font-mono overflow-hidden">
          {truncatedContent}
        </pre>
      </div>

      {/* Variables badge */}
      {variableCount > 0 && (
        <div className="flex items-center gap-1.5 text-xs text-zinc-500 mb-4">
          <VariableIcon className="h-3.5 w-3.5" />
          <span>
            {variableCount} variable{variableCount !== 1 ? 's' : ''}:{' '}
            {template.variables.map((v) => `{{${v.name}}}`).join(', ')}
          </span>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 pt-3 border-t border-zinc-800">
        {/* Copy button */}
        <button
          onClick={handleCopy}
          className={cn(
            'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
            copied
              ? 'bg-green-500/10 text-green-400'
              : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100'
          )}
          aria-label={copied ? 'Copied to clipboard' : 'Copy template content to clipboard'}
        >
          {copied ? (
            <>
              <CheckIcon className="h-4 w-4" />
              Copied
            </>
          ) : (
            <>
              <DocumentDuplicateIcon className="h-4 w-4" />
              Use
            </>
          )}
        </button>

        {/* Set as default button */}
        <button
          onClick={handleSetDefault}
          disabled={template.isDefault || settingDefault}
          className={cn(
            'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
            template.isDefault
              ? 'bg-orange-500/10 text-orange-400 cursor-default'
              : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed'
          )}
          aria-label={template.isDefault ? 'This is the default template' : 'Set as default template'}
        >
          <StarIcon className="h-4 w-4" filled={template.isDefault} />
          {settingDefault ? 'Setting...' : template.isDefault ? 'Default' : 'Set Default'}
        </button>

        {/* Edit button */}
        <button
          onClick={() => onEdit(template)}
          className="flex items-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 transition-colors"
          aria-label="Edit template"
        >
          <PencilIcon className="h-4 w-4" />
          Edit
        </button>

        {/* Delete button */}
        <button
          onClick={() => setShowDeleteConfirm(true)}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-red-400 hover:bg-red-500/10 transition-colors ml-auto"
          aria-label="Delete template"
        >
          <TrashIcon className="h-4 w-4" />
        </button>
      </div>

      {/* Delete confirmation dialog */}
      {showDeleteConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-template-title"
        >
          <div className="w-full max-w-md rounded-2xl bg-zinc-900 border border-zinc-700 p-6 shadow-xl mx-4">
            <h3
              id="delete-template-title"
              className="text-lg font-semibold text-zinc-100 mb-2"
            >
              Delete template?
            </h3>
            <p className="text-sm text-zinc-400 mb-6">
              Are you sure you want to delete &quot;{template.name}&quot;? This action cannot be
              undone.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                disabled={deleting}
                className="rounded-lg border border-zinc-600 px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
