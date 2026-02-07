/**
 * TemplateCard Component Tests
 *
 * Tests the context template card rendering and interactions:
 * - Template name, description, content preview
 * - Variable count badge and display
 * - Default badge rendering
 * - Content truncation at 150 characters
 * - Copy to clipboard action
 * - Edit button click
 * - Set default button (enabled/disabled states)
 * - Delete confirmation dialog
 *
 * WHY: The template card is the primary display unit for context templates.
 * Bugs here affect how users perceive and manage their templates.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TemplateCard } from '../template-card';
import type { ContextTemplate } from '@styrby/shared';

// ============================================================================
// Mocks
// ============================================================================

/**
 * Mock clipboard API for copy tests.
 */
const mockWriteText = vi.fn().mockResolvedValue(undefined);
Object.assign(navigator, {
  clipboard: {
    writeText: mockWriteText,
  },
});

// ============================================================================
// Helpers
// ============================================================================

function createTemplate(overrides: Partial<ContextTemplate> = {}): ContextTemplate {
  return {
    id: 'template-001',
    userId: 'user-001',
    name: 'Code Review Template',
    description: 'Template for reviewing pull requests',
    content: 'You are reviewing a {{language}} project focused on {{project_name}}.',
    variables: [
      { name: 'language', description: 'Programming language', defaultValue: 'TypeScript' },
      { name: 'project_name', description: 'Name of the project', defaultValue: '' },
    ],
    isDefault: false,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

const defaultHandlers = {
  onEdit: vi.fn(),
  onDelete: vi.fn().mockResolvedValue(undefined),
  onSetDefault: vi.fn().mockResolvedValue(undefined),
};

// ============================================================================
// Tests
// ============================================================================

describe('TemplateCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Basic rendering', () => {
    it('renders template name', () => {
      render(<TemplateCard template={createTemplate()} {...defaultHandlers} />);

      expect(screen.getByText('Code Review Template')).toBeInTheDocument();
    });

    it('renders template description', () => {
      render(<TemplateCard template={createTemplate()} {...defaultHandlers} />);

      expect(
        screen.getByText('Template for reviewing pull requests')
      ).toBeInTheDocument();
    });

    it('does not render description when null', () => {
      const template = createTemplate({ description: null });
      render(<TemplateCard template={template} {...defaultHandlers} />);

      expect(
        screen.queryByText('Template for reviewing pull requests')
      ).not.toBeInTheDocument();
    });

    it('renders content preview', () => {
      render(<TemplateCard template={createTemplate()} {...defaultHandlers} />);

      expect(
        screen.getByText(
          'You are reviewing a {{language}} project focused on {{project_name}}.'
        )
      ).toBeInTheDocument();
    });

    it('truncates content longer than 150 characters', () => {
      const longContent = 'A'.repeat(200);
      const template = createTemplate({ content: longContent });
      render(<TemplateCard template={template} {...defaultHandlers} />);

      const truncated = 'A'.repeat(150) + '...';
      expect(screen.getByText(truncated)).toBeInTheDocument();
    });

    it('does not truncate content at exactly 150 characters', () => {
      const exactContent = 'B'.repeat(150);
      const template = createTemplate({ content: exactContent });
      render(<TemplateCard template={template} {...defaultHandlers} />);

      expect(screen.getByText(exactContent)).toBeInTheDocument();
    });
  });

  describe('Default badge', () => {
    it('shows Default badge when isDefault is true', () => {
      const template = createTemplate({ isDefault: true });
      const { container } = render(<TemplateCard template={template} {...defaultHandlers} />);

      // The badge is a <span> with rounded-full class
      const badge = container.querySelector('span.inline-flex');
      expect(badge).not.toBeNull();
      expect(badge?.textContent).toContain('Default');
    });

    it('does not show Default badge when isDefault is false', () => {
      const template = createTemplate({ isDefault: false });
      const { container } = render(<TemplateCard template={template} {...defaultHandlers} />);

      // The badge <span> with rounded-full should not exist
      const badge = container.querySelector('span.inline-flex');
      expect(badge).toBeNull();
    });
  });

  describe('Variables badge', () => {
    it('shows variable count and names', () => {
      const { container } = render(<TemplateCard template={createTemplate()} {...defaultHandlers} />);

      expect(screen.getByText(/2 variables/)).toBeInTheDocument();
      // The variables badge section contains both variable names
      const variableBadge = container.querySelector('.text-xs.text-zinc-500 span');
      expect(variableBadge?.textContent).toContain('{{language}}');
      expect(variableBadge?.textContent).toContain('{{project_name}}');
    });

    it('shows singular "variable" for count of 1', () => {
      const template = createTemplate({
        variables: [
          { name: 'lang', description: '', defaultValue: '' },
        ],
      });
      render(<TemplateCard template={template} {...defaultHandlers} />);

      expect(screen.getByText(/1 variable:/)).toBeInTheDocument();
    });

    it('hides variables section when no variables', () => {
      const template = createTemplate({ variables: [] });
      render(<TemplateCard template={template} {...defaultHandlers} />);

      expect(screen.queryByText(/variable/i)).not.toBeInTheDocument();
    });
  });

  describe('Copy action', () => {
    it('copies template content to clipboard on click', async () => {
      const template = createTemplate();
      render(<TemplateCard template={template} {...defaultHandlers} />);

      const copyButton = screen.getByRole('button', {
        name: /copy template content/i,
      });
      fireEvent.click(copyButton);

      expect(mockWriteText).toHaveBeenCalledWith(template.content);
    });

    it('shows "Copied" feedback after copy', async () => {
      render(<TemplateCard template={createTemplate()} {...defaultHandlers} />);

      const copyButton = screen.getByRole('button', {
        name: /copy template content/i,
      });
      fireEvent.click(copyButton);

      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /copied to clipboard/i })
        ).toBeInTheDocument();
      });
    });
  });

  describe('Edit action', () => {
    it('calls onEdit with template when edit is clicked', () => {
      const template = createTemplate();
      const onEdit = vi.fn();
      render(
        <TemplateCard
          template={template}
          {...defaultHandlers}
          onEdit={onEdit}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: /edit template/i }));
      expect(onEdit).toHaveBeenCalledWith(template);
    });
  });

  describe('Set Default action', () => {
    it('calls onSetDefault when button is clicked for non-default template', () => {
      const template = createTemplate({ isDefault: false });
      const onSetDefault = vi.fn().mockResolvedValue(undefined);
      render(
        <TemplateCard
          template={template}
          {...defaultHandlers}
          onSetDefault={onSetDefault}
        />
      );

      fireEvent.click(
        screen.getByRole('button', { name: /set as default template/i })
      );
      expect(onSetDefault).toHaveBeenCalledWith('template-001');
    });

    it('disables set-default button for already-default template', () => {
      const template = createTemplate({ isDefault: true });
      render(<TemplateCard template={template} {...defaultHandlers} />);

      const button = screen.getByRole('button', {
        name: /this is the default template/i,
      });
      expect(button).toBeDisabled();
    });

    it('does not call onSetDefault when template is already default', () => {
      const template = createTemplate({ isDefault: true });
      const onSetDefault = vi.fn();
      render(
        <TemplateCard
          template={template}
          {...defaultHandlers}
          onSetDefault={onSetDefault}
        />
      );

      fireEvent.click(
        screen.getByRole('button', { name: /this is the default template/i })
      );
      // The handler checks template.isDefault and returns early
      // The button is also disabled, so the click may not fire
      expect(onSetDefault).not.toHaveBeenCalled();
    });
  });

  describe('Delete action with confirmation', () => {
    it('shows confirmation dialog when delete is clicked', () => {
      render(<TemplateCard template={createTemplate()} {...defaultHandlers} />);

      fireEvent.click(screen.getByRole('button', { name: /delete template/i }));

      expect(screen.getByText('Delete template?')).toBeInTheDocument();
      expect(
        screen.getByText(/are you sure you want to delete/i)
      ).toBeInTheDocument();
    });

    it('includes template name in confirmation dialog', () => {
      render(<TemplateCard template={createTemplate()} {...defaultHandlers} />);

      fireEvent.click(screen.getByRole('button', { name: /delete template/i }));

      // The dialog text includes the template name in the confirmation message
      expect(
        screen.getByText(/are you sure you want to delete/i)
      ).toBeInTheDocument();
      // Verify the dialog content contains the template name
      const dialog = screen.getByRole('dialog');
      expect(dialog.textContent).toContain('Code Review Template');
    });

    it('calls onDelete when delete is confirmed', async () => {
      const onDelete = vi.fn().mockResolvedValue(undefined);
      render(
        <TemplateCard
          template={createTemplate()}
          {...defaultHandlers}
          onDelete={onDelete}
        />
      );

      // Open dialog
      fireEvent.click(screen.getByRole('button', { name: /delete template/i }));

      // Confirm delete
      fireEvent.click(screen.getByText('Delete'));

      expect(onDelete).toHaveBeenCalledWith('template-001');
    });

    it('closes dialog when cancel is clicked', () => {
      render(<TemplateCard template={createTemplate()} {...defaultHandlers} />);

      // Open dialog
      fireEvent.click(screen.getByRole('button', { name: /delete template/i }));
      expect(screen.getByText('Delete template?')).toBeInTheDocument();

      // Cancel
      fireEvent.click(screen.getByText('Cancel'));

      // Dialog should be gone
      expect(screen.queryByText('Delete template?')).not.toBeInTheDocument();
    });

    it('has accessible dialog attributes', () => {
      render(<TemplateCard template={createTemplate()} {...defaultHandlers} />);

      fireEvent.click(screen.getByRole('button', { name: /delete template/i }));

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(dialog).toHaveAttribute(
        'aria-labelledby',
        'delete-template-title'
      );
    });
  });
});
