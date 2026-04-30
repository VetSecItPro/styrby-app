/**
 * CLI version constant.
 *
 * WHY its own module: both `index.ts` (entry point) and `cli/helpScreen.ts`
 * need this value, and extracting it avoids a circular dependency between
 * those modules.
 *
 * Keep this in sync with `package.json` -> `version`. The build step does
 * not inject it automatically.
 *
 * @module cli/version
 */

/**
 * Semantic version of the Styrby CLI.
 */
export const VERSION = '0.2.0-beta.1';
