/**
 * Tmux utilities - thin barrel re-export.
 *
 * WHY: The original 1,050-LOC monolith was split into focused sub-modules
 * under `./tmux/` per the Component-First Architecture rule (each file < 400
 * LOC, single responsibility). This file preserves the public import path
 * `@/utils/tmux` so every existing caller works unchanged.
 *
 * See `./tmux/index.ts` for the underlying re-exports and `./tmux/*.ts` for
 * the focused sub-modules:
 *   - types.ts        - shared interfaces, enums, error class
 *   - constants.ts    - WIN_OPS, COMMANDS_SUPPORTING_TARGET, CONTROL_SEQUENCES
 *   - identifiers.ts  - parse / format / validate / build session identifiers
 *   - environment.ts  - parse the TMUX env var
 *   - command.ts      - subprocess + argv builder
 *   - spawnEnv.ts     - shell-safe env var flag construction
 *   - utilities.ts    - the TmuxUtilities runtime class
 *   - session.ts      - createTmuxSession, isTmuxAvailable, getTmuxUtilities
 *
 * Adapted from a Python reference, Apache 2.0 (c) 2025 Andrew Hundt.
 */

export * from './tmux/index';
