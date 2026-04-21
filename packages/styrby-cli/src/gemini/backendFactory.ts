/**
 * Gemini Backend Creation Helper
 *
 * Tiny wrapper that consolidates the duplicated `createGeminiBackend`
 * invocation used in both the "first message" and "mode-changed" branches
 * of `runGemini`'s main loop.
 *
 * WHY split out: the args object was identical in both call sites except
 * for the `model` value, and both sites had the same odd `undefined vs
 * null` mapping rule with a multiline WHY comment. DRYing this up keeps
 * the rule documented in exactly one place.
 */

import { createGeminiBackend } from '@/agent/factories/gemini';
import type { GeminiPermissionHandler } from '@/gemini/utils/permissionHandler';

export interface CreateBackendArgs {
  mcpServers: Record<string, { command: string; args: string[] }>;
  permissionHandler: GeminiPermissionHandler;
  cloudToken?: string;
  currentUserEmail?: string;
  /**
   * Per-message model override.
   *   - `undefined` => key not present in user-message meta; backend will
   *     fall back to local config / env / default.
   *   - explicit `null` => user explicitly reset model; backend should skip
   *     local config and use env / default only.
   *   - string => use this model.
   */
  messageModel: string | null | undefined;
}

/**
 * Translate the `messageModel` semantics into the `model` arg expected by
 * `createGeminiBackend`, and return the factory result unchanged.
 */
export function createBackendForMessage(args: CreateBackendArgs) {
  const { mcpServers, permissionHandler, cloudToken, currentUserEmail, messageModel } = args;
  // WHY: `undefined` -> pass undefined; otherwise coerce empty/null -> null
  // so the factory knows "explicitly reset, skip local config".
  const model = messageModel === undefined ? undefined : (messageModel || null);
  return createGeminiBackend({
    cwd: process.cwd(),
    mcpServers,
    permissionHandler,
    cloudToken,
    currentUserEmail,
    model,
  });
}
