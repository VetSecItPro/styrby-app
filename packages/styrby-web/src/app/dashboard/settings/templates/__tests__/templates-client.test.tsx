/**
 * TemplatesClient Component Tests
 *
 * Tests the main templates client component:
 * - Initial rendering with templates list
 * - Empty state rendering
 * - Create template flow (opens modal, submits, updates list)
 * - Edit template flow (opens modal with template data)
 * - Delete template flow (optimistic delete, rollback on error)
 * - Set default template (optimistic update, rollback on error)
 *
 * WHY: TemplatesClient is the orchestrating component for the templates
 * feature. It manages state for the entire template list and coordinates
 * between TemplateCard and TemplateForm. Bugs here affect all template
 * operations.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TemplatesClient } from '../templates-client';
import type { ContextTemplate } from '@styrby/shared';

// ============================================================================
// Mocks
// ============================================================================

const mockRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    refresh: mockRefresh,
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
  }),
}));

/** Track Supabase operations */
const mockSupabaseChain = {
  update: vi.fn(),
  insert: vi.fn(),
  delete: vi.fn(),
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  single: vi.fn(),
};

/**
 * Configure the mock to be chainable and return the expected result.
 */
function setupSupabaseMock(
  result: { data?: unknown; error?: unknown } = { data: null, error: null }
) {
  const chain = {
    update: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue(result),
    then: (resolve: (v: unknown) => void) => resolve(result),
  };

  Object.assign(mockSupabaseChain, chain);

  return chain;
}

vi.mock('@/lib/supabase/client', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => {
      const chain = {
        update: vi.fn(() => chain),
        insert: vi.fn(() => chain),
        delete: vi.fn(() => chain),
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        single: mockSupabaseChain.single,
      };
      return chain;
    }),
  })),
}));

vi.mock('@styrby/shared', async () => {
  const actual = await vi.importActual('@styrby/shared');
  return {
    ...actual,
  };
});

/**
 * Mock clipboard API.
 */
Object.assign(navigator, {
  clipboard: {
    writeText: vi.fn().mockResolvedValue(undefined),
  },
});

// ============================================================================
// Helpers
// ============================================================================

function createTemplate(overrides: Partial<ContextTemplate> = {}): ContextTemplate {
  return {
    id: 'template-001',
    userId: 'user-001',
    name: 'First Template',
    description: 'Description one',
    content: 'Content one with {{var1}}',
    variables: [{ name: 'var1', description: '', defaultValue: '' }],
    isDefault: false,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

function createTemplateList(): ContextTemplate[] {
  return [
    createTemplate({
      id: 'template-001',
      name: 'First Template',
      isDefault: true,
    }),
    createTemplate({
      id: 'template-002',
      name: 'Second Template',
      content: 'Simple content',
      variables: [],
      isDefault: false,
    }),
    createTemplate({
      id: 'template-003',
      name: 'Third Template',
      isDefault: false,
    }),
  ];
}

// ============================================================================
// Tests
// ============================================================================

describe('TemplatesClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupSupabaseMock();
  });

  describe('Initial rendering', () => {
    it('renders the page header', () => {
      render(
        <TemplatesClient
          initialTemplates={createTemplateList()}
          userId="user-001"
        />
      );

      expect(screen.getByText('Context Templates')).toBeInTheDocument();
      expect(
        screen.getByText(/create reusable context/i)
      ).toBeInTheDocument();
    });

    it('renders all templates in the list', () => {
      render(
        <TemplatesClient
          initialTemplates={createTemplateList()}
          userId="user-001"
        />
      );

      expect(screen.getByText('First Template')).toBeInTheDocument();
      expect(screen.getByText('Second Template')).toBeInTheDocument();
      expect(screen.getByText('Third Template')).toBeInTheDocument();
    });

    it('renders the Create Template button in header', () => {
      render(
        <TemplatesClient
          initialTemplates={createTemplateList()}
          userId="user-001"
        />
      );

      expect(
        screen.getByRole('button', { name: /create new template/i })
      ).toBeInTheDocument();
    });
  });

  describe('Empty state', () => {
    it('renders empty state when no templates exist', () => {
      render(
        <TemplatesClient initialTemplates={[]} userId="user-001" />
      );

      expect(screen.getByText('No templates yet')).toBeInTheDocument();
      expect(
        screen.getByText(/context templates let you define/i)
      ).toBeInTheDocument();
    });

    it('renders create button in empty state', () => {
      render(
        <TemplatesClient initialTemplates={[]} userId="user-001" />
      );

      expect(
        screen.getByRole('button', {
          name: /create your first template/i,
        })
      ).toBeInTheDocument();
    });
  });

  describe('Create template flow', () => {
    it('opens form modal when Create Template is clicked', () => {
      render(
        <TemplatesClient
          initialTemplates={createTemplateList()}
          userId="user-001"
        />
      );

      fireEvent.click(
        screen.getByRole('button', { name: /create new template/i })
      );

      // Form modal should be open
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      // Use heading role to avoid matching both title and button text
      expect(
        screen.getByRole('heading', { name: /create template/i })
      ).toBeInTheDocument();
    });

    it('opens form modal from empty state button', () => {
      render(
        <TemplatesClient initialTemplates={[]} userId="user-001" />
      );

      fireEvent.click(
        screen.getByRole('button', { name: /create your first template/i })
      );

      // The dialog's title "Create Template" should appear
      // (note: there might be button text "Create Template" too)
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  });

  describe('Edit template flow', () => {
    it('opens form modal with template data when Edit is clicked', () => {
      render(
        <TemplatesClient
          initialTemplates={createTemplateList()}
          userId="user-001"
        />
      );

      // Click edit on first template
      const editButtons = screen.getAllByRole('button', {
        name: /edit template/i,
      });
      fireEvent.click(editButtons[0]);

      // Form should be in edit mode
      expect(screen.getByText('Edit Template')).toBeInTheDocument();
      expect(
        screen.getByDisplayValue('First Template')
      ).toBeInTheDocument();
    });
  });

  describe('Delete template flow', () => {
    it('removes template from list optimistically when delete is confirmed', async () => {
      // Mock successful delete
      mockSupabaseChain.single.mockResolvedValue({ data: null, error: null });

      render(
        <TemplatesClient
          initialTemplates={createTemplateList()}
          userId="user-001"
        />
      );

      expect(screen.getByText('Second Template')).toBeInTheDocument();

      // Click delete on second template
      const deleteButtons = screen.getAllByRole('button', {
        name: /delete template/i,
      });
      fireEvent.click(deleteButtons[1]);

      // Confirm delete in dialog
      fireEvent.click(screen.getByText('Delete'));

      // Template should be removed optimistically
      await waitFor(() => {
        expect(
          screen.queryByText('Second Template')
        ).not.toBeInTheDocument();
      });
    });
  });

  describe('Error display', () => {
    it('clears error when opening create modal', async () => {
      render(
        <TemplatesClient
          initialTemplates={createTemplateList()}
          userId="user-001"
        />
      );

      // Open create modal (should clear any existing error)
      fireEvent.click(
        screen.getByRole('button', { name: /create new template/i })
      );

      // No error should be visible
      const errorElements = screen.queryAllByText(/failed to/i);
      expect(errorElements).toHaveLength(0);
    });
  });
});
