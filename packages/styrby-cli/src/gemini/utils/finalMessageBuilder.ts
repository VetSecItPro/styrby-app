/**
 * Gemini Final-Turn Message Builder
 *
 * Pure helper that takes the accumulated assistant response collected over
 * a full turn and produces the `CodexMessagePayload` we send to mobile,
 * including parsed `<options>` (a Happy/Codex convention used to render
 * tappable choice buttons in the mobile UI).
 *
 * WHY split out: the original `runGemini.ts` finally block built this
 * payload inline alongside session side effects (history recording, push
 * sending). Pulling the construction into a pure builder lets us assert on
 * the EXACT shape of the payload — which is the contract with the mobile
 * app — without spinning up a real session.
 */

import { randomUUID } from 'node:crypto';
import {
  parseOptionsFromText,
  hasIncompleteOptions,
  formatOptionsXml,
} from '@/gemini/utils/optionsParser';
import type { CodexMessagePayload } from '@/gemini/types';

export interface BuiltFinalMessage {
  /** The full payload to forward to mobile via `sendAgentMessage`. */
  payload: CodexMessagePayload;
  /** Plain-text portion (no options XML), recorded into ConversationHistory. */
  historyText: string;
  /** Parsed options (empty if none). Exposed for callers that want to log. */
  options: string[];
  /** True if accumulator had a `<options>` opener but no closer (warn-worthy). */
  incompleteOptions: boolean;
}

/**
 * Build the final per-turn assistant message payload from the accumulated
 * Gemini response text.
 *
 * @param accumulatedResponse - The full text streamed for this turn.
 * @param idGenerator - Optional ID generator (DI for tests). Defaults to
 *   `node:crypto.randomUUID`.
 * @returns A built payload, or `null` if the accumulated text is whitespace-
 *   only (caller should skip sending — matches original `.trim()` guard).
 */
export function buildFinalTurnMessage(
  accumulatedResponse: string,
  idGenerator: () => string = randomUUID
): BuiltFinalMessage | null {
  if (!accumulatedResponse.trim()) {
    return null;
  }

  const { text: messageText, options } = parseOptionsFromText(accumulatedResponse);

  let finalMessageText = messageText;
  if (options.length > 0) {
    // WHY: Mobile app's `parseMarkdown` expects options re-serialized as an
    // <options> XML block appended to the message body. We strip-then-reattach
    // so any extra whitespace inside the original block is normalized.
    finalMessageText = messageText + formatOptionsXml(options);
  }

  const incompleteOptions =
    options.length === 0 && hasIncompleteOptions(accumulatedResponse);

  const payload: CodexMessagePayload = {
    type: 'message',
    message: finalMessageText,
    id: idGenerator(),
    ...(options.length > 0 && { options }),
  };

  return {
    payload,
    historyText: messageText,
    options,
    incompleteOptions,
  };
}
