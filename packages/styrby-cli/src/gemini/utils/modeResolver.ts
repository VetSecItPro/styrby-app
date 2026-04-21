/**
 * Gemini Per-Message Mode Resolver
 *
 * Pure helpers that take an incoming user message's `meta` and the current
 * session-wide overrides, and return the resolved permission mode + model
 * for THIS message — plus what the new session-wide overrides should be
 * after this message is consumed.
 *
 * WHY split out: the original `onUserMessage` handler in `runGemini.ts`
 * mixed business logic (which mode/model to use) with side effects (UI
 * updates, debug logs, queue pushes). Pulling the pure decision into a
 * helper makes it unit-testable AND lets the side-effecting handler stay
 * thin.
 */

import type { PermissionMode } from '@/api/types';

const VALID_PERMISSION_MODES: PermissionMode[] = [
  'default',
  'read-only',
  'safe-yolo',
  'yolo',
];

export interface IncomingMessageMeta {
  permissionMode?: string;
  /** Use `null` to explicitly reset to default; `undefined` to inherit. */
  model?: string | null;
}

export interface ResolvedPermission {
  /** Permission mode to apply to THIS message. */
  forMessage: PermissionMode;
  /** New session-wide override. */
  newCurrent: PermissionMode;
  /**
   * True if the override changed (caller should refresh permission handler
   * and emit a debug log).
   */
  didChange: boolean;
  /**
   * True if the meta carried a value but it failed validation (caller
   * should log a warning).
   */
  invalid: boolean;
}

/**
 * Resolve which permission mode to use for an incoming user message.
 *
 * Mirrors the pre-refactor logic exactly:
 *   - If meta has a valid mode -> use it AND update the session-wide override
 *   - If meta has an invalid mode -> keep current, signal `invalid: true`
 *   - If meta omits the field -> use current
 *   - If current is undefined -> default to 'default'
 *
 * @param meta - The optional `meta` field from the incoming user message.
 * @param current - The session-wide override before this message (or undefined
 *   if none has been set yet).
 */
export function resolvePermissionMode(
  meta: IncomingMessageMeta | undefined,
  current: PermissionMode | undefined
): ResolvedPermission {
  if (meta?.permissionMode) {
    if (VALID_PERMISSION_MODES.includes(meta.permissionMode as PermissionMode)) {
      const next = meta.permissionMode as PermissionMode;
      return {
        forMessage: next,
        newCurrent: next,
        didChange: true,
        invalid: false,
      };
    }
    // Invalid -> don't update; fall through to default-init below
    const fallback: PermissionMode = current ?? 'default';
    return {
      forMessage: fallback,
      newCurrent: fallback,
      didChange: current === undefined,
      invalid: true,
    };
  }

  // No override in this message
  if (current === undefined) {
    // WHY: First message ever — initialize to 'default'.
    return {
      forMessage: 'default',
      newCurrent: 'default',
      didChange: true,
      invalid: false,
    };
  }
  return {
    forMessage: current,
    newCurrent: current,
    didChange: false,
    invalid: false,
  };
}

export type ModelResolutionAction =
  /** Meta omitted `model` field entirely — keep current. */
  | { kind: 'keep'; forMessage: string | undefined; newCurrent: string | undefined }
  /** Meta sent `model: null` — reset session override but DON'T touch UI. */
  | { kind: 'reset'; forMessage: undefined; newCurrent: undefined }
  /** Meta sent a string AND it differs from current — apply + persist + UI. */
  | { kind: 'change'; forMessage: string; newCurrent: string; previous: string | undefined }
  /** Meta sent the same string we already have — no-op. */
  | { kind: 'noop'; forMessage: string; newCurrent: string };

/**
 * Resolve which model to use for an incoming user message.
 *
 * Returns a discriminated action so the side-effecting caller knows whether
 * to update the UI / save to local config / show a "Model changed" banner.
 *
 * @param meta - The optional `meta` field from the incoming user message.
 * @param current - The session-wide override before this message.
 */
export function resolveModel(
  meta: IncomingMessageMeta | undefined,
  current: string | undefined
): ModelResolutionAction {
  // Use `in`-check (matches original `hasOwnProperty`) - the 'model' key
  // being PRESENT is meaningful, even when its value is undefined/null.
  if (!meta || !('model' in meta)) {
    return { kind: 'keep', forMessage: current, newCurrent: current };
  }

  if (meta.model === null) {
    return { kind: 'reset', forMessage: undefined, newCurrent: undefined };
  }

  if (typeof meta.model === 'string' && meta.model.length > 0) {
    if (current === meta.model) {
      return { kind: 'noop', forMessage: meta.model, newCurrent: meta.model };
    }
    return {
      kind: 'change',
      forMessage: meta.model,
      newCurrent: meta.model,
      previous: current,
    };
  }

  // meta.model === undefined (key present but value undefined) — keep current
  return { kind: 'keep', forMessage: current, newCurrent: current };
}
