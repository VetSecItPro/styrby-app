/**
 * Tests for cloud-task formatters + row mapper (Cluster A2 split).
 *
 * These pure helpers were untested while embedded in CloudTasks.tsx; extracting
 * them made them directly testable.
 *
 * @module components/cloud-tasks/__tests__/task-format
 */

import { formatRelativeTime, formatCost, computeProgress } from '../task-format';
import { rowToTask } from '../rowToTask';

describe('formatCost', () => {
  it('returns empty string for undefined', () => {
    expect(formatCost(undefined)).toBe('');
  });
  it('formats to 4 decimals with a dollar sign', () => {
    expect(formatCost(0.04)).toBe('$0.0400');
    expect(formatCost(1.2)).toBe('$1.2000');
  });
});

describe('formatRelativeTime', () => {
  it('shows "just now" for <1 min', () => {
    expect(formatRelativeTime(new Date(Date.now() - 10_000).toISOString())).toBe('just now');
  });
  it('shows minutes for <1 hr', () => {
    expect(formatRelativeTime(new Date(Date.now() - 5 * 60_000).toISOString())).toBe('5 min ago');
  });
  it('shows hours (pluralized) for <24 hr', () => {
    expect(formatRelativeTime(new Date(Date.now() - 60 * 60_000).toISOString())).toBe('1 hr ago');
    expect(formatRelativeTime(new Date(Date.now() - 3 * 60 * 60_000).toISOString())).toBe('3 hrs ago');
  });
  it('shows "Yesterday" for >=24 hr', () => {
    expect(formatRelativeTime(new Date(Date.now() - 30 * 60 * 60_000).toISOString())).toBe('Yesterday');
  });
});

describe('computeProgress', () => {
  it('returns 0 when no estimate', () => {
    expect(computeProgress(new Date().toISOString())).toBe(0);
  });
  it('returns elapsed percentage of the estimate', () => {
    const started = new Date(Date.now() - 30_000).toISOString(); // 30s ago
    expect(computeProgress(started, 60_000)).toBe(50); // 30s / 60s
  });
  it('caps at 95% so a running bar never shows 100%', () => {
    const started = new Date(Date.now() - 120_000).toISOString(); // 2 min ago
    expect(computeProgress(started, 60_000)).toBe(95); // would be 200% → capped
  });
});

describe('rowToTask', () => {
  it('maps snake_case columns to the camelCase CloudTask shape', () => {
    const task = rowToTask({
      id: 't1',
      session_id: 's1',
      agent_type: 'claude',
      status: 'running',
      prompt: 'do the thing',
      result: undefined,
      error_message: undefined,
      started_at: '2026-06-12T00:00:00Z',
      completed_at: undefined,
      estimated_duration_ms: 60000,
      cost_usd: 0.04,
      metadata: { gitBranch: 'main' },
    });
    expect(task).toMatchObject({
      id: 't1',
      sessionId: 's1',
      agentType: 'claude',
      status: 'running',
      prompt: 'do the thing',
      startedAt: '2026-06-12T00:00:00Z',
      estimatedDurationMs: 60000,
      costUsd: 0.04,
    });
  });

  it('defaults a null session_id to null', () => {
    const task = rowToTask({ id: 't2', session_id: null, agent_type: 'codex', status: 'queued', prompt: 'x', started_at: 'now' });
    expect(task.sessionId).toBeNull();
  });
});
