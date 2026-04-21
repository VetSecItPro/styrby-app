'use client';

/**
 * MCP Tools Registry Client Component
 *
 * Renders the catalog from `@styrby/shared/mcp/catalog` with status badges
 * (GA/beta/planned), category icons, and a copy-to-clipboard setup snippet
 * for the most common MCP clients.
 *
 * Pure presentation — no data fetching, no auth checks beyond the dashboard
 * layout that wraps it. The catalog is static at build time, so a server
 * component would also work, but a client component lets us add the copy
 * button without an extra island.
 *
 * @module app/dashboard/tools/tools-registry
 */

import { useState, useMemo } from 'react';
import {
  STYRBY_MCP_TOOLS,
  type MCPToolDescriptor,
  type MCPToolStatus,
} from '@styrby/shared';
import {
  KeyRound,
  ShieldCheck,
  FileText,
  Database,
  Zap,
  Copy,
  Check,
  ExternalLink,
} from 'lucide-react';
import { Button } from '@/components/ui/button';

// ============================================================================
// Status badges
// ============================================================================

/**
 * Color/label mapping for tool lifecycle status.
 * Kept in one place so future statuses (deprecated?) only need editing here.
 */
const STATUS_BADGE: Record<MCPToolStatus, { label: string; className: string }> = {
  ga: {
    label: 'Available now',
    className: 'bg-green-500/10 text-green-400 border-green-500/30',
  },
  beta: {
    label: 'Beta',
    className: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  },
  planned: {
    label: 'Coming in 0.4',
    className: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/30',
  },
};

/**
 * Lucide icon for each tool category.
 * Categories drive icon choice; status drives color.
 */
const CATEGORY_ICON = {
  approval: KeyRound,
  policy: ShieldCheck,
  audit: FileText,
  query: Database,
  mutation: Zap,
} as const;

// ============================================================================
// Setup snippet
// ============================================================================

/**
 * The exact .mcp.json snippet most MCP clients accept (Claude Code, Cursor).
 * Kept as a constant rather than templated so users can copy verbatim.
 */
const SETUP_SNIPPET = `{
  "mcpServers": {
    "styrby": {
      "command": "styrby",
      "args": ["mcp", "serve"]
    }
  }
}`;

// ============================================================================
// Sub-components
// ============================================================================

/**
 * Single tool card with category icon, status badge, and description.
 */
function ToolCard({ tool }: { tool: MCPToolDescriptor }) {
  const Icon = CATEGORY_ICON[tool.category];
  const badge = STATUS_BADGE[tool.status];
  const isAvailable = tool.status === 'ga' || tool.status === 'beta';

  return (
    <div
      className={`rounded-lg border border-border/60 p-5 transition-colors ${
        isAvailable ? 'bg-card hover:border-amber-500/40' : 'bg-card/50 opacity-75'
      }`}
    >
      <div className="flex items-start gap-4">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
            isAvailable ? 'bg-amber-500/10' : 'bg-zinc-500/10'
          }`}
        >
          <Icon
            className={`h-5 w-5 ${isAvailable ? 'text-amber-500' : 'text-zinc-500'}`}
            aria-hidden="true"
          />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-foreground">{tool.title}</h3>
              <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                {tool.name}
              </p>
            </div>
            <span
              className={`shrink-0 rounded-full border px-2 py-0.5 text-xs ${badge.className}`}
            >
              {badge.label}
            </span>
          </div>

          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            {tool.description}
          </p>

          <p className="mt-3 text-xs text-muted-foreground">
            Introduced in v{tool.introducedIn}
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Code block + copy button for the .mcp.json setup snippet.
 */
function SetupSnippet() {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(SETUP_SNIPPET);
    setCopied(true);
    // WHY 2 second timeout: matches the user's perception window for "did
    // it copy?". Long enough they see the confirmation, short enough they
    // don't get confused if they click again.
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="relative rounded-lg border border-border/60 bg-zinc-900 p-4">
      <pre className="overflow-x-auto text-xs text-zinc-200">
        <code>{SETUP_SNIPPET}</code>
      </pre>
      <Button
        size="sm"
        variant="outline"
        onClick={handleCopy}
        className="absolute right-3 top-3 h-7 gap-1.5 border-zinc-700 bg-zinc-800/80 text-xs text-zinc-300 hover:bg-zinc-700"
        aria-label={copied ? 'Copied to clipboard' : 'Copy setup snippet'}
      >
        {copied ? (
          <>
            <Check className="h-3 w-3" /> Copied
          </>
        ) : (
          <>
            <Copy className="h-3 w-3" /> Copy
          </>
        )}
      </Button>
    </div>
  );
}

// ============================================================================
// Main page
// ============================================================================

/**
 * Top-level registry view: header, setup instructions, GA tools, planned
 * tools (collapsed by default).
 */
export function ToolsRegistry() {
  const { gaTools, plannedTools } = useMemo(() => {
    return {
      gaTools: STYRBY_MCP_TOOLS.filter((t) => t.status === 'ga' || t.status === 'beta'),
      plannedTools: STYRBY_MCP_TOOLS.filter((t) => t.status === 'planned'),
    };
  }, []);

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-6">
      {/* Header */}
      <header>
        <div className="flex items-center gap-3">
          <KeyRound className="h-6 w-6 text-amber-500" aria-hidden="true" />
          <h1 className="text-2xl font-semibold text-foreground">MCP Tools</h1>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          The Model Context Protocol lets your coding agents call back into
          Styrby for capabilities only Styrby has - like asking your phone for
          approval before running a destructive command. Wire up the snippet
          below in your agent&apos;s MCP config.
        </p>
      </header>

      {/* Setup snippet */}
      <section aria-labelledby="setup-heading">
        <h2 id="setup-heading" className="text-sm font-semibold text-foreground">
          1. Add Styrby to your agent&apos;s MCP config
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Drop this into <code className="rounded bg-zinc-800 px-1 py-0.5">.mcp.json</code>{' '}
          for Claude Code, Cursor, or any MCP-aware client.
        </p>
        <div className="mt-3">
          <SetupSnippet />
        </div>
      </section>

      {/* Available tools */}
      <section aria-labelledby="ga-heading">
        <h2 id="ga-heading" className="text-sm font-semibold text-foreground">
          2. Available tools ({gaTools.length})
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Your agents can call these the moment Styrby&apos;s MCP server is
          running.
        </p>
        <div className="mt-3 space-y-3">
          {gaTools.map((tool) => (
            <ToolCard key={tool.name} tool={tool} />
          ))}
        </div>
      </section>

      {/* Planned tools */}
      {plannedTools.length > 0 && (
        <section aria-labelledby="planned-heading">
          <h2 id="planned-heading" className="text-sm font-semibold text-foreground">
            3. Planned ({plannedTools.length})
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Roadmap items shipping in 0.4. Listed for transparency.
          </p>
          <div className="mt-3 space-y-3">
            {plannedTools.map((tool) => (
              <ToolCard key={tool.name} tool={tool} />
            ))}
          </div>
        </section>
      )}

      {/* External docs link */}
      <footer className="border-t border-border/40 pt-6">
        <a
          href="https://modelcontextprotocol.io"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          Learn about Model Context Protocol
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
      </footer>
    </div>
  );
}
