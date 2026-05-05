/**
 * CLI version constant.
 *
 * WHY its own module: both `index.ts` (entry point) and `cli/helpScreen.ts`
 * need this value, and extracting it avoids a circular dependency between
 * those modules.
 *
 * WHY runtime require from package.json (ESC-3 hardening): Previously this
 * file hand-mirrored the version literal from package.json. Every release
 * required updating two places, and the constant routinely drifted. Now we
 * import the package manifest directly; esbuild inlines the JSON at build
 * time (resolveJsonModule + bundler resolution), and tsx/vitest read it
 * straight from disk in development. Single source of truth, drift-proof.
 *
 * @module cli/version
 */

// WHY relative path: the path alias resolver in our esbuild config only
// remaps `@/...`. Reaching the package manifest two levels up uses a plain
// relative import. The build step's `files` field already includes
// dist/**/*.json so the manifest ships with the published bundle even
// though the bundle inlines the version literal.
import pkg from '../../package.json' with { type: 'json' };

/**
 * Semantic version of the Styrby CLI.
 *
 * Sourced at module-load time from package.json so the CLI version surface
 * is permanently in sync with the published artifact's manifest.
 */
export const VERSION: string = pkg.version;
