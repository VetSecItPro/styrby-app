/**
 * Gemini Prompt Builder
 *
 * Pure helpers for constructing the prompt text we send to Gemini per turn.
 *
 * Two concerns split out from `runGemini.ts`:
 *   1. First-message system-prompt injection (Codex-parity formatting)
 *   2. Detection of pending `change_title` instructions
 *
 * WHY: Both are pure string transforms with subtle ordering rules
 * (system prompt BEFORE the user message, change_title instruction AFTER
 * the user message — matching Codex behavior exactly). Bugs in either
 * silently break mobile UX, so they deserve unit tests.
 */

import { CHANGE_TITLE_INSTRUCTION } from '@/gemini/constants';

export interface BuildFirstPromptArgs {
  /** The original text the user typed. */
  userMessage: string;
  /** Optional system-prompt prefix (from `meta.appendSystemPrompt`). */
  appendSystemPrompt?: string;
}

/**
 * Build the prompt for the FIRST message of a Gemini session.
 *
 * Format (matches Codex exactly):
 *   <system prompt>\n\n<user message>\n\n<CHANGE_TITLE_INSTRUCTION>
 *
 * If no system prompt is provided, returns the user message unchanged.
 *
 * @param args - User message and optional system prompt.
 */
export function buildFirstMessagePrompt(args: BuildFirstPromptArgs): string {
  const { userMessage, appendSystemPrompt } = args;
  if (!appendSystemPrompt) return userMessage;
  return `${appendSystemPrompt}\n\n${userMessage}\n\n${CHANGE_TITLE_INSTRUCTION}`;
}

/**
 * Detect whether a prompt being sent contains the `change_title` instruction
 * (either the bare tool name or the MCP-prefixed `happy__change_title`).
 *
 * Used by the main loop so the turn-completion handler can wait for title
 * change to finish before emitting `task_complete`.
 *
 * @param prompt - The full prompt string being sent to Gemini.
 */
export function promptContainsChangeTitle(prompt: string): boolean {
  return (
    prompt.includes('change_title') || prompt.includes('happy__change_title')
  );
}
