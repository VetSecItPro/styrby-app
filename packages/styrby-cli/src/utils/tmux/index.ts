/**
 * Barrel export for the tmux utility module.
 *
 * WHY: Consolidates the public surface so `import { ... } from '@/utils/tmux'`
 * keeps working unchanged after the 1,050-LOC monolith was split into focused
 * sibling modules (types, identifiers, environment, command, spawnEnv,
 * utilities, session, constants).
 */

export * from './types';
export * from './identifiers';
export * from './environment';
export * from './utilities';
export * from './session';
export { spawnInTmuxStandalone, type TmuxSpawnResult } from './spawn';
