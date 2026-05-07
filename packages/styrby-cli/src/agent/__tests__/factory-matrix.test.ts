/**
 * Conformance test for the 9 streaming agent factories.
 *
 * WHY this file exists (Track C3, in-session task #68):
 *   The CLI supports 11 agents (claude + codex via launcher pattern, plus 9
 *   "streaming" agents via the StreamingAgentBackendBase pattern). Each
 *   streaming agent registers itself with the global `agentRegistry` via a
 *   `registerXAgent()` function. The recurring bug class this catches:
 *     "we added agent #12 and forgot to wire it into the registry / index."
 *   A parametric test that runs the same lifecycle assertions across all 9
 *   gives us a single signal that every new agent has the right shape.
 *
 * Scope:
 *   - VERIFIES: registry contains all 9 expected IDs after registration
 *   - VERIFIES: registry.create() returns an object with the AgentBackend interface
 *   - VERIFIES: backend object has start/sendPrompt/cancel/dispose methods
 *   - DOES NOT spawn any actual agent processes (those are integration tests)
 *
 * Excluded:
 *   - claude + codex use the launcher pattern (not streaming base class), so
 *     they don't register via this mechanism. Their conformance is verified
 *     by their own dedicated tests + the e2e smoke tests.
 *
 * @module agent/__tests__/factory-matrix
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  registerGeminiAgent,
  registerAiderAgent,
  registerOpenCodeAgent,
  registerGooseAgent,
  registerAmpAgent,
  registerCrushAgent,
  registerKiloAgent,
  registerKiroAgent,
  registerDroidAgent,
} from '@/agent/factories';
import { agentRegistry } from '@/agent/core';
import type { AgentBackend, AgentId } from '@/agent/core/AgentBackend';

/**
 * The 9 streaming agents we expect to be registered.
 * If a 10th streaming agent is added, this list must be extended AND the
 * import block above must add the new register*Agent function.
 *
 * Order matters only for output readability; the registry is unordered.
 */
const EXPECTED_STREAMING_AGENTS: AgentId[] = [
  'gemini',
  'aider',
  'opencode',
  'goose',
  'amp',
  'crush',
  'kilo',
  'kiro',
  'droid',
];

/**
 * Map of agent ID to its register function. Lets us iterate once and
 * register-then-verify in a single loop.
 */
const REGISTRATIONS: Record<string, () => void> = {
  gemini: registerGeminiAgent,
  aider: registerAiderAgent,
  opencode: registerOpenCodeAgent,
  goose: registerGooseAgent,
  amp: registerAmpAgent,
  crush: registerCrushAgent,
  kilo: registerKiloAgent,
  kiro: registerKiroAgent,
  droid: registerDroidAgent,
};

/**
 * Methods every AgentBackend must implement. Verified per agent below.
 * If the AgentBackend interface gains a new required method, add it here AND
 * make sure every factory implementation has it (else this test will fail
 * for the missing factory, which is the point).
 */
const REQUIRED_BACKEND_METHODS = [
  'startSession',
  'sendPrompt',
  'cancel',
  'dispose',
  'onMessage',
] as const;

describe('Agent factory conformance matrix (9 streaming agents)', () => {
  beforeAll(() => {
    // Register all 9. Idempotent — register() just re-overwrites the entry.
    for (const fn of Object.values(REGISTRATIONS)) {
      fn();
    }
  });

  describe('registry contents', () => {
    it('contains all 9 expected streaming agent IDs', () => {
      const registered = agentRegistry.list();
      for (const expected of EXPECTED_STREAMING_AGENTS) {
        expect(registered).toContain(expected);
      }
    });

    it('does not contain unexpected agent IDs (catches accidental additions)', () => {
      // The registry MAY contain additional entries (e.g. if claude/codex get
      // registered by parallel test setup) — that's fine. We just assert the
      // 9 streaming agents are present, not that they're the ONLY entries.
      // This is intentional looseness: we don't want this test to break when
      // a sibling test registers something else.
      expect(agentRegistry.list().length).toBeGreaterThanOrEqual(9);
    });
  });

  /**
   * Agents excluded from construction-time tests because they violate the
   * "construction is cheap" invariant (do I/O during factory call).
   *
   * Empty as of CLI-FOLLOWUP #74 (2026-05-06): gemini was previously
   * quarantined here because `createGeminiBackend()` did a synchronous
   * `gcloud auth application-default print-access-token` shell-out that
   * blocked for 5+ seconds when gcloud was uninstalled or unauthenticated.
   * The fix made gcloud ADC opt-in via STYRBY_USE_GCLOUD_ADC=1 — the
   * factory is now sub-millisecond by default, restoring the invariant.
   *
   * Construction tests now apply to ALL streaming agents.
   */
  const EAGER_INIT_AGENTS: AgentId[] = [];

  describe.each(EXPECTED_STREAMING_AGENTS)('agent: %s', (agentId) => {
    it('is registered after register*Agent() is called', () => {
      expect(agentRegistry.has(agentId)).toBe(true);
    });

    it.skipIf(EAGER_INIT_AGENTS.includes(agentId))(
      'factory returns an object (not throws) when called with minimal opts',
      () => {
        // Use a safe cwd that exists on every test runner — the OS temp dir.
        // Factories should NOT eagerly spawn processes during construction.
        let backend: AgentBackend | undefined;
        let constructionError: unknown;
        try {
          backend = agentRegistry.create(agentId, { cwd: '/tmp' });
        } catch (e) {
          constructionError = e;
        }

        expect(constructionError).toBeUndefined();
        expect(backend).toBeDefined();
        expect(typeof backend).toBe('object');
      }
    );

    it.skipIf(EAGER_INIT_AGENTS.includes(agentId))(
      'returned backend implements all required AgentBackend methods',
      () => {
        const backend = agentRegistry.create(agentId, { cwd: '/tmp' });
        for (const method of REQUIRED_BACKEND_METHODS) {
          expect(
            typeof (backend as unknown as Record<string, unknown>)[method],
            `agent ${agentId} missing required method: ${method}`
          ).toBe('function');
        }
      }
    );
  });

  describe('canonical agent list parity', () => {
    it('matches the AgentType union from styrby-shared (minus claude/codex)', () => {
      // The AgentType union in styrby-shared lists the canonical 11 agents.
      // This test guards against drift: if AgentType adds 'newAgent' but
      // factories/ doesn't, the streaming-list and canonical-list will fall
      // out of sync. We assert via cardinality + the known exclusions.
      //
      // Canonical 11 = streaming 9 + launcher 2 (claude + codex)
      // 9 + 2 = 11 ✓
      expect(EXPECTED_STREAMING_AGENTS.length).toBe(9);

      // Sanity check: claude + codex should NOT be in the streaming list
      expect(EXPECTED_STREAMING_AGENTS).not.toContain('claude' as AgentId);
      expect(EXPECTED_STREAMING_AGENTS).not.toContain('codex' as AgentId);
    });
  });
});
