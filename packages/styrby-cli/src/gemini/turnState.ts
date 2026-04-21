/**
 * Gemini Per-Turn Mutable State Container
 *
 * Encapsulates the cluster of `let` variables `runGemini` previously held
 * inline (accumulated response, response-in-progress flag, change-title
 * tracking, task_started dedup, etc) plus the `MessageHandlerState`
 * adapter the extracted message handler needs.
 *
 * WHY split out: 8 mutable locals + 11 getter/setter wiring lines is real
 * line count for zero domain logic. Extracting clarifies what "the per-turn
 * state" actually is and lets the orchestrator just call `state.resetForNewPrompt()`
 * instead of remembering 5 separate assignments.
 */

import type { MessageHandlerState } from '@/gemini/messageHandler';

export interface GeminiTurnState {
  /** Accessors for the message handler. */
  handlerState: MessageHandlerState;
  /** True while the agent is running (drives keep-alive + ready emission). */
  thinking(): boolean;
  setThinking(v: boolean): void;
  /** Read whether a streaming response is currently being built. */
  isResponseInProgress(): boolean;
  /** Read accumulated response text for end-of-turn flush. */
  accumulatedResponse(): string;
  /** Reset accumulator + per-turn flags before a new sendPrompt. */
  resetForNewPrompt(): void;
  /** Reset all turn-completion flags after finalize. */
  resetAfterTurn(): void;
  /** Clear accumulated response after final-message dispatch. */
  clearAccumulatedAfterFlush(): void;
}

/**
 * Create a fresh per-turn state container for a single `runGemini` invocation.
 */
export function createGeminiTurnState(): GeminiTurnState {
  let thinking = false;
  let accumulatedResponse = '';
  let isResponseInProgress = false;
  let currentResponseMessageId: string | null = null;
  let hadToolCallInTurn = false;
  let changeTitleCompleted = false;
  let taskStartedSent = false;

  const handlerState: MessageHandlerState = {
    getThinking: () => thinking,
    setThinking: (v) => { thinking = v; },
    getAccumulatedResponse: () => accumulatedResponse,
    setAccumulatedResponse: (v) => { accumulatedResponse = v; },
    getIsResponseInProgress: () => isResponseInProgress,
    setIsResponseInProgress: (v) => { isResponseInProgress = v; },
    setCurrentResponseMessageId: (v) => { currentResponseMessageId = v; },
    setHadToolCallInTurn: (v) => { hadToolCallInTurn = v; },
    setChangeTitleCompleted: (v) => { changeTitleCompleted = v; },
    getTaskStartedSent: () => taskStartedSent,
    setTaskStartedSent: (v) => { taskStartedSent = v; },
  };

  return {
    handlerState,
    thinking: () => thinking,
    setThinking: (v) => { thinking = v; },
    isResponseInProgress: () => isResponseInProgress,
    accumulatedResponse: () => accumulatedResponse,
    resetForNewPrompt: () => {
      // WHY: Reset accumulator state for new prompt — ensures a NEW assistant
      // message is started (rather than appending to previous).
      accumulatedResponse = '';
      isResponseInProgress = false;
      hadToolCallInTurn = false;
      taskStartedSent = false;
      changeTitleCompleted = false;
    },
    resetAfterTurn: () => {
      hadToolCallInTurn = false;
      changeTitleCompleted = false;
      taskStartedSent = false;
      thinking = false;
    },
    clearAccumulatedAfterFlush: () => {
      accumulatedResponse = '';
      isResponseInProgress = false;
    },
  };
}
