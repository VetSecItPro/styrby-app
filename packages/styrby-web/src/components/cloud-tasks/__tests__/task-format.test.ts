/**
 * Tests for the web cloud-tasks formatter + stats + mapper (Cluster A2 split).
 *
 * These pure helpers were untestable while embedded in cloud-tasks.tsx;
 * extracting them made them directly verifiable. computeTaskStats in particular
 * guards the single-pass O(n) tally that recomputes on every Realtime event.
 *
 * @module components/cloud-tasks/__tests__/task-format
 */

import { describe, it, expect } from 'vitest';
import type { CloudTask, CloudTaskStatus } from '@styrby/shared';
import { formatRelativeTime, computeTaskStats } from '../task-format';
import { rowToTask } from '../rowToTask';

function task(status: CloudTaskStatus): CloudTask {
  return {
    id: `t-${status}`,
    sessionId: null,
    agentType: 'claude',
    status,
    prompt: 'p',
    startedAt: '2026-06-12T00:00:00Z',
  } as CloudTask;
}

describe('formatRelativeTime', () => {
  it('shows "just now" under a minute', () => {
    expect(formatRelativeTime(new Date(Date.now() - 10_000).toISOString())).toBe('just now');
  });
  it('shows minutes under an hour', () => {
    expect(formatRelativeTime(new Date(Date.now() - 5 * 60_000).toISOString())).toBe('5m ago');
  });
  it('shows hours under a day', () => {
    expect(formatRelativeTime(new Date(Date.now() - 3 * 3_600_000).toISOString())).toBe('3h ago');
  });
  it('shows "Yesterday" past 24h', () => {
    expect(formatRelativeTime(new Date(Date.now() - 30 * 3_600_000).toISOString())).toBe('Yesterday');
  });
});

describe('computeTaskStats', () => {
  it('returns all zeros for an empty list', () => {
    expect(computeTaskStats([])).toEqual({ running: 0, queued: 0, completed: 0, failed: 0 });
  });

  it('tallies each tracked status in one pass and ignores cancelled', () => {
    const tasks = [
      task('running'),
      task('running'),
      task('queued'),
      task('completed'),
      task('failed'),
      task('cancelled'), // not counted in any bucket
    ];
    expect(computeTaskStats(tasks)).toEqual({ running: 2, queued: 1, completed: 1, failed: 1 });
  });
});

describe('rowToTask', () => {
  it('maps snake_case columns to the camelCase shape', () => {
    const t = rowToTask({
      id: 'c1',
      session_id: 's1',
      agent_type: 'codex',
      status: 'running',
      prompt: 'do it',
      result: undefined,
      error_message: undefined,
      started_at: '2026-06-12T00:00:00Z',
      cost_usd: 0.05,
      metadata: { gitBranch: 'main' },
    });
    expect(t).toMatchObject({
      id: 'c1',
      sessionId: 's1',
      agentType: 'codex',
      status: 'running',
      prompt: 'do it',
      startedAt: '2026-06-12T00:00:00Z',
      costUsd: 0.05,
    });
  });

  it('defaults a null session_id to null', () => {
    const t = rowToTask({ id: 'c2', session_id: null, agent_type: 'claude', status: 'queued', prompt: 'x', started_at: 'now' });
    expect(t.sessionId).toBeNull();
  });
});
