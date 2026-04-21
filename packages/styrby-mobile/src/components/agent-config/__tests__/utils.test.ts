/**
 * Tests for agent-config/utils — Phase 1 #4 batch 1 follow-up.
 *
 * Pure conversion + dirty-check helpers. No React, no Supabase.
 *
 * @module components/agent-config/__tests__/utils
 */

import { patternsToToggles, togglesToPatterns, hasChanges } from '../utils';
import type { AgentConfigState } from '@/types/agent-config';

const baseState: AgentConfigState = {
  model: 'claude-sonnet-4',
  autoApproveReads: false,
  autoApproveWrites: false,
  autoApproveCommands: false,
  autoApproveWeb: false,
  blockedTools: [],
  maxCostPerSession: '5.00',
  customSystemPrompt: '',
};

describe('patternsToToggles', () => {
  it('returns all-false for an empty patterns array', () => {
    expect(patternsToToggles([])).toEqual({
      autoApproveReads: false,
      autoApproveWrites: false,
      autoApproveCommands: false,
      autoApproveWeb: false,
    });
  });

  it('maps each pattern string to its corresponding toggle', () => {
    expect(patternsToToggles(['file_read'])).toMatchObject({ autoApproveReads: true });
    expect(patternsToToggles(['file_write'])).toMatchObject({ autoApproveWrites: true });
    expect(patternsToToggles(['terminal_command'])).toMatchObject({ autoApproveCommands: true });
    expect(patternsToToggles(['web_search'])).toMatchObject({ autoApproveWeb: true });
  });

  it('handles all-on input', () => {
    const all = ['file_read', 'file_write', 'terminal_command', 'web_search'];
    expect(patternsToToggles(all)).toEqual({
      autoApproveReads: true,
      autoApproveWrites: true,
      autoApproveCommands: true,
      autoApproveWeb: true,
    });
  });

  it('ignores unknown patterns', () => {
    expect(patternsToToggles(['file_read', 'unknown_pattern'])).toMatchObject({
      autoApproveReads: true,
      autoApproveWrites: false,
    });
  });
});

describe('togglesToPatterns', () => {
  it('returns an empty array when no toggles are on', () => {
    expect(togglesToPatterns(baseState)).toEqual([]);
  });

  it('emits one pattern per enabled toggle', () => {
    const state: AgentConfigState = { ...baseState, autoApproveReads: true };
    expect(togglesToPatterns(state)).toEqual(['file_read']);
  });

  it('emits patterns in stable order for all-on', () => {
    const state: AgentConfigState = {
      ...baseState,
      autoApproveReads: true,
      autoApproveWrites: true,
      autoApproveCommands: true,
      autoApproveWeb: true,
    };
    expect(togglesToPatterns(state)).toEqual([
      'file_read',
      'file_write',
      'terminal_command',
      'web_search',
    ]);
  });

  it('round-trips: patternsToToggles → togglesToPatterns is identity', () => {
    const start = ['file_read', 'web_search'];
    const toggles = patternsToToggles(start);
    const round = togglesToPatterns({ ...baseState, ...toggles });
    expect(round).toEqual(start);
  });
});

describe('hasChanges', () => {
  it('returns false when current === saved (deep)', () => {
    expect(hasChanges(baseState, { ...baseState })).toBe(false);
  });

  it('detects model change', () => {
    expect(hasChanges({ ...baseState, model: 'gpt-4o' }, baseState)).toBe(true);
  });

  it('detects each toggle change individually', () => {
    expect(hasChanges({ ...baseState, autoApproveReads: true }, baseState)).toBe(true);
    expect(hasChanges({ ...baseState, autoApproveWrites: true }, baseState)).toBe(true);
    expect(hasChanges({ ...baseState, autoApproveCommands: true }, baseState)).toBe(true);
    expect(hasChanges({ ...baseState, autoApproveWeb: true }, baseState)).toBe(true);
  });

  it('detects cost limit change', () => {
    expect(hasChanges({ ...baseState, maxCostPerSession: '10.00' }, baseState)).toBe(true);
  });

  it('detects custom prompt change', () => {
    expect(hasChanges({ ...baseState, customSystemPrompt: 'Hello' }, baseState)).toBe(true);
  });

  it('detects blockedTools change (deep array compare)', () => {
    expect(hasChanges({ ...baseState, blockedTools: ['rm -rf'] }, baseState)).toBe(true);
  });

  it('returns false when blockedTools arrays have identical contents but different identities', () => {
    expect(
      hasChanges(
        { ...baseState, blockedTools: ['rm -rf', 'curl'] },
        { ...baseState, blockedTools: ['rm -rf', 'curl'] },
      ),
    ).toBe(false);
  });

  it('returns true when blockedTools order differs', () => {
    // WHY: JSON.stringify is order-sensitive. Documenting this as the
    // intentional behavior so future maintainers don't "fix" it by sorting.
    expect(
      hasChanges(
        { ...baseState, blockedTools: ['curl', 'rm -rf'] },
        { ...baseState, blockedTools: ['rm -rf', 'curl'] },
      ),
    ).toBe(true);
  });
});
