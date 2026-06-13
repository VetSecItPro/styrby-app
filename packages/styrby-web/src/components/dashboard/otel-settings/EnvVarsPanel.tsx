/**
 * EnvVarsPanel — generated env-vars preview with a copy button.
 *
 * Extracted from otel-settings.tsx (Cluster A2 split).
 *
 * @module components/dashboard/otel-settings/EnvVarsPanel
 */

/** Props for the env-vars preview panel. */
export interface EnvVarsPanelProps {
  /** The generated env-var block to display + copy. */
  envVars: string;
  /** Whether the "Copied!" confirmation is showing. */
  copied: boolean;
  /** Copy-to-clipboard handler. */
  onCopy: () => void;
}

/**
 * Render the generated environment variables with a copy control.
 *
 * @param props - Panel props.
 */
export function EnvVarsPanel({ envVars, copied, onCopy }: EnvVarsPanelProps) {
  return (
    <div className="rounded-lg border border-border/40 bg-zinc-950 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/40">
        <div>
          <p className="text-xs font-semibold text-foreground">Environment Variables</p>
          <p className="text-[11px] text-muted-foreground">
            Add these to your <code className="text-amber-400">~/.zshrc</code> or{' '}
            <code className="text-amber-400">.env</code> file on each machine.
          </p>
        </div>
        <button
          type="button"
          onClick={onCopy}
          className="rounded-md border border-border/60 px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:border-border transition-colors"
          aria-label="Copy environment variables to clipboard"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre className="px-4 py-3 text-[11px] text-emerald-400 font-mono overflow-x-auto whitespace-pre leading-relaxed">
        {envVars}
      </pre>
    </div>
  );
}
