/**
 * Gemini Ink TTY Setup
 *
 * Wraps the Ink/React UI mount used by `runGemini`. Handles:
 *   - Detecting whether we have a TTY
 *   - Switching stdin to raw mode for keyboard input
 *   - Mounting the `GeminiDisplay` React tree with a closure-driven model getter
 *   - Pushing the initial model marker into the message buffer
 *
 * WHY split out: ~80 lines of side-effecting UI setup that has nothing to
 * do with the agent loop. Extracting keeps `runGemini.ts` focused on the
 * loop. Returns the unmount handle + tty flag so the caller can clean up.
 */

import React from 'react';
import { render } from 'ink';
import { logger } from '@/ui/logger';
import { GeminiDisplay } from '@/ui/ink/GeminiDisplay';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';

export interface InkSetupArgs {
  messageBuffer: MessageBuffer;
  /** Read the latest displayed model on each render (closure getter). */
  getDisplayedModel: () => string | undefined;
  /** Called when the user hits Ctrl-C. */
  onExit: () => void | Promise<void>;
}

export interface InkSetupResult {
  hasTTY: boolean;
  inkInstance: ReturnType<typeof render> | null;
}

/**
 * Mount the Gemini Ink UI (only if we have a TTY) and configure stdin for
 * raw keyboard input.
 *
 * Side effects:
 *   - `console.clear()` when TTY present (matches pre-refactor behavior)
 *   - Pushes `[MODEL:<name>]` marker into messageBuffer so the status bar
 *     populates immediately
 *   - Switches process.stdin to raw mode
 */
export function setupGeminiInkUI(args: InkSetupArgs): InkSetupResult {
  const { messageBuffer, getDisplayedModel, onExit } = args;
  const hasTTY = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  let inkInstance: ReturnType<typeof render> | null = null;

  if (hasTTY) {
    console.clear();

    // WHY: Function component that re-reads `displayedModel` from the closure
    // on every render. This way Ink picks up model changes without prop
    // wiring — the parent `runGemini` mutates the variable directly.
    const DisplayComponent = () => {
      const currentModelValue = getDisplayedModel() || 'gemini-2.5-pro';
      return React.createElement(GeminiDisplay, {
        messageBuffer,
        logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
        currentModel: currentModelValue,
        onExit: async () => {
          logger.debug('[gemini]: Exiting agent via Ctrl-C');
          await onExit();
        },
      });
    };

    inkInstance = render(React.createElement(DisplayComponent), {
      exitOnCtrlC: false,
      patchConsole: false,
    });

    const initialModelName = getDisplayedModel() || 'gemini-2.5-pro';
    logger.debug(`[gemini] Sending initial model to UI: ${initialModelName}`);
    messageBuffer.addMessage(`[MODEL:${initialModelName}]`, 'system');

    process.stdin.resume();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.setEncoding('utf8');
  }

  return { hasTTY, inkInstance };
}

/**
 * Tear down the Ink UI: restore stdin, unmount React, clear buffer.
 *
 * Safe to call even if `setupGeminiInkUI` was a no-op (no TTY).
 */
export function teardownGeminiInkUI(args: {
  hasTTY: boolean;
  inkInstance: ReturnType<typeof render> | null;
  messageBuffer: MessageBuffer;
}): void {
  const { hasTTY, inkInstance, messageBuffer } = args;
  if (process.stdin.isTTY) {
    try { process.stdin.setRawMode(false); } catch { /* ignore */ }
  }
  if (hasTTY) {
    try { process.stdin.pause(); } catch { /* ignore */ }
  }
  if (inkInstance) {
    inkInstance.unmount();
  }
  messageBuffer.clear();
}
