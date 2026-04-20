import type { QueryOptions } from '@/claude/sdk';
import type { PermissionMode } from '@/api/types';

/** Derived from SDK's QueryOptions - the modes Claude actually supports */
export type ClaudeSdkPermissionMode = NonNullable<QueryOptions['permissionMode']>;

/**
 * Maps any Styrby `PermissionMode` (7 modes) to the subset supported by the
 * Claude SDK (4 modes: `default`, `acceptEdits`, `bypassPermissions`, `plan`).
 *
 * WHY: Styrby supports additional permission modes inherited from Codex
 * (`yolo`, `safe-yolo`, `read-only`) that have no direct Claude equivalent.
 * This function is the **single authoritative translation point** so that
 * mapping logic is never duplicated in agent dispatch code or UI layer.
 *
 * Mapping table:
 * | Styrby mode         | Claude SDK mode     | Rationale                              |
 * |---------------------|---------------------|----------------------------------------|
 * | `yolo`              | `bypassPermissions` | Both skip all permission prompts       |
 * | `safe-yolo`         | `default`           | Ask-for-permissions is the safe analog |
 * | `read-only`         | `default`           | Claude has no read-only concept        |
 * | `default`           | `default`           | Pass-through                           |
 * | `acceptEdits`       | `acceptEdits`       | Pass-through                           |
 * | `bypassPermissions` | `bypassPermissions` | Pass-through                           |
 * | `plan`              | `plan`              | Pass-through                           |
 *
 * @param mode - The Styrby permission mode string (from `PermissionMode`).
 * @returns The corresponding `ClaudeSdkPermissionMode` value accepted by the
 *   Claude SDK's `QueryOptions.permissionMode` field.
 *
 * @example
 * const claudeMode = mapToClaudeMode('yolo');
 * // claudeMode === 'bypassPermissions'
 *
 * const passThrough = mapToClaudeMode('acceptEdits');
 * // passThrough === 'acceptEdits'
 */
export function mapToClaudeMode(mode: PermissionMode): ClaudeSdkPermissionMode {
    const codexToClaudeMap: Record<string, ClaudeSdkPermissionMode> = {
        'yolo': 'bypassPermissions',
        'safe-yolo': 'default',
        'read-only': 'default',
    };
    return codexToClaudeMap[mode] ?? (mode as ClaudeSdkPermissionMode);
}
