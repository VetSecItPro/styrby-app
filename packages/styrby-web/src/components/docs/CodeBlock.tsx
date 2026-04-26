import { codeToHtml } from "shiki";
import { CopyButton } from "./CopyButton";

/**
 * Supported Shiki language identifiers used across Styrby docs.
 *
 * WHY: this whitelist keeps Shiki's bundled grammar list small at build time
 * and makes prop misuse a TypeScript error rather than a runtime warning.
 */
export type CodeBlockLang =
  | "bash"
  | "shell"
  | "json"
  | "typescript"
  | "tsx"
  | "ts"
  | "javascript"
  | "js"
  | "yaml"
  | "sql"
  | "diff"
  | "text";

/**
 * Server-rendered, syntax-highlighted code block.
 *
 * Uses Shiki's `codeToHtml` at render time to produce semantic HTML with
 * inline color tokens. Shiki escapes the input, so the resulting markup is
 * safe to inject via `dangerouslySetInnerHTML`. Ships zero JS at runtime
 * for the highlighting itself; only the small `CopyButton` is hydrated.
 *
 * @param lang - Shiki language identifier (see {@link CodeBlockLang})
 * @param code - The exact source string to render. Preserve original
 *   whitespace and indentation; Shiki does not reformat.
 * @returns A pre-styled `<div>` containing the highlighted block plus a
 *   floating copy-to-clipboard button.
 *
 * @example
 * <CodeBlock lang="json" code={`{"event":"session.started"}`} />
 */
export async function CodeBlock({
  lang,
  code,
}: {
  lang: CodeBlockLang;
  code: string;
}) {
  // WHY: `min-dark` is a low-saturation VS Code theme that matches the
  // Industrial Dark surface palette in globals.css far better than the
  // higher-contrast `dark-plus`. Keep Wave 2 visually consistent with the
  // surrounding `bg-card` panels.
  const html = await codeToHtml(code, {
    lang,
    theme: "min-dark",
  });

  return (
    <div className="group relative my-4">
      <CopyButton text={code} />
      <div
        className="overflow-x-auto rounded-lg bg-card p-4 text-sm font-mono ring-1 ring-border [&_pre]:!bg-transparent [&_pre]:!p-0"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
