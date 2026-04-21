/**
 * Tests for agent/core/AgentRegistry.ts
 *
 * Covers:
 * - register: stores a factory by agent ID
 * - has: returns true for registered IDs, false otherwise
 * - list: returns all registered IDs
 * - create: invokes the factory with the supplied options and returns backend
 * - create: throws a descriptive error for unknown agent IDs
 * - agentRegistry: global singleton exported from the module
 *
 * WHY: AgentRegistry is the single dispatch point that maps "gemini" → backend
 * factory at runtime. Bugs here break all agent creation in the mobile app.
 *
 * @module agent/core/__tests__/AgentRegistry
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AgentRegistry } from '../AgentRegistry';
import type { AgentBackend } from '../AgentBackend';
import type { AgentFactoryOptions } from '../AgentRegistry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal stub AgentBackend for assertion purposes.
 * The concrete implementation doesn't matter — we only verify the factory
 * returns what it was given.
 */
function makeBackend(): AgentBackend {
  return {
    startSession: async () => ({ sessionId: 'test' }),
    sendPrompt: async () => {},
    cancel: async () => {},
    onMessage: () => {},
    offMessage: () => {},
    dispose: async () => {},
  } as unknown as AgentBackend;
}

// ===========================================================================
// AgentRegistry — instance methods
// ===========================================================================

describe('AgentRegistry', () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    // Fresh registry per test so registrations don't leak between cases.
    registry = new AgentRegistry();
  });

  describe('register + has', () => {
    it('registers an agent and has() returns true', () => {
      const backend = makeBackend();
      registry.register('aider', () => backend);

      expect(registry.has('aider')).toBe(true);
    });

    it('has() returns false for an unregistered agent', () => {
      expect(registry.has('unknown-agent')).toBe(false);
    });

    it('overwrites an existing registration when called twice with the same ID', () => {
      const first = makeBackend();
      const second = makeBackend();
      registry.register('amp', () => first);
      registry.register('amp', () => second);

      const created = registry.create('amp', { cwd: '/tmp' });
      expect(created).toBe(second);
    });
  });

  describe('list', () => {
    it('returns an empty array when no agents are registered', () => {
      expect(registry.list()).toEqual([]);
    });

    it('returns all registered agent IDs', () => {
      registry.register('aider', makeBackend);
      registry.register('goose', makeBackend);

      const ids = registry.list();
      expect(ids).toContain('aider');
      expect(ids).toContain('goose');
      expect(ids).toHaveLength(2);
    });
  });

  describe('create', () => {
    it('invokes the factory with the supplied options', () => {
      const backend = makeBackend();
      let capturedOpts: AgentFactoryOptions | undefined;
      registry.register('kilo', (opts) => {
        capturedOpts = opts;
        return backend;
      });

      const opts: AgentFactoryOptions = { cwd: '/my/project', env: { KEY: 'val' } };
      registry.create('kilo', opts);

      expect(capturedOpts).toEqual(opts);
    });

    it('returns the backend returned by the factory', () => {
      const backend = makeBackend();
      registry.register('kiro', () => backend);

      const result = registry.create('kiro', { cwd: '/tmp' });
      expect(result).toBe(backend);
    });

    it('throws a descriptive error for an unknown agent ID', () => {
      expect(() => registry.create('mystery', { cwd: '/tmp' })).toThrow(
        /Unknown agent: mystery/,
      );
    });

    it('includes available agent IDs in the error message', () => {
      registry.register('crush', makeBackend);

      let thrown: Error | undefined;
      try {
        registry.create('missing', { cwd: '/tmp' });
      } catch (e) {
        thrown = e as Error;
      }

      expect(thrown?.message).toContain('crush');
    });

    it('mentions "none" when no agents are registered', () => {
      expect(() => registry.create('x', { cwd: '/tmp' })).toThrow(/none/);
    });
  });
});
