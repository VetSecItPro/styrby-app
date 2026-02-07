/**
 * Tests for cost utilities module
 *
 * @module lib/__tests__/costs.test
 */

import { describe, it, expect } from 'vitest';
import { formatCost, formatTokens, getAgentColor } from '../costs';
import type { AgentType } from '../costs';

describe('formatCost', () => {
  describe('default 2 decimal places', () => {
    it('formats positive costs correctly', () => {
      expect(formatCost(12.5)).toBe('$12.50');
      expect(formatCost(99.99)).toBe('$99.99');
      expect(formatCost(1234.56)).toBe('$1234.56');
    });

    it('formats zero cost', () => {
      expect(formatCost(0)).toBe('$0.00');
    });

    it('rounds to 2 decimal places', () => {
      // WHY: JavaScript toFixed() uses IEEE 754 rounding — 12.555 in float
      // is actually 12.554999... so it rounds down.
      expect(formatCost(12.555)).toBe('$12.55');
      expect(formatCost(12.554)).toBe('$12.55');
      expect(formatCost(12.556)).toBe('$12.56');
    });

    it('formats small fractional costs', () => {
      expect(formatCost(0.01)).toBe('$0.01');
      expect(formatCost(0.001)).toBe('$0.00');
    });
  });

  describe('custom decimal places', () => {
    it('formats with 0 decimals', () => {
      // WHY: (12.5).toFixed(0) rounds to '13' in JS (banker's rounding)
      expect(formatCost(12.5, 0)).toBe('$13');
      expect(formatCost(12.4, 0)).toBe('$12');
      expect(formatCost(12.9, 0)).toBe('$13');
      expect(formatCost(99.99, 0)).toBe('$100');
    });

    it('formats with 4 decimals', () => {
      expect(formatCost(0.0042, 4)).toBe('$0.0042');
      expect(formatCost(12.5, 4)).toBe('$12.5000');
      expect(formatCost(99.9999, 4)).toBe('$99.9999');
    });

    it('formats with 1 decimal', () => {
      expect(formatCost(12.56, 1)).toBe('$12.6');
      expect(formatCost(12.54, 1)).toBe('$12.5');
    });

    it('formats with 3 decimals', () => {
      expect(formatCost(12.5678, 3)).toBe('$12.568');
      expect(formatCost(0.123, 3)).toBe('$0.123');
    });
  });

  describe('large cost values', () => {
    it('formats costs over $1000', () => {
      expect(formatCost(1234.56)).toBe('$1234.56');
      expect(formatCost(10000.99)).toBe('$10000.99');
    });

    it('formats costs over $1 million', () => {
      expect(formatCost(1234567.89)).toBe('$1234567.89');
    });
  });

  describe('edge cases', () => {
    it('handles negative costs', () => {
      expect(formatCost(-12.5)).toBe('$-12.50');
      expect(formatCost(-0.01)).toBe('$-0.01');
    });

    it('handles very small costs with high precision', () => {
      expect(formatCost(0.000001, 6)).toBe('$0.000001');
      expect(formatCost(0.0000001, 7)).toBe('$0.0000001');
    });

    it('handles whole numbers', () => {
      expect(formatCost(100)).toBe('$100.00');
      expect(formatCost(1000, 0)).toBe('$1000');
    });
  });
});

describe('formatTokens', () => {
  describe('values under 1000', () => {
    it('returns raw number as string', () => {
      expect(formatTokens(0)).toBe('0');
      expect(formatTokens(1)).toBe('1');
      expect(formatTokens(500)).toBe('500');
      expect(formatTokens(999)).toBe('999');
    });
  });

  describe('thousands range (1K - 999K)', () => {
    it('formats exactly 1000', () => {
      expect(formatTokens(1000)).toBe('1.0K');
    });

    it('formats thousands with 1 decimal', () => {
      expect(formatTokens(1500)).toBe('1.5K');
      expect(formatTokens(2300)).toBe('2.3K');
      expect(formatTokens(15000)).toBe('15.0K');
      expect(formatTokens(150000)).toBe('150.0K');
    });

    it('rounds to 1 decimal place', () => {
      expect(formatTokens(1550)).toBe('1.6K');
      expect(formatTokens(1549)).toBe('1.5K');
      expect(formatTokens(1234)).toBe('1.2K');
    });

    it('formats boundary at 999,999', () => {
      expect(formatTokens(999999)).toBe('1000.0K');
    });
  });

  describe('millions range (1M+)', () => {
    it('formats exactly 1 million', () => {
      expect(formatTokens(1000000)).toBe('1.0M');
    });

    it('formats millions with 1 decimal', () => {
      expect(formatTokens(1500000)).toBe('1.5M');
      expect(formatTokens(2300000)).toBe('2.3M');
      expect(formatTokens(15000000)).toBe('15.0M');
      expect(formatTokens(150000000)).toBe('150.0M');
    });

    it('rounds to 1 decimal place', () => {
      expect(formatTokens(1550000)).toBe('1.6M');
      expect(formatTokens(1549000)).toBe('1.5M');
      expect(formatTokens(1234567)).toBe('1.2M');
    });
  });

  describe('boundary values', () => {
    it('handles boundary at 999 (stays as number)', () => {
      expect(formatTokens(999)).toBe('999');
    });

    it('handles boundary at 1000 (switches to K)', () => {
      expect(formatTokens(1000)).toBe('1.0K');
    });

    it('handles boundary at 999,999 (stays as K)', () => {
      expect(formatTokens(999999)).toBe('1000.0K');
    });

    it('handles boundary at 1,000,000 (switches to M)', () => {
      expect(formatTokens(1000000)).toBe('1.0M');
    });
  });

  describe('edge cases', () => {
    it('handles zero tokens', () => {
      expect(formatTokens(0)).toBe('0');
    });

    it('handles very large token counts', () => {
      expect(formatTokens(1000000000)).toBe('1000.0M');
      expect(formatTokens(5500000000)).toBe('5500.0M');
    });
  });
});

describe('getAgentColor', () => {
  describe('known agent types', () => {
    it('returns correct color for claude', () => {
      expect(getAgentColor('claude')).toBe('bg-orange-500');
    });

    it('returns correct color for codex', () => {
      expect(getAgentColor('codex')).toBe('bg-green-500');
    });

    it('returns correct color for gemini', () => {
      expect(getAgentColor('gemini')).toBe('bg-blue-500');
    });

    it('returns correct color for opencode', () => {
      expect(getAgentColor('opencode')).toBe('bg-purple-500');
    });

    it('returns correct color for aider', () => {
      expect(getAgentColor('aider')).toBe('bg-pink-500');
    });
  });

  describe('unknown agent type', () => {
    it('returns fallback color for unknown agent', () => {
      // TypeScript would normally prevent this, but testing runtime behavior
      const unknownAgent = 'unknown' as AgentType;
      expect(getAgentColor(unknownAgent)).toBe('bg-zinc-500');
    });

    it('returns fallback color for empty string', () => {
      const emptyAgent = '' as AgentType;
      expect(getAgentColor(emptyAgent)).toBe('bg-zinc-500');
    });
  });

  describe('all agent types return valid Tailwind classes', () => {
    it('all colors follow bg-{color}-500 pattern', () => {
      const agents: AgentType[] = ['claude', 'codex', 'gemini', 'opencode', 'aider'];
      const validPattern = /^bg-\w+-500$/;

      agents.forEach((agent) => {
        const color = getAgentColor(agent);
        expect(color).toMatch(validPattern);
      });
    });
  });
});
