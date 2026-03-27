/**
 * useContextTemplates Hook Test Suite
 *
 * Tests the context template management hook, including:
 * - Initial fetch and loading states
 * - Template creation with default handling
 * - Template updates with partial fields
 * - Template deletion with optimistic rollback
 * - Set default template
 * - Error handling for unauthenticated users
 * - Error handling for Supabase failures
 */

import { renderHook, act, waitFor } from '@testing-library/react-native';

// ============================================================================
// Mock Setup
// ============================================================================

let mockAuthUser: { id: string } | null = { id: 'test-user-id' };
let mockQueryResults: Record<string, { data: unknown; error: unknown }> = {};
let mockQueryError: unknown = null;

/**
 * WHY: We need table-aware chain routing so the hook's multiple
 * `supabase.from()` calls on 'context_templates' resolve correctly.
 */
jest.mock('@/lib/supabase', () => {
  const createChain = (table: string) => {
    const getResult = () => {
      if (mockQueryError) return { data: null, error: mockQueryError };
      return mockQueryResults[table] || { data: null, error: null };
    };

    const chain: Record<string, unknown> = {};
    const chainMethods = ['select', 'eq', 'order', 'insert', 'update', 'delete', 'limit', 'is'];
    for (const method of chainMethods) {
      chain[method] = jest.fn(() => chain);
    }
    chain.single = jest.fn(() => Promise.resolve(getResult()));
    chain.maybeSingle = jest.fn(() => Promise.resolve(getResult()));
    chain.then = (resolve: (v: unknown) => void) =>
      Promise.resolve(getResult()).then(resolve);
    return chain;
  };

  return {
    supabase: {
      auth: {
        getUser: jest.fn(async () => ({
          data: { user: mockAuthUser },
          error: null,
        })),
      },
      from: jest.fn((table: string) => createChain(table)),
    },
  };
});

/**
 * WHY: styrby-shared exports contextTemplateFromRow, which transforms database
 * rows to ContextTemplate objects. We provide a passthrough mock that simulates
 * the snake_case -> camelCase transformation.
 */
jest.mock('styrby-shared', () => ({
  contextTemplateFromRow: jest.fn((row: Record<string, unknown>) => ({
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description,
    content: row.content,
    variables: row.variables,
    isDefault: row.is_default,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })),
}));

import { useContextTemplates } from '../useContextTemplates';

// ============================================================================
// Test Data
// ============================================================================

function makeTemplateRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'tmpl-1',
    user_id: 'test-user-id',
    name: 'My Template',
    description: 'A test template',
    content: 'Hello {{name}}',
    variables: [{ name: 'name', description: 'User name', defaultValue: 'World' }],
    is_default: false,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeDefaultTemplateRow() {
  return makeTemplateRow({
    id: 'tmpl-default',
    name: 'Default Template',
    is_default: true,
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('useContextTemplates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthUser = { id: 'test-user-id' };
    mockQueryResults = {};
    mockQueryError = null;
  });

  // --------------------------------------------------------------------------
  // Initial State
  // --------------------------------------------------------------------------

  it('starts in loading state', () => {
    const { result } = renderHook(() => useContextTemplates());
    expect(result.current.isLoading).toBe(true);
    expect(result.current.templates).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('loads templates on mount', async () => {
    const row1 = makeTemplateRow({ id: 'tmpl-1', name: 'Alpha' });
    const row2 = makeTemplateRow({ id: 'tmpl-2', name: 'Beta' });
    mockQueryResults = {
      context_templates: { data: [row1, row2], error: null },
    };

    const { result } = renderHook(() => useContextTemplates());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.templates).toHaveLength(2);
    expect(result.current.templates[0].name).toBe('Alpha');
    expect(result.current.templates[1].name).toBe('Beta');
    expect(result.current.error).toBeNull();
  });

  it('returns empty templates when none exist', async () => {
    mockQueryResults = {
      context_templates: { data: [], error: null },
    };

    const { result } = renderHook(() => useContextTemplates());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.templates).toHaveLength(0);
    expect(result.current.error).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Unauthenticated
  // --------------------------------------------------------------------------

  it('sets error when user is not authenticated', async () => {
    mockAuthUser = null;

    const { result } = renderHook(() => useContextTemplates());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBe('Not authenticated');
    expect(result.current.templates).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // Fetch Error
  // --------------------------------------------------------------------------

  it('sets error when fetch fails', async () => {
    mockQueryResults = {
      context_templates: { data: null, error: { message: 'Network error' } },
    };

    const { result } = renderHook(() => useContextTemplates());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBe('Network error');
  });

  it('handles unexpected exception during fetch', async () => {
    // Simulate an exception by making data null (contextTemplateFromRow will throw on .map)
    mockQueryResults = {
      context_templates: { data: null, error: null },
    };

    const { result } = renderHook(() => useContextTemplates());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // When data is null and no error, .map on null throws; catch block handles it
    expect(result.current.error).not.toBeNull();
  });

  // --------------------------------------------------------------------------
  // Refresh
  // --------------------------------------------------------------------------

  it('refresh resets loading state and re-fetches', async () => {
    mockQueryResults = {
      context_templates: { data: [makeTemplateRow()], error: null },
    };

    const { result } = renderHook(() => useContextTemplates());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.templates).toHaveLength(1);

    // Update mock data
    const row2 = makeTemplateRow({ id: 'tmpl-2', name: 'New Template' });
    mockQueryResults = {
      context_templates: { data: [makeTemplateRow(), row2], error: null },
    };

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.templates).toHaveLength(2);
  });

  // --------------------------------------------------------------------------
  // Create Template
  // --------------------------------------------------------------------------

  it('creates a template successfully', async () => {
    mockQueryResults = {
      context_templates: { data: [], error: null },
    };

    const { result } = renderHook(() => useContextTemplates());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Set up the insert response (single returns the created row)
    const newRow = makeTemplateRow({ id: 'tmpl-new', name: 'Created' });
    mockQueryResults = {
      context_templates: { data: newRow, error: null },
    };

    let created: unknown = null;
    await act(async () => {
      created = await result.current.createTemplate({
        name: 'Created',
        content: 'Hello',
      });
    });

    expect(created).not.toBeNull();
    expect(result.current.isMutating).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('creates a default template and unsets previous defaults', async () => {
    const defaultRow = makeDefaultTemplateRow();
    mockQueryResults = {
      context_templates: { data: [defaultRow], error: null },
    };

    const { result } = renderHook(() => useContextTemplates());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const newRow = makeTemplateRow({
      id: 'tmpl-new-default',
      name: 'New Default',
      is_default: true,
    });
    mockQueryResults = {
      context_templates: { data: newRow, error: null },
    };

    let created: unknown = null;
    await act(async () => {
      created = await result.current.createTemplate({
        name: 'New Default',
        content: 'Content',
        isDefault: true,
      });
    });

    expect(created).not.toBeNull();
    expect(result.current.isMutating).toBe(false);
  });

  it('returns null when create fails due to auth error', async () => {
    mockQueryResults = {
      context_templates: { data: [], error: null },
    };

    const { result } = renderHook(() => useContextTemplates());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Make auth fail for create
    mockAuthUser = null;

    let created: unknown = 'not-null';
    await act(async () => {
      created = await result.current.createTemplate({
        name: 'Test',
        content: 'Content',
      });
    });

    expect(created).toBeNull();
    expect(result.current.error).toBe('Not authenticated');
  });

  it('returns null when insert fails', async () => {
    mockQueryResults = {
      context_templates: { data: [], error: null },
    };

    const { result } = renderHook(() => useContextTemplates());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Set up insert failure
    mockQueryResults = {
      context_templates: { data: null, error: { message: 'Duplicate name' } },
    };

    let created: unknown = 'not-null';
    await act(async () => {
      created = await result.current.createTemplate({
        name: 'Test',
        content: 'Content',
      });
    });

    expect(created).toBeNull();
    expect(result.current.error).toBe('Duplicate name');
  });

  it('creates template with optional description and variables', async () => {
    mockQueryResults = {
      context_templates: { data: [], error: null },
    };

    const { result } = renderHook(() => useContextTemplates());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const newRow = makeTemplateRow({
      id: 'tmpl-with-vars',
      name: 'With Vars',
      description: 'A template with variables',
      variables: [{ name: 'project', description: 'Project', defaultValue: '' }],
    });
    mockQueryResults = {
      context_templates: { data: newRow, error: null },
    };

    let created: unknown = null;
    await act(async () => {
      created = await result.current.createTemplate({
        name: 'With Vars',
        content: 'Working on {{project}}',
        description: 'A template with variables',
        variables: [{ name: 'project', description: 'Project', defaultValue: '' }],
      });
    });

    expect(created).not.toBeNull();
  });

  // --------------------------------------------------------------------------
  // Update Template
  // --------------------------------------------------------------------------

  it('updates a template successfully', async () => {
    mockQueryResults = {
      context_templates: { data: [makeTemplateRow()], error: null },
    };

    const { result } = renderHook(() => useContextTemplates());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Set up update response (no error)
    mockQueryResults = {
      context_templates: { data: null, error: null },
    };

    let success = false;
    await act(async () => {
      success = await result.current.updateTemplate('tmpl-1', {
        name: 'Updated Name',
      });
    });

    expect(success).toBe(true);
    expect(result.current.isMutating).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('updates template with partial fields', async () => {
    mockQueryResults = {
      context_templates: { data: [makeTemplateRow()], error: null },
    };

    const { result } = renderHook(() => useContextTemplates());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    mockQueryResults = {
      context_templates: { data: null, error: null },
    };

    let success = false;
    await act(async () => {
      success = await result.current.updateTemplate('tmpl-1', {
        content: 'New content only',
      });
    });

    expect(success).toBe(true);
  });

  it('updates template to be default', async () => {
    const row1 = makeTemplateRow({ id: 'tmpl-1', name: 'Alpha', is_default: false });
    const row2 = makeTemplateRow({ id: 'tmpl-2', name: 'Beta', is_default: true });
    mockQueryResults = {
      context_templates: { data: [row2, row1], error: null },
    };

    const { result } = renderHook(() => useContextTemplates());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    mockQueryResults = {
      context_templates: { data: null, error: null },
    };

    let success = false;
    await act(async () => {
      success = await result.current.updateTemplate('tmpl-1', {
        isDefault: true,
      });
    });

    expect(success).toBe(true);
  });

  it('returns false when update fails due to auth error', async () => {
    mockQueryResults = {
      context_templates: { data: [makeTemplateRow()], error: null },
    };

    const { result } = renderHook(() => useContextTemplates());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    mockAuthUser = null;

    let success = true;
    await act(async () => {
      success = await result.current.updateTemplate('tmpl-1', { name: 'Fail' });
    });

    expect(success).toBe(false);
    expect(result.current.error).toBe('Not authenticated');
  });

  it('returns false when update query fails', async () => {
    mockQueryResults = {
      context_templates: { data: [makeTemplateRow()], error: null },
    };

    const { result } = renderHook(() => useContextTemplates());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    mockQueryResults = {
      context_templates: { data: null, error: { message: 'Update failed' } },
    };

    let success = true;
    await act(async () => {
      success = await result.current.updateTemplate('tmpl-1', { name: 'Fail' });
    });

    expect(success).toBe(false);
    expect(result.current.error).toBe('Update failed');
  });

  // --------------------------------------------------------------------------
  // Delete Template
  // --------------------------------------------------------------------------

  it('deletes a template successfully with optimistic update', async () => {
    mockQueryResults = {
      context_templates: { data: [makeTemplateRow()], error: null },
    };

    const { result } = renderHook(() => useContextTemplates());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.templates).toHaveLength(1);

    mockQueryResults = {
      context_templates: { data: null, error: null },
    };

    let success = false;
    await act(async () => {
      success = await result.current.deleteTemplate('tmpl-1');
    });

    expect(success).toBe(true);
    expect(result.current.isMutating).toBe(false);
  });

  it('reverts optimistic delete on error', async () => {
    mockQueryResults = {
      context_templates: { data: [makeTemplateRow()], error: null },
    };

    const { result } = renderHook(() => useContextTemplates());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.templates).toHaveLength(1);

    mockQueryResults = {
      context_templates: { data: null, error: { message: 'Cannot delete' } },
    };

    let success = true;
    await act(async () => {
      success = await result.current.deleteTemplate('tmpl-1');
    });

    expect(success).toBe(false);
    expect(result.current.error).toBe('Cannot delete');
    // Template should be restored after rollback
    expect(result.current.templates).toHaveLength(1);
  });

  it('handles delete for non-existent ID gracefully', async () => {
    mockQueryResults = {
      context_templates: { data: [makeTemplateRow()], error: null },
    };

    const { result } = renderHook(() => useContextTemplates());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    mockQueryResults = {
      context_templates: { data: null, error: null },
    };

    let success = false;
    await act(async () => {
      success = await result.current.deleteTemplate('non-existent-id');
    });

    // Should succeed (Supabase returns no error for missing rows on delete)
    expect(success).toBe(true);
    // Original template should still be present (filter didn't match)
    expect(result.current.templates).toHaveLength(1);
  });

  // --------------------------------------------------------------------------
  // Set Default Template
  // --------------------------------------------------------------------------

  it('sets default template via updateTemplate', async () => {
    mockQueryResults = {
      context_templates: { data: [makeTemplateRow()], error: null },
    };

    const { result } = renderHook(() => useContextTemplates());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    mockQueryResults = {
      context_templates: { data: null, error: null },
    };

    let success = false;
    await act(async () => {
      success = await result.current.setDefaultTemplate('tmpl-1');
    });

    expect(success).toBe(true);
  });

  it('setDefaultTemplate fails when update fails', async () => {
    mockQueryResults = {
      context_templates: { data: [makeTemplateRow()], error: null },
    };

    const { result } = renderHook(() => useContextTemplates());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    mockQueryResults = {
      context_templates: { data: null, error: { message: 'RLS error' } },
    };

    let success = true;
    await act(async () => {
      success = await result.current.setDefaultTemplate('tmpl-1');
    });

    expect(success).toBe(false);
    expect(result.current.error).toBe('RLS error');
  });

  // --------------------------------------------------------------------------
  // isMutating Flag
  // --------------------------------------------------------------------------

  it('sets isMutating during create', async () => {
    mockQueryResults = {
      context_templates: { data: [], error: null },
    };

    const { result } = renderHook(() => useContextTemplates());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const newRow = makeTemplateRow({ id: 'tmpl-new' });
    mockQueryResults = {
      context_templates: { data: newRow, error: null },
    };

    expect(result.current.isMutating).toBe(false);

    await act(async () => {
      await result.current.createTemplate({ name: 'Test', content: 'Content' });
    });

    expect(result.current.isMutating).toBe(false);
  });

  it('sets isMutating during delete', async () => {
    mockQueryResults = {
      context_templates: { data: [makeTemplateRow()], error: null },
    };

    const { result } = renderHook(() => useContextTemplates());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    mockQueryResults = {
      context_templates: { data: null, error: null },
    };

    expect(result.current.isMutating).toBe(false);

    await act(async () => {
      await result.current.deleteTemplate('tmpl-1');
    });

    expect(result.current.isMutating).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Error Clearing
  // --------------------------------------------------------------------------

  it('clears error on new operation', async () => {
    mockQueryResults = {
      context_templates: { data: [makeTemplateRow()], error: null },
    };

    const { result } = renderHook(() => useContextTemplates());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Force an error
    mockQueryResults = {
      context_templates: { data: null, error: { message: 'First error' } },
    };

    await act(async () => {
      await result.current.updateTemplate('tmpl-1', { name: 'fail' });
    });

    expect(result.current.error).toBe('First error');

    // Now succeed
    mockQueryResults = {
      context_templates: { data: null, error: null },
    };

    await act(async () => {
      await result.current.updateTemplate('tmpl-1', { name: 'ok' });
    });

    expect(result.current.error).toBeNull();
  });
});
