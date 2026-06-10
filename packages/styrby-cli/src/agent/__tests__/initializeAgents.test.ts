/**
 * Regression test for initializeAgents().
 *
 * WHY this exists (2026-06-10, found by live verification): the previous
 * implementation registered agents via bare `require('./factories/...')` inside
 * try/catch. This package is ESM ("type": "module"), where `require` is
 * undefined — so under the real CLI runtime EVERY require() threw and was
 * silently swallowed, leaving the registry empty ("Registered agents: none
 * registered"). No managed agent worked at runtime. The unit suites missed it
 * because they call `registerXAgent()` directly, never `initializeAgents()`.
 *
 * This test calls the REAL initializeAgents() (no mocks) so the dynamic-import
 * registration path is exercised end-to-end: if it regresses to a broken import
 * mechanism, the registry comes back empty and this fails.
 *
 * @module agent/__tests__/initializeAgents
 */

import { describe, it, expect } from 'vitest';
import { initializeAgents } from '../index';
import { agentRegistry } from '../core';
import type { AgentId } from '../core/AgentBackend';

/** The canonical 11 agents that must all register. */
const ALL_AGENTS: AgentId[] = [
  'claude',
  'codex',
  'gemini',
  'opencode',
  'aider',
  'goose',
  'amp',
  'crush',
  'kilo',
  'kiro',
  'droid',
];

describe('initializeAgents (real registration, no mocks)', () => {
  it('registers all 11 agents via the dynamic-import path', async () => {
    await initializeAgents();
    const registered = agentRegistry.list();
    for (const id of ALL_AGENTS) {
      expect(registered, `agent "${id}" should be registered`).toContain(id);
    }
  });

  it('every registered agent can be constructed into a backend', async () => {
    await initializeAgents();
    for (const id of ALL_AGENTS) {
      const backend = agentRegistry.create(id, { cwd: '/tmp' });
      expect(backend, `agent "${id}" should construct`).toBeDefined();
      expect(typeof backend.startSession).toBe('function');
      expect(typeof backend.sendPrompt).toBe('function');
    }
  });

  it('is idempotent — a second call does not throw', async () => {
    await initializeAgents();
    await expect(initializeAgents()).resolves.toBeUndefined();
  });
});
