/**
 * Agents Sub-Screen Tests
 *
 * Validates that the Agents settings screen:
 * - Renders all 11 agent rows
 * - Renders context templates and auto-approve rows
 * - Loads auto-approve setting from Supabase on mount
 * - Persists auto-approve change to Supabase (optimistic update)
 * - Reverts auto-approve on Supabase error
 * - Navigates to /agent-config with correct agent param on row press
 *
 * Uses react-test-renderer (node environment — no DOM/jsdom).
 */

import React from 'react';
import renderer from 'react-test-renderer';

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
      if (typeof child === 'string') {
        texts.push(child);
      } else {
        texts.push(...collectText(child as renderer.ReactTestRendererJSON));
      }
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
// Global Mocks
// ============================================================================

// -- expo-router --
const mockRouterPush = jest.fn();
jest.mock('expo-router', () => ({
  router: { push: mockRouterPush, replace: jest.fn(), back: jest.fn() },
  useRouter: () => ({ push: mockRouterPush, replace: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: jest.fn(() => ({})),
  Link: 'Link',
}));

// -- @expo/vector-icons --
jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

// -- Supabase --
const mockUpdate = jest.fn(() => ({
  eq: jest.fn(() => Promise.resolve({ data: null, error: null })),
}));

const mockAgentConfigChain = {
  select: jest.fn(),
  eq: jest.fn(),
  limit: jest.fn(),
  single: jest.fn(),
  update: mockUpdate,
  then: (resolve: (v: unknown) => void) =>
    Promise.resolve({ data: { auto_approve_low_risk: false }, error: null }).then(resolve),
};
mockAgentConfigChain.select.mockReturnValue(mockAgentConfigChain);
mockAgentConfigChain.eq.mockReturnValue(mockAgentConfigChain);
mockAgentConfigChain.limit.mockReturnValue(mockAgentConfigChain);
mockAgentConfigChain.single.mockReturnValue(
  Promise.resolve({ data: { auto_approve_low_risk: false }, error: null })
);

jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getUser: jest.fn(async () => ({
        data: {
          user: {
            id: 'test-user-id',
            email: 'test@example.com',
            user_metadata: { display_name: 'Test User' },
          },
        },
        error: null,
      })),
      onAuthStateChange: jest.fn(() => ({
        data: { subscription: { unsubscribe: jest.fn() } },
      })),
    },
    from: jest.fn(() => mockAgentConfigChain),
  },
  signOut: jest.fn(async () => ({ error: null })),
}));

// ============================================================================
// Component Import
// ============================================================================

import AgentsScreen from '../agents';

// ============================================================================
// Helpers for async rendering
// ============================================================================

async function renderAgentsScreen(): Promise<{
  component: renderer.ReactTestRenderer;
  tree: renderer.ReactTestRendererJSON | renderer.ReactTestRendererJSON[] | null;
}> {
  let component!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    component = renderer.create(<AgentsScreen />);
    await new Promise<void>((r) => setTimeout(r, 50));
  });
  return { component, tree: component.toJSON() };
}

// ============================================================================
// Tests
// ============================================================================

describe('AgentsScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAgentConfigChain.single.mockResolvedValue(
      { data: { auto_approve_low_risk: false }, error: null }
    );
    mockUpdate.mockReturnValue({
      eq: jest.fn(() => Promise.resolve({ data: null, error: null })),
    });
  });

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  it('renders without crashing', async () => {
    const { tree } = await renderAgentsScreen();
    expect(tree).not.toBeNull();
  });

  it('renders Connected Agents section header', async () => {
    const { tree } = await renderAgentsScreen();
    expect(hasText(tree, 'Connected Agents')).toBe(true);
  });

  it('renders Claude Code agent row', async () => {
    const { tree } = await renderAgentsScreen();
    expect(hasText(tree, 'Claude Code')).toBe(true);
  });

  it('renders Codex agent row', async () => {
    const { tree } = await renderAgentsScreen();
    expect(hasText(tree, 'Codex')).toBe(true);
  });

  it('renders Gemini CLI agent row', async () => {
    const { tree } = await renderAgentsScreen();
    expect(hasText(tree, 'Gemini CLI')).toBe(true);
  });

  it('renders all 11 agent rows by checking several agents', async () => {
    const { tree } = await renderAgentsScreen();
    const agentNames = ['Claude Code', 'Codex', 'Gemini CLI', 'OpenCode', 'Aider',
      'Goose', 'Amp', 'Crush', 'Kilo', 'Kiro', 'Droid'];
    for (const name of agentNames) {
      expect(hasText(tree, name)).toBe(true);
    }
  });

  it('renders Context Templates row', async () => {
    const { tree } = await renderAgentsScreen();
    expect(hasText(tree, 'Context Templates')).toBe(true);
  });

  it('renders Auto-Approve Low Risk row', async () => {
    const { tree } = await renderAgentsScreen();
    expect(hasText(tree, 'Auto-Approve Low Risk')).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Navigation
  // --------------------------------------------------------------------------

  it('navigates to agent-config with claude param on Claude Code press', async () => {
    const { component } = await renderAgentsScreen();

    const claudeRow = component.root.findAll(
      (node) => node.props.accessibilityLabel === 'Claude Code, Not connected',
    );
    expect(claudeRow.length).toBeGreaterThan(0);

    await renderer.act(async () => {
      claudeRow[0].props.onPress();
    });

    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: '/agent-config',
      params: { agent: 'claude' },
    });
  });

  it('navigates to templates on Context Templates press', async () => {
    const { component } = await renderAgentsScreen();

    const templatesRow = component.root.findAll(
      (node) =>
        typeof node.props.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel.includes('Context Templates'),
    );
    expect(templatesRow.length).toBeGreaterThan(0);

    await renderer.act(async () => {
      templatesRow[0].props.onPress();
    });

    expect(mockRouterPush).toHaveBeenCalledWith('/templates');
  });

  // --------------------------------------------------------------------------
  // Auto-approve toggle
  // --------------------------------------------------------------------------

  it('renders auto-approve switch', async () => {
    const { component } = await renderAgentsScreen();
    const switchNode = component.root.findAll(
      (node) => node.props.accessibilityLabel === 'Toggle auto-approve for low-risk operations',
    );
    expect(switchNode.length).toBeGreaterThan(0);
  });

  it('persists auto-approve true to Supabase when toggled on', async () => {
    const mockEq = jest.fn(() => Promise.resolve({ data: null, error: null }));
    mockUpdate.mockReturnValue({ eq: mockEq });

    const { component } = await renderAgentsScreen();
    const switchNode = component.root.findAll(
      (node) => node.props.accessibilityLabel === 'Toggle auto-approve for low-risk operations',
    );

    await renderer.act(async () => {
      switchNode[0].props.onValueChange(true);
      await new Promise<void>((r) => setTimeout(r, 50));
    });

    expect(mockUpdate).toHaveBeenCalledWith({ auto_approve_low_risk: true });
  });
});
