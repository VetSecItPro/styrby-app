/**
 * Tests for computeMcpReadiness (Cluster B2b).
 *
 * The readiness logic decides whether a user's wired-up MCP snippet will work
 * and what to do about each gap. Pinning it here keeps the "machine is the only
 * hard gate" rule and the per-tool gating from drifting.
 *
 * @module app/dashboard/tools/__tests__/mcp-readiness
 */

import { describe, it, expect } from 'vitest';
import { computeMcpReadiness } from '../mcp-readiness';

describe('computeMcpReadiness', () => {
  it('is not-connected and flags the CLI when no machine is registered', () => {
    const r = computeMcpReadiness({
      machineCount: 0,
      hasOnlineMachine: false,
      deviceTokenCount: 0,
      hasTeam: false,
    });
    expect(r.overall).toBe('not-connected');
    const cli = r.checks.find((c) => c.id === 'cli')!;
    expect(cli.status).toBe('action-needed');
    expect(cli.fix).toBe('styrby onboard');
  });

  it('is ready once at least one machine exists', () => {
    const r = computeMcpReadiness({
      machineCount: 1,
      hasOnlineMachine: false,
      deviceTokenCount: 0,
      hasTeam: false,
    });
    expect(r.overall).toBe('ready');
    expect(r.checks.find((c) => c.id === 'cli')!.status).toBe('ready');
  });

  it('reflects online vs offline machine in the CLI detail', () => {
    const online = computeMcpReadiness({ machineCount: 2, hasOnlineMachine: true, deviceTokenCount: 0, hasTeam: false });
    const offline = computeMcpReadiness({ machineCount: 2, hasOnlineMachine: false, deviceTokenCount: 0, hasTeam: false });
    expect(online.checks.find((c) => c.id === 'cli')!.detail).toMatch(/online/i);
    expect(offline.checks.find((c) => c.id === 'cli')!.detail).toMatch(/none currently online/i);
  });

  it('marks approvals recommended (not blocking) without a push device', () => {
    const r = computeMcpReadiness({ machineCount: 1, hasOnlineMachine: true, deviceTokenCount: 0, hasTeam: false });
    const approvals = r.checks.find((c) => c.id === 'approvals')!;
    expect(approvals.status).toBe('recommended');
    expect(r.overall).toBe('ready'); // soft gap does not block overall
  });

  it('marks approvals ready with a push device', () => {
    const r = computeMcpReadiness({ machineCount: 1, hasOnlineMachine: true, deviceTokenCount: 3, hasTeam: false });
    const approvals = r.checks.find((c) => c.id === 'approvals')!;
    expect(approvals.status).toBe('ready');
    expect(approvals.detail).toMatch(/3 devices/);
  });

  it('marks team policy optional off a team, ready on a team', () => {
    const off = computeMcpReadiness({ machineCount: 1, hasOnlineMachine: true, deviceTokenCount: 0, hasTeam: false });
    const on = computeMcpReadiness({ machineCount: 1, hasOnlineMachine: true, deviceTokenCount: 0, hasTeam: true });
    expect(off.checks.find((c) => c.id === 'team-policy')!.status).toBe('optional');
    expect(on.checks.find((c) => c.id === 'team-policy')!.status).toBe('ready');
  });

  it('pins singular/plural grammar for one machine', () => {
    const r = computeMcpReadiness({ machineCount: 1, hasOnlineMachine: true, deviceTokenCount: 0, hasTeam: false });
    expect(r.checks.find((c) => c.id === 'cli')!.detail).toMatch(/1 machine /);
  });

  it('always returns the three checks gating the three GA tools', () => {
    const r = computeMcpReadiness({ machineCount: 1, hasOnlineMachine: true, deviceTokenCount: 1, hasTeam: true });
    expect(r.checks.map((c) => c.id).sort()).toEqual(['approvals', 'cli', 'team-policy']);
    expect(r.checks.find((c) => c.id === 'approvals')!.gates).toBe('request_approval');
    expect(r.checks.find((c) => c.id === 'team-policy')!.gates).toBe('get_team_policy');
  });
});
