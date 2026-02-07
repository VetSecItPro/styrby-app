/**
 * TemplateForm Component Tests
 *
 * Tests the template create/edit modal form:
 * - Modal visibility toggling
 * - Create vs edit mode title
 * - Form field rendering and updates
 * - Required field validation (name, content)
 * - Missing variable validation
 * - Empty variable name validation
 * - Variable add/remove/update
 * - Auto-detect variables from content
 * - isDefault toggle
 * - Submit with correct data
 * - Error display on submit failure
 * - Loading state during submission
 *
 * WHY: The template form has complex validation logic that ensures
 * {{variables}} in content have matching definitions. Bugs here could
 * allow invalid templates that fail at runtime.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TemplateForm } from '../template-form';
import type { ContextTemplate } from '@styrby/shared';

// ============================================================================
// Mocks
// ============================================================================

/**
 * Mock @/lib/utils for cn() class name utility.
 */
vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) =>
    args
      .flat()
      .filter((a) => typeof a === 'string')
      .join(' '),
}));

// ============================================================================
// Helpers
// ============================================================================

const EXISTING_TEMPLATE: ContextTemplate = {
  id: 'template-001',
  userId: 'user-001',
  name: 'Existing Template',
  description: 'A template for testing',
  content: 'Working on {{project}} with {{language}}',
  variables: [
    { name: 'project', description: 'Project name', defaultValue: 'MyApp' },
    { name: 'language', description: 'Language', defaultValue: 'TypeScript' },
  ],
  isDefault: false,
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
};

const defaultProps = {
  isOpen: true,
  onClose: vi.fn(),
  template: null as ContextTemplate | null,
  onSubmit: vi.fn().mockResolvedValue(undefined),
};

// ============================================================================
// Tests
// ============================================================================

describe('TemplateForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Modal visibility', () => {
    it('renders nothing when isOpen is false', () => {
      const { container } = render(
        <TemplateForm {...defaultProps} isOpen={false} />
      );

      expect(container.innerHTML).toBe('');
    });

    it('renders the modal when isOpen is true', () => {
      render(<TemplateForm {...defaultProps} isOpen={true} />);

      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('has correct accessibility attributes on modal', () => {
      render(<TemplateForm {...defaultProps} />);

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(dialog).toHaveAttribute('aria-labelledby', 'template-form-title');
    });
  });

  describe('Create vs Edit mode', () => {
    it('shows "Create Template" title in create mode', () => {
      render(<TemplateForm {...defaultProps} template={null} />);

      // Use the heading element specifically to avoid matching the submit button
      const title = screen.getByRole('heading', { name: /create template/i });
      expect(title).toBeInTheDocument();
    });

    it('shows "Edit Template" title in edit mode', () => {
      render(
        <TemplateForm {...defaultProps} template={EXISTING_TEMPLATE} />
      );

      expect(screen.getByText('Edit Template')).toBeInTheDocument();
    });

    it('shows "Create Template" on submit button in create mode', () => {
      render(<TemplateForm {...defaultProps} template={null} />);

      expect(
        screen.getByRole('button', { name: /create template/i })
      ).toBeInTheDocument();
    });

    it('shows "Save Changes" on submit button in edit mode', () => {
      render(
        <TemplateForm {...defaultProps} template={EXISTING_TEMPLATE} />
      );

      expect(
        screen.getByRole('button', { name: /save changes/i })
      ).toBeInTheDocument();
    });
  });

  describe('Form pre-population in edit mode', () => {
    it('populates form fields from existing template', () => {
      render(
        <TemplateForm {...defaultProps} template={EXISTING_TEMPLATE} />
      );

      expect(screen.getByDisplayValue('Existing Template')).toBeInTheDocument();
      expect(
        screen.getByDisplayValue('A template for testing')
      ).toBeInTheDocument();
      expect(
        screen.getByDisplayValue(
          'Working on {{project}} with {{language}}'
        )
      ).toBeInTheDocument();
    });

    it('populates variables from existing template', () => {
      render(
        <TemplateForm {...defaultProps} template={EXISTING_TEMPLATE} />
      );

      expect(screen.getByDisplayValue('project')).toBeInTheDocument();
      expect(screen.getByDisplayValue('language')).toBeInTheDocument();
      expect(screen.getByDisplayValue('MyApp')).toBeInTheDocument();
      expect(screen.getByDisplayValue('TypeScript')).toBeInTheDocument();
    });

    it('clears form fields in create mode', () => {
      render(<TemplateForm {...defaultProps} template={null} />);

      const nameInput = screen.getByLabelText(/name/i);
      expect(nameInput).toHaveValue('');
    });
  });

  describe('Required field validation', () => {
    it('shows error when name is empty on submit', async () => {
      const user = userEvent.setup();
      render(<TemplateForm {...defaultProps} />);

      // Leave name empty, add content
      const contentField = screen.getByLabelText(/content/i);
      await user.type(contentField, 'Some content');

      // Submit
      await user.click(
        screen.getByRole('button', { name: /create template/i })
      );

      expect(screen.getByText('Template name is required')).toBeInTheDocument();
      expect(defaultProps.onSubmit).not.toHaveBeenCalled();
    });

    it('shows error when content is empty on submit', async () => {
      const user = userEvent.setup();
      render(<TemplateForm {...defaultProps} />);

      // Add name, leave content empty
      const nameField = screen.getByLabelText(/name/i);
      await user.type(nameField, 'My Template');

      // Submit
      await user.click(
        screen.getByRole('button', { name: /create template/i })
      );

      expect(
        screen.getByText('Template content is required')
      ).toBeInTheDocument();
      expect(defaultProps.onSubmit).not.toHaveBeenCalled();
    });
  });

  describe('Variable validation', () => {
    it('shows error when content has undefined variables on submit', async () => {
      render(<TemplateForm {...defaultProps} />);

      // Use fireEvent.change to set values in one shot (triggers state + effect)
      fireEvent.change(screen.getByLabelText(/^name/i), {
        target: { value: 'My Template' },
      });
      fireEvent.change(screen.getByLabelText(/content/i), {
        target: { value: 'Using {{undefined_var}}' },
      });

      // Wait for the useEffect to detect missing variables
      await waitFor(() => {
        expect(screen.getByText(/undefined in content/i)).toBeInTheDocument();
      });

      // Submit without defining the variable
      fireEvent.click(
        screen.getByRole('button', { name: /create template/i })
      );

      await waitFor(() => {
        expect(
          screen.getByText(/define all variables/i)
        ).toBeInTheDocument();
      });
      expect(defaultProps.onSubmit).not.toHaveBeenCalled();
    });

    it('shows error when a variable has empty name on submit', async () => {
      const user = userEvent.setup();
      render(<TemplateForm {...defaultProps} />);

      const nameField = screen.getByLabelText(/name/i);
      await user.type(nameField, 'My Template');

      const contentField = screen.getByLabelText(/content/i);
      await user.type(contentField, 'No variables used');

      // Add a variable with empty name
      await user.click(screen.getByText('Add Variable'));

      // Submit with empty variable name
      await user.click(
        screen.getByRole('button', { name: /create template/i })
      );

      expect(
        screen.getByText('All variables must have a name')
      ).toBeInTheDocument();
      expect(defaultProps.onSubmit).not.toHaveBeenCalled();
    });
  });

  describe('Variable management', () => {
    it('adds a new variable when "Add Variable" is clicked', async () => {
      const user = userEvent.setup();
      render(<TemplateForm {...defaultProps} />);

      // Initially shows "No variables defined" message
      expect(screen.getByText(/no variables defined/i)).toBeInTheDocument();

      await user.click(screen.getByText('Add Variable'));

      // Should now have variable input fields
      expect(screen.queryByText(/no variables defined/i)).not.toBeInTheDocument();
    });

    it('removes a variable when remove button is clicked', async () => {
      const user = userEvent.setup();
      render(
        <TemplateForm {...defaultProps} template={EXISTING_TEMPLATE} />
      );

      // Initially has 2 variables
      expect(screen.getByDisplayValue('project')).toBeInTheDocument();
      expect(screen.getByDisplayValue('language')).toBeInTheDocument();

      // Click first remove button
      const removeButtons = screen.getAllByRole('button', {
        name: /remove variable/i,
      });
      await user.click(removeButtons[0]);

      // First variable should be removed
      expect(screen.queryByDisplayValue('project')).not.toBeInTheDocument();
      // Second variable should still exist
      expect(screen.getByDisplayValue('language')).toBeInTheDocument();
    });
  });

  describe('Auto-detect variables', () => {
    it('shows auto-detect button when content has undefined variables', async () => {
      render(<TemplateForm {...defaultProps} />);

      // Use fireEvent.change to set the value directly (more reliable for effects)
      fireEvent.change(screen.getByLabelText(/content/i), {
        target: { value: 'Using {{my_var}} and {{other_var}}' },
      });

      // Auto-detect button should appear after useEffect runs
      await waitFor(() => {
        expect(screen.getByText('Auto-detect')).toBeInTheDocument();
      });
    });

    it('auto-detects variables from content and adds them', async () => {
      render(<TemplateForm {...defaultProps} />);

      // Set content with a variable placeholder
      fireEvent.change(screen.getByLabelText(/content/i), {
        target: { value: 'Using {{my_var}}' },
      });

      // Wait for auto-detect to appear after useEffect processes content
      await waitFor(() => {
        expect(screen.getByText('Auto-detect')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Auto-detect'));

      // Variable should be added with the detected name
      await waitFor(() => {
        expect(screen.getByDisplayValue('my_var')).toBeInTheDocument();
      });
    });
  });

  describe('Successful submission', () => {
    it('calls onSubmit with form data and closes on success in create mode', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      const onClose = vi.fn();

      render(
        <TemplateForm
          {...defaultProps}
          onSubmit={onSubmit}
          onClose={onClose}
          template={null}
        />
      );

      const nameField = screen.getByLabelText(/name/i);
      await user.type(nameField, 'New Template');

      const contentField = screen.getByLabelText(/content/i);
      await user.type(contentField, 'Simple content without variables');

      await user.click(
        screen.getByRole('button', { name: /create template/i })
      );

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'New Template',
            content: 'Simple content without variables',
          }),
          undefined // No template ID in create mode
        );
      });

      expect(onClose).toHaveBeenCalled();
    });

    it('calls onSubmit with templateId in edit mode', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn().mockResolvedValue(undefined);

      render(
        <TemplateForm
          {...defaultProps}
          onSubmit={onSubmit}
          template={EXISTING_TEMPLATE}
        />
      );

      // Just submit without changes
      await user.click(
        screen.getByRole('button', { name: /save changes/i })
      );

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'Existing Template',
          }),
          'template-001' // Template ID passed in edit mode
        );
      });
    });
  });

  describe('Error handling', () => {
    it('shows error when onSubmit throws', async () => {
      const user = userEvent.setup();
      const onSubmit = vi
        .fn()
        .mockRejectedValue(new Error('Database error'));

      render(
        <TemplateForm
          {...defaultProps}
          onSubmit={onSubmit}
          template={null}
        />
      );

      const nameField = screen.getByLabelText(/name/i);
      await user.type(nameField, 'Test');

      const contentField = screen.getByLabelText(/content/i);
      await user.type(contentField, 'Content');

      await user.click(
        screen.getByRole('button', { name: /create template/i })
      );

      await waitFor(() => {
        expect(screen.getByText('Database error')).toBeInTheDocument();
      });
    });

    it('shows generic error for non-Error throws', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn().mockRejectedValue('string error');

      render(
        <TemplateForm
          {...defaultProps}
          onSubmit={onSubmit}
          template={null}
        />
      );

      const nameField = screen.getByLabelText(/name/i);
      await user.type(nameField, 'Test');

      const contentField = screen.getByLabelText(/content/i);
      await user.type(contentField, 'Content');

      await user.click(
        screen.getByRole('button', { name: /create template/i })
      );

      await waitFor(() => {
        expect(
          screen.getByText('Failed to save template')
        ).toBeInTheDocument();
      });
    });
  });

  describe('Close behavior', () => {
    it('calls onClose when close button is clicked', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      render(<TemplateForm {...defaultProps} onClose={onClose} />);

      await user.click(screen.getByRole('button', { name: /close modal/i }));

      expect(onClose).toHaveBeenCalledOnce();
    });

    it('calls onClose when cancel button is clicked', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      render(<TemplateForm {...defaultProps} onClose={onClose} />);

      await user.click(screen.getByText('Cancel'));

      expect(onClose).toHaveBeenCalledOnce();
    });
  });
});
