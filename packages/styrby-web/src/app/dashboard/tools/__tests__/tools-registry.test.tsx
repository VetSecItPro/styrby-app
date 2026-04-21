/**
 * Tests for the MCP Tools Registry web component.
 *
 * Covers the user-visible behavior:
 * - Renders the GA tool (request_approval) prominently
 * - Renders planned tools in a separate section
 * - Setup snippet contains the exact .mcp.json config
 * - Copy button updates label after clicking
 *
 * @module app/dashboard/tools/__tests__/tools-registry
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToolsRegistry } from '../tools-registry';

describe('ToolsRegistry', () => {
  beforeEach(() => {
    // Stub clipboard for copy test
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it('renders the page header with MCP Tools title', () => {
    render(<ToolsRegistry />);
    expect(screen.getByRole('heading', { name: /mcp tools/i, level: 1 })).toBeTruthy();
  });

  it('shows the GA request_approval tool prominently', () => {
    render(<ToolsRegistry />);
    // Both the human title and the snake_case tool name should appear
    expect(screen.getByText('Request human approval')).toBeTruthy();
    // request_approval may appear in multiple places - just need at least one match
    const codeElements = screen.getAllByText('request_approval');
    expect(codeElements.length).toBeGreaterThan(0);
  });

  it('shows planned tools in a separate section', () => {
    render(<ToolsRegistry />);
    expect(screen.getByText(/look up team policy/i)).toBeTruthy();
    expect(screen.getByText(/write to audit log/i)).toBeTruthy();
  });

  it('includes the setup snippet with styrby mcp serve command', () => {
    render(<ToolsRegistry />);
    // Snippet uses literal text - search for unique strings
    expect(screen.getByText(/mcpServers/)).toBeTruthy();
    expect(screen.getByText(/"command": "styrby"/)).toBeTruthy();
  });

  it('copy button writes snippet to clipboard and shows confirmation', async () => {
    render(<ToolsRegistry />);
    const copyButton = screen.getByRole('button', { name: /copy setup snippet/i });

    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledOnce();
    });
    const calls = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toContain('"styrby"');
    expect(calls[0][0]).toContain('"mcp", "serve"');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /copied to clipboard/i })).toBeTruthy();
    });
  });

  it('links to the modelcontextprotocol.io docs', () => {
    render(<ToolsRegistry />);
    const link = screen.getByRole('link', { name: /learn about model context protocol/i });
    expect(link.getAttribute('href')).toBe('https://modelcontextprotocol.io');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });
});
