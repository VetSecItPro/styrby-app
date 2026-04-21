/**
 * MCPToolsScreen tests.
 *
 * Smoke render via react-test-renderer (matches the rest of the mobile
 * suite that runs in node env without jsdom).
 *
 * Covers:
 * - Renders without crashing
 * - Shows the GA "Available" tool
 * - Shows the planned section with at least one planned tool
 * - Setup snippet contains the styrby mcp serve command
 * - Copy button is wired (Pressable with the right accessibilityLabel)
 *
 * @module app/settings/__tests__/tools
 */

import React from 'react';
import renderer from 'react-test-renderer';

// ── Helpers ────────────────────────────────────────────────────────────────

function collectText(
  node: renderer.ReactTestRendererJSON | renderer.ReactTestRendererJSON[] | null,
): string[] {
  if (!node) return [];
  if (Array.isArray(node)) return node.flatMap(collectText);
  if (typeof node === 'string') return [node];
  const texts: string[] = [];
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

// ── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('expo-router', () => ({
  Stack: { Screen: 'StackScreen' },
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn().mockResolvedValue(undefined),
}));

// Stub styrby-shared with the catalog the screen needs.
// WHY: The real package's index.ts uses TypeScript ESM with .js extensions
// which Jest's CJS resolver can't follow. The notifications.test.tsx file
// uses the same pattern.
jest.mock('styrby-shared', () => ({
  STYRBY_MCP_TOOLS: [
    {
      name: 'request_approval',
      title: 'Request human approval',
      description:
        'Sends a push notification to the paired mobile device asking the user to approve or deny a high-risk action.',
      category: 'approval',
      status: 'ga',
      introducedIn: '0.2.0',
    },
    {
      name: 'get_team_policy',
      title: 'Look up team policy',
      description: 'Returns the effective approval/budget/blocked-tool policy. Phase 4.',
      category: 'policy',
      status: 'planned',
      introducedIn: '0.4.0',
    },
  ],
}));

// ── Tests ──────────────────────────────────────────────────────────────────

const MCPToolsScreen = require('../tools').default as React.ComponentType;

describe('MCPToolsScreen', () => {
  it('renders without crashing', () => {
    let tree: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<MCPToolsScreen />);
    });
    expect(tree!.toJSON()).toBeTruthy();
  });

  it('shows the GA request_approval tool', () => {
    let tree: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<MCPToolsScreen />);
    });
    expect(hasText(tree!.toJSON(), 'Request human approval')).toBe(true);
    expect(hasText(tree!.toJSON(), 'request_approval')).toBe(true);
    expect(hasText(tree!.toJSON(), 'Available')).toBe(true);
  });

  it('shows planned tools section with at least one planned tool', () => {
    let tree: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<MCPToolsScreen />);
    });
    expect(hasText(tree!.toJSON(), 'Look up team policy')).toBe(true);
    expect(hasText(tree!.toJSON(), 'Coming soon')).toBe(true);
  });

  it('shows the .mcp.json setup snippet with styrby command', () => {
    let tree: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<MCPToolsScreen />);
    });
    expect(hasText(tree!.toJSON(), 'mcpServers')).toBe(true);
    expect(hasText(tree!.toJSON(), '"command": "styrby"')).toBe(true);
    expect(hasText(tree!.toJSON(), '"mcp", "serve"')).toBe(true);
  });

  it('renders a copy button with the correct accessibility label', () => {
    let tree: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<MCPToolsScreen />);
    });
    // Initially the label is "Copy setup snippet" (becomes "Copied to clipboard"
    // after press; not exercised here to avoid timer-based flakiness).
    const buttons = tree!.root.findAllByProps({
      accessibilityLabel: 'Copy setup snippet',
    });
    expect(buttons.length).toBeGreaterThan(0);
  });

  it('renders a link to the MCP docs', () => {
    let tree: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<MCPToolsScreen />);
    });
    expect(hasText(tree!.toJSON(), 'Learn about Model Context Protocol')).toBe(true);
  });
});
