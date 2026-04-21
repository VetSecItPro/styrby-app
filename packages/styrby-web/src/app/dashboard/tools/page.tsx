/**
 * MCP Tools Registry Page
 *
 * Shows the user the catalog of MCP (Model Context Protocol) tools that
 * Styrby's CLI MCP server exposes to MCP-aware coding agents (Claude Code,
 * Codex, Cursor, etc.).
 *
 * ## Why a registry page
 *
 * MCP is opaque to non-technical users. They wire up Styrby in their
 * agent's config and have no visibility into what tools the agent can
 * call. This page makes that surface explicit:
 *   - Which tools exist today (GA)
 *   - Which are coming (planned)
 *   - What each one does in plain language
 *   - The exact .mcp.json snippet to wire it up
 *
 * Phase 4 will expand this into a full MCP marketplace where users can
 * install and authorize third-party MCP servers (modelcontextprotocol/registry).
 *
 * @module app/dashboard/tools/page
 */

import type { Metadata } from 'next';
import { ToolsRegistry } from './tools-registry';

export const metadata: Metadata = {
  title: 'MCP Tools | Styrby',
  description:
    'Catalog of Model Context Protocol tools Styrby exposes to MCP-aware coding agents. Wire Styrby into Claude Code, Codex, Cursor, and more.',
};

export default function ToolsPage() {
  return <ToolsRegistry />;
}
