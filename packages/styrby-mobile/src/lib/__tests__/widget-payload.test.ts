/**
 * Tests for the home-screen widget payload builder (Cluster C1).
 *
 * This is the wire contract between the RN app and the Swift widget; pinning it
 * keeps the App Group keys + the active/terminal status mapping from drifting
 * (the Swift side reads these exact keys by name).
 *
 * @module lib/__tests__/widget-payload
 */

import { buildWidgetPayload } from '../widget-payload';

describe('buildWidgetPayload', () => {
  it('returns the empty state for a null session', () => {
    const p = buildWidgetPayload(null);
    expect(p.hasSession).toBe('false');
    expect(p.agent).toBe('');
    expect(p.isActive).toBe('false');
  });

  it('maps an active running session', () => {
    const p = buildWidgetPayload({
      agentType: 'claude',
      status: 'running',
      title: 'Refactor auth',
      totalCostUsd: 0.04,
      updatedAt: '2026-06-13T12:00:00Z',
    });
    expect(p).toEqual({
      hasSession: 'true',
      agent: 'claude',
      statusLabel: 'Running',
      isActive: 'true',
      title: 'Refactor auth',
      cost: '$0.0400',
      updatedAt: '2026-06-13T12:00:00Z',
    });
  });

  it('treats starting/idle/paused as active and completed/error as terminal', () => {
    const active = ['starting', 'running', 'idle', 'paused'];
    const terminal = ['completed', 'error'];
    for (const status of active) {
      expect(buildWidgetPayload({ agentType: 'codex', status, title: null, totalCostUsd: 0, updatedAt: 'x' }).isActive).toBe('true');
    }
    for (const status of terminal) {
      expect(buildWidgetPayload({ agentType: 'codex', status, title: null, totalCostUsd: 0, updatedAt: 'x' }).isActive).toBe('false');
    }
  });

  it('falls back to a placeholder title when title is empty/blank', () => {
    expect(buildWidgetPayload({ agentType: 'amp', status: 'idle', title: null, totalCostUsd: 0, updatedAt: 'x' }).title).toBe('Untitled session');
    expect(buildWidgetPayload({ agentType: 'amp', status: 'idle', title: '   ', totalCostUsd: 0, updatedAt: 'x' }).title).toBe('Untitled session');
  });

  it('formats cost to 4 decimals and tolerates missing cost', () => {
    expect(buildWidgetPayload({ agentType: 'amp', status: 'idle', title: 't', totalCostUsd: 1.2, updatedAt: 'x' }).cost).toBe('$1.2000');
    // @ts-expect-error exercising a defensive runtime path for undefined cost
    expect(buildWidgetPayload({ agentType: 'amp', status: 'idle', title: 't', totalCostUsd: undefined, updatedAt: 'x' }).cost).toBe('$0.0000');
  });

  it('passes through an unknown status as its own label', () => {
    const p = buildWidgetPayload({ agentType: 'kiro', status: 'mystery', title: 't', totalCostUsd: 0, updatedAt: 'x' });
    expect(p.statusLabel).toBe('mystery');
    expect(p.isActive).toBe('false');
  });
});
