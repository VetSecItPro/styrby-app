/**
 * Tests for `createGeminiTurnState`.
 *
 * The state container exposes its mutable interior through getter/setter
 * pairs on `handlerState` plus three reset helpers — those resets are
 * timing-critical (called between every prompt and turn) so we pin them.
 */
import { describe, it, expect } from 'vitest';
import { createGeminiTurnState } from '@/gemini/turnState';

describe('createGeminiTurnState', () => {
  it('initializes with all flags false / empty', () => {
    const s = createGeminiTurnState();
    expect(s.thinking()).toBe(false);
    expect(s.isResponseInProgress()).toBe(false);
    expect(s.accumulatedResponse()).toBe('');
    expect(s.handlerState.getTaskStartedSent()).toBe(false);
  });

  it('handlerState getters and setters round-trip', () => {
    const s = createGeminiTurnState();
    s.handlerState.setThinking(true);
    expect(s.thinking()).toBe(true);
    expect(s.handlerState.getThinking()).toBe(true);

    s.handlerState.setAccumulatedResponse('hello');
    expect(s.accumulatedResponse()).toBe('hello');
    expect(s.handlerState.getAccumulatedResponse()).toBe('hello');

    s.handlerState.setIsResponseInProgress(true);
    expect(s.isResponseInProgress()).toBe(true);

    s.handlerState.setTaskStartedSent(true);
    expect(s.handlerState.getTaskStartedSent()).toBe(true);
  });

  it('resetForNewPrompt clears accumulator + per-turn flags but NOT thinking', () => {
    const s = createGeminiTurnState();
    s.handlerState.setAccumulatedResponse('partial');
    s.handlerState.setIsResponseInProgress(true);
    s.handlerState.setTaskStartedSent(true);
    s.handlerState.setThinking(true);

    s.resetForNewPrompt();

    expect(s.accumulatedResponse()).toBe('');
    expect(s.isResponseInProgress()).toBe(false);
    expect(s.handlerState.getTaskStartedSent()).toBe(false);
    // WHY: thinking is cleared in resetAfterTurn, NOT resetForNewPrompt.
    expect(s.thinking()).toBe(true);
  });

  it('resetAfterTurn clears thinking + tracking flags', () => {
    const s = createGeminiTurnState();
    s.handlerState.setThinking(true);
    s.handlerState.setTaskStartedSent(true);

    s.resetAfterTurn();

    expect(s.thinking()).toBe(false);
    expect(s.handlerState.getTaskStartedSent()).toBe(false);
  });

  it('clearAccumulatedAfterFlush clears accumulator + isResponseInProgress only', () => {
    const s = createGeminiTurnState();
    s.handlerState.setAccumulatedResponse('done');
    s.handlerState.setIsResponseInProgress(true);
    s.handlerState.setThinking(true);

    s.clearAccumulatedAfterFlush();

    expect(s.accumulatedResponse()).toBe('');
    expect(s.isResponseInProgress()).toBe(false);
    expect(s.thinking()).toBe(true); // unchanged
  });

  it('multiple instances do not share state', () => {
    const a = createGeminiTurnState();
    const b = createGeminiTurnState();
    a.handlerState.setAccumulatedResponse('A');
    b.handlerState.setAccumulatedResponse('B');
    expect(a.accumulatedResponse()).toBe('A');
    expect(b.accumulatedResponse()).toBe('B');
  });
});
