/**
 * McpConnectionStatus — renders the user's MCP readiness checklist.
 *
 * Presentational. Takes the readiness computed server-side (see
 * mcp-readiness.ts) and shows, per prerequisite, whether the user is ready and
 * the exact command to fix any gap. This is the "authorize" half of the
 * install flow: it tells the user whether their wired-up snippet will actually
 * work, instead of failing silently.
 *
 * @module app/dashboard/tools/McpConnectionStatus
 */

import { CheckCircle2, AlertCircle, Info, MinusCircle } from 'lucide-react';
import type { McpReadiness, McpCheck, McpCheckStatus } from './mcp-readiness';

/** Visual treatment per check status. */
const STATUS_STYLE: Record<
  McpCheckStatus,
  { icon: typeof CheckCircle2; iconClass: string; chip: string; chipLabel: string }
> = {
  ready: {
    icon: CheckCircle2,
    iconClass: 'text-green-400',
    chip: 'bg-green-500/10 text-green-400 border-green-500/30',
    chipLabel: 'Ready',
  },
  'action-needed': {
    icon: AlertCircle,
    iconClass: 'text-amber-400',
    chip: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
    chipLabel: 'Action needed',
  },
  recommended: {
    icon: Info,
    iconClass: 'text-blue-400',
    chip: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
    chipLabel: 'Recommended',
  },
  optional: {
    icon: MinusCircle,
    iconClass: 'text-zinc-500',
    chip: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/30',
    chipLabel: 'Optional',
  },
};

/** A single readiness row. */
function CheckRow({ check }: { check: McpCheck }) {
  const style = STATUS_STYLE[check.status];
  const Icon = style.icon;

  return (
    <li className="flex items-start gap-3 rounded-lg border border-border/60 bg-card p-4">
      <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${style.iconClass}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-foreground">{check.label}</h3>
          <span className={`shrink-0 rounded-full border px-2 py-0.5 text-xs ${style.chip}`}>
            {style.chipLabel}
          </span>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{check.detail}</p>
        <p className="mt-1.5 font-mono text-[11px] text-muted-foreground/70">
          gates {check.gates}
        </p>
        {check.fix && (
          <p className="mt-2 text-xs text-foreground">
            Fix:{' '}
            <code className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-amber-300">
              {check.fix}
            </code>
          </p>
        )}
      </div>
    </li>
  );
}

/**
 * Render the MCP connection readiness panel.
 *
 * @param props.readiness - Readiness computed by {@link computeMcpReadiness}.
 */
export function McpConnectionStatus({ readiness }: { readiness: McpReadiness }) {
  const connected = readiness.overall === 'ready';

  return (
    <div className="rounded-lg border border-border/60 bg-card/60 p-5">
      <div className="flex items-center gap-2">
        {connected ? (
          <CheckCircle2 className="h-5 w-5 text-green-400" aria-hidden="true" />
        ) : (
          <AlertCircle className="h-5 w-5 text-amber-400" aria-hidden="true" />
        )}
        <h3 className="text-sm font-semibold text-foreground">
          {connected ? 'Your MCP server is ready to serve tools' : 'Finish connecting your MCP server'}
        </h3>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {connected
          ? 'Once your agent spawns the snippet below, these tools are callable.'
          : 'The snippet below will not work until the action-needed item is resolved.'}
      </p>

      <ul className="mt-4 space-y-2">
        {readiness.checks.map((check) => (
          <CheckRow key={check.id} check={check} />
        ))}
      </ul>
    </div>
  );
}
