/**
 * Gemini Displayed Model Tracker
 *
 * Encapsulates the "currently displayed model in the Ink status bar" state
 * + the helper that mutates it (and pushes [MODEL:...] markers into the
 * message buffer for the UI to parse).
 *
 * WHY split out: the original `runGemini` had ~30 lines of declaration +
 * `updateDisplayedModel` closure + `getInitialGeminiModel` debug logging
 * tangled together. Pulling it out gives the orchestrator a clean
 * `tracker.get()` / `tracker.update(model, save)` API.
 */

import { logger } from '@/ui/logger';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import { GEMINI_MODEL_ENV } from '@/gemini/constants';
import {
  readGeminiLocalConfig,
  saveGeminiModelToConfig,
  getInitialGeminiModel,
} from '@/gemini/utils/config';

export interface DisplayedModelTracker {
  /** Read the current displayed model (may be undefined before first set). */
  get(): string | undefined;
  /**
   * Update the displayed model and (optionally) persist to local config.
   *
   * No-op when called with `undefined`. When called with the same value,
   * still logs but skips the [MODEL:...] marker (UI doesn't need refresh).
   *
   * @param model - New model name; passing `undefined` is a no-op.
   * @param saveToConfig - True for user-initiated changes; false for backend init.
   */
  update(model: string | undefined, saveToConfig?: boolean): void;
}

export interface CreateTrackerArgs {
  messageBuffer: MessageBuffer;
  /**
   * Read whether we have a TTY (closure so the tracker can be constructed
   * BEFORE Ink setup runs, which is when `hasTTY` becomes known).
   */
  getHasTTY: () => boolean;
}

/**
 * Create the displayed-model tracker initialised from env / local config.
 *
 * Side effect: emits a debug log of the resolved init values, matching the
 * pre-refactor behavior.
 */
export function createDisplayedModelTracker(args: CreateTrackerArgs): DisplayedModelTracker {
  const { messageBuffer, getHasTTY } = args;
  let displayedModel: string | undefined = getInitialGeminiModel();

  const localConfig = readGeminiLocalConfig();
  logger.debug(
    `[gemini] Initial model setup: env[GEMINI_MODEL_ENV]=${process.env[GEMINI_MODEL_ENV] || 'not set'}, ` +
    `localConfig=${localConfig.model || 'not set'}, displayedModel=${displayedModel}`,
  );

  return {
    get: () => displayedModel,
    update: (model: string | undefined, saveToConfig: boolean = false) => {
      if (model === undefined) {
        logger.debug('[gemini] updateDisplayedModel called with undefined, skipping update');
        return;
      }
      const oldModel = displayedModel;
      displayedModel = model;
      logger.debug(`[gemini] updateDisplayedModel called: oldModel=${oldModel}, newModel=${model}, saveToConfig=${saveToConfig}`);

      if (saveToConfig) {
        saveGeminiModelToConfig(model);
      }

      if (getHasTTY() && oldModel !== model) {
        // WHY: UI parses [MODEL:<name>] from system messages to populate
        // the status bar. We only emit when value actually changes.
        logger.debug(`[gemini] Adding model update message to buffer: [MODEL:${model}]`);
        messageBuffer.addMessage(`[MODEL:${model}]`, 'system');
      } else if (getHasTTY()) {
        logger.debug('[gemini] Model unchanged, skipping update message');
      }
    },
  };
}
