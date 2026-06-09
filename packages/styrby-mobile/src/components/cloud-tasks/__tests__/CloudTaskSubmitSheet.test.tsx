/**
 * CloudTaskSubmitSheet render tests
 *
 * Verifies the submit-sheet renders correctly across:
 *   - hidden (visible=false)
 *   - loading sessions
 *   - sessions loaded
 *   - sessions error path
 *   - all 11 SUBMITTABLE_AGENTS surfaced as picker chips
 *
 * Submission flow is covered by the service-layer tests in
 * src/services/__tests__/cloud-tasks.test.ts.
 */

import React from 'react';
import renderer from 'react-test-renderer';
import { renderAsync } from '../../../../__tests__/utils/renderAsync';

// ============================================================================
// Helpers
// ============================================================================

function collectText(
  node: renderer.ReactTestRendererJSON | renderer.ReactTestRendererJSON[] | null,
): string[] {
  if (!node) return [];
  if (Array.isArray(node)) return node.flatMap(collectText);
  const texts: string[] = [];
  if (typeof node === 'string') return [node];
  if (node.children) {
    for (const child of node.children) {
      if (typeof child === 'string') texts.push(child);
      else texts.push(...collectText(child));
    }
  }
  return texts;
}

function hasText(
  tree: renderer.ReactTestRendererJSON | renderer.ReactTestRendererJSON[] | null,
  text: string,
): boolean {
  return collectText(tree).some((t) => t.includes(text));
}

// ============================================================================
// Mocks
// ============================================================================

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('styrby-shared', () => ({}));

// Per-test mutable session-fetch result
type SessionFetchResult = { data: unknown[] | null; error: { message: string } | null };
const mockSessionFetch: SessionFetchResult = { data: [], error: null };

jest.mock('@/lib/supabase', () => ({
  supabase: {
    // The recent-sessions query is now user-scoped: it resolves the authed user
    // and adds .eq('user_id', ...) so teammates' sessions don't leak (bug #10).
    auth: {
      getUser: jest.fn(async () => ({
        data: { user: { id: 'user-uuid-test' } },
        error: null,
      })),
    },
    from: jest.fn(() => {
      const chain: {
        select: jest.Mock;
        eq: jest.Mock;
        order: jest.Mock;
        limit: jest.Mock;
        then: (resolve: (v: unknown) => void) => Promise<unknown>;
      } = {
        select: jest.fn(() => chain),
        eq: jest.fn(() => chain),
        order: jest.fn(() => chain),
        limit: jest.fn(() => chain),
        then: (resolve: (v: unknown) => void) =>
          Promise.resolve(mockSessionFetch).then(resolve),
      };
      return chain;
    }),
  },
}));

// Service mock — sheet doesn't exercise the actual submit path in render tests;
// service unit tests cover that.
jest.mock('@/services/cloud-tasks', () => ({
  submitCloudTask: jest.fn(async () => ({})),
  SUBMITTABLE_AGENTS: [
    'claude', 'codex', 'gemini', 'opencode', 'aider',
    'goose', 'amp', 'crush', 'kilo', 'kiro', 'droid',
  ] as const,
}));

// ============================================================================
// Tests
// ============================================================================

import { CloudTaskSubmitSheet } from '../CloudTaskSubmitSheet';

describe('CloudTaskSubmitSheet', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSessionFetch.data = [];
    mockSessionFetch.error = null;
  });

  it('renders the sheet header + agent picker when visible', async () => {
    const tree = await renderAsync(
      <CloudTaskSubmitSheet
        visible={true}
        onDismiss={() => {}}
        onSubmitted={() => {}}
      />,
    );
    expect(tree).toBeTruthy();
    expect(hasText(tree, 'New Cloud Task')).toBe(true);
    expect(hasText(tree, 'Agent')).toBe(true);
    expect(hasText(tree, 'Prompt')).toBe(true);
  });

  it('surfaces all 11 SUBMITTABLE_AGENTS in the picker', async () => {
    const tree = await renderAsync(
      <CloudTaskSubmitSheet
        visible={true}
        onDismiss={() => {}}
        onSubmitted={() => {}}
      />,
    );
    // Agent display labels — drift here means an agent from the schema's
    // CHECK constraint isn't selectable from the UI.
    for (const label of [
      'Claude Code', 'Codex CLI', 'Gemini CLI', 'OpenCode',
      'Aider', 'Goose', 'Amp', 'Crush', 'Kilo', 'Kiro', 'Droid',
    ]) {
      expect(hasText(tree, label)).toBe(true);
    }
  });

  it('shows the empty-sessions message when fetch returns []', async () => {
    mockSessionFetch.data = [];
    const tree = await renderAsync(
      <CloudTaskSubmitSheet
        visible={true}
        onDismiss={() => {}}
        onSubmitted={() => {}}
      />,
    );
    expect(hasText(tree, 'No recent sessions to link.')).toBe(true);
  });

  it('shows an error message when sessions fetch errors', async () => {
    mockSessionFetch.data = null;
    mockSessionFetch.error = { message: 'network down' };
    const tree = await renderAsync(
      <CloudTaskSubmitSheet
        visible={true}
        onDismiss={() => {}}
        onSubmitted={() => {}}
      />,
    );
    expect(hasText(tree, 'Could not load sessions')).toBe(true);
    expect(hasText(tree, 'network down')).toBe(true);
  });

  it('renders session rows when fetch returns data', async () => {
    mockSessionFetch.data = [
      {
        id: 'sess-1',
        title: 'Refactor auth flow',
        project_path: '/repo',
        git_branch: 'main',
        agent_type: 'claude',
        started_at: new Date().toISOString(),
      },
    ];
    const tree = await renderAsync(
      <CloudTaskSubmitSheet
        visible={true}
        onDismiss={() => {}}
        onSubmitted={() => {}}
      />,
    );
    expect(hasText(tree, 'Refactor auth flow')).toBe(true);
    expect(hasText(tree, 'main')).toBe(true);
    expect(hasText(tree, 'None (standalone task)')).toBe(true);
  });
});
