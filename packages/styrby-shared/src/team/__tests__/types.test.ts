/**
 * Tests for team-governance zod schemas and literal-union types.
 *
 * The schemas are the contract between the server (migration 021) and
 * every client surface. A regression here is a silent cross-tenant
 * bug waiting to happen.
 *
 * @module team/__tests__/types
 */

import { describe, it, expect } from 'vitest';
import {
  approvalSchema,
  billingEventSchema,
  exportRequestSchema,
  integrationSchema,
  sessionShareSchema,
  teamPolicySchema,
  ALL_POLICY_ROLES,
  POLICY_ENGINE_EXIT_CODES,
  type PolicyRole,
  type Permission,
} from '../types.js';

const UUID = '00000000-0000-0000-0000-000000000001';
const ISO = '2026-04-20T00:00:00.000Z';

describe('teamPolicySchema', () => {
  const base = {
    id: UUID,
    teamId: UUID,
    name: 'Block risky tools',
    description: null,
    ruleType: 'tool_allowlist' as const,
    threshold: null,
    approverRole: 'admin' as const,
    approverUserId: null,
    agentFilter: ['bash'],
    action: 'require_approval' as const,
    settings: {},
    enabled: true,
    priority: 100,
    createdBy: UUID,
    createdAt: ISO,
    updatedAt: ISO,
  };

  it('accepts a valid row', () => {
    expect(() => teamPolicySchema.parse(base)).not.toThrow();
  });

  it('rejects empty name', () => {
    expect(() => teamPolicySchema.parse({ ...base, name: '' })).toThrow();
  });

  it('rejects over-long name', () => {
    expect(() => teamPolicySchema.parse({ ...base, name: 'x'.repeat(201) })).toThrow();
  });

  it('rejects unknown ruleType', () => {
    expect(() =>
      teamPolicySchema.parse({ ...base, ruleType: 'made_up' as unknown as 'cost_threshold' }),
    ).toThrow();
  });

  it('rejects unknown action', () => {
    expect(() =>
      teamPolicySchema.parse({ ...base, action: 'nuke' as unknown as 'block' }),
    ).toThrow();
  });

  it('allows null approverRole (default admin-or-owner)', () => {
    expect(() =>
      teamPolicySchema.parse({ ...base, approverRole: null }),
    ).not.toThrow();
  });
});

describe('approvalSchema', () => {
  const base = {
    id: UUID,
    teamId: UUID,
    sessionId: UUID,
    policyId: UUID,
    requesterUserId: UUID,
    toolName: 'Bash',
    estimatedCostUsd: 0.05,
    requestPayload: { command: 'ls' },
    status: 'pending' as const,
    resolverUserId: null,
    resolutionNote: null,
    expiresAt: ISO,
    createdAt: ISO,
    resolvedAt: null,
  };

  it('accepts each valid status', () => {
    for (const status of ['pending', 'approved', 'denied', 'expired', 'cancelled'] as const) {
      expect(() => approvalSchema.parse({ ...base, status })).not.toThrow();
    }
  });

  it('rejects empty toolName', () => {
    expect(() => approvalSchema.parse({ ...base, toolName: '' })).toThrow();
  });

  it('rejects unknown status', () => {
    expect(() =>
      approvalSchema.parse({ ...base, status: 'ghosted' as unknown as 'pending' }),
    ).toThrow();
  });
});

describe('sessionShareSchema', () => {
  it('accepts a valid share', () => {
    expect(() =>
      sessionShareSchema.parse({
        id: UUID,
        sessionId: UUID,
        sharedWithUserId: UUID,
        sharedByUserId: UUID,
        permission: 'view',
        expiresAt: null,
        createdAt: ISO,
        revokedAt: null,
      }),
    ).not.toThrow();
  });
});

describe('exportRequestSchema', () => {
  it('accepts a ready export', () => {
    expect(() =>
      exportRequestSchema.parse({
        id: UUID,
        userId: UUID,
        format: 'zip',
        scope: 'all',
        status: 'ready',
        errorMessage: null,
        downloadUrl: 'https://storage.example/obj',
        downloadPath: 'exports/abc.zip',
        sizeBytes: 1024,
        expiresAt: ISO,
        createdAt: ISO,
        completedAt: ISO,
      }),
    ).not.toThrow();
  });
});

describe('integrationSchema', () => {
  it('accepts an active integration', () => {
    expect(() =>
      integrationSchema.parse({
        id: UUID,
        teamId: UUID,
        provider: 'slack',
        displayName: 'Engineering',
        externalAccountId: 'T0001',
        configEncrypted: 'base64opaque==',
        encryptionKeyId: 'default',
        status: 'active',
        lastError: null,
        installedBy: UUID,
        installedAt: ISO,
        updatedAt: ISO,
      }),
    ).not.toThrow();
  });
});

describe('billingEventSchema', () => {
  it('accepts a received Polar event', () => {
    expect(() =>
      billingEventSchema.parse({
        id: UUID,
        userId: UUID,
        subscriptionId: UUID,
        eventType: 'subscription.created',
        amountUsd: 49.0,
        currency: 'USD',
        status: 'received',
        polarEventId: 'evt_abc',
        rawPayload: { polar: 'raw' },
        processedAt: null,
        createdAt: ISO,
      }),
    ).not.toThrow();
  });

  it('rejects empty polarEventId', () => {
    expect(() =>
      billingEventSchema.parse({
        id: UUID,
        userId: null,
        subscriptionId: null,
        eventType: 'subscription.created',
        amountUsd: null,
        currency: null,
        status: 'received',
        polarEventId: '',
        rawPayload: {},
        processedAt: null,
        createdAt: ISO,
      }),
    ).toThrow();
  });
});

describe('type-level invariants', () => {
  it('ALL_POLICY_ROLES enumerates every PolicyRole once', () => {
    const expected: PolicyRole[] = ['owner', 'admin', 'approver', 'member'];
    expect([...ALL_POLICY_ROLES].sort()).toEqual(expected.sort());
  });

  it('Permission union covers all five governance capabilities', () => {
    // Assignment is the assertion — typecheck fails if a variant is missing.
    const perms: Permission[] = [
      'invite',
      'revokeMember',
      'approve',
      'editPolicy',
      'manageBilling',
    ];
    expect(perms).toHaveLength(5);
  });

  it('exit codes are stable', () => {
    expect(POLICY_ENGINE_EXIT_CODES).toEqual({
      APPROVED: 0,
      DENIED: 10,
      TIMEOUT: 124,
      CANCELLED: 130,
    });
  });
});
