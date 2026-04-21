/**
 * Tests for Team tier types and Zod schemas (Phase 0.8.7).
 *
 * Strategy: validate that every schema accepts valid data, rejects invalid
 * data, and that runtime constant arrays contain all expected values.
 * We do NOT test TS type inference — that is verified by `typecheck`.
 *
 * @module teams/__tests__/types
 */

import { describe, it, expect } from 'vitest';
import {
  TEAM_ROLES,
  POLICY_TYPES,
  DB_APPROVAL_STATUSES,
  TEAM_TIER_IDS,
  TeamSchema,
  TeamMemberSchema,
  TeamInvitationSchema,
  DbTeamPolicySchema,
  TeamApprovalRequestSchema,
  SharedSessionSchema,
  TeamExportSchema,
  TeamBillingEventSchema,
} from '../types.js';

// ---------------------------------------------------------------------------
// Constant arrays
// ---------------------------------------------------------------------------

describe('TEAM_ROLES', () => {
  it('contains owner, admin, and member', () => {
    expect(TEAM_ROLES).toContain('owner');
    expect(TEAM_ROLES).toContain('admin');
    expect(TEAM_ROLES).toContain('member');
    expect(TEAM_ROLES).toHaveLength(3);
  });
});

describe('POLICY_TYPES', () => {
  it('contains all four policy types', () => {
    expect(POLICY_TYPES).toContain('blocked_agents');
    expect(POLICY_TYPES).toContain('cost_cap');
    expect(POLICY_TYPES).toContain('working_hours');
    expect(POLICY_TYPES).toContain('require_approval');
    expect(POLICY_TYPES).toHaveLength(4);
  });
});

describe('DB_APPROVAL_STATUSES', () => {
  it('contains pending, approved, rejected, and expired', () => {
    expect(DB_APPROVAL_STATUSES).toContain('pending');
    expect(DB_APPROVAL_STATUSES).toContain('approved');
    expect(DB_APPROVAL_STATUSES).toContain('rejected');
    expect(DB_APPROVAL_STATUSES).toContain('expired');
    expect(DB_APPROVAL_STATUSES).toHaveLength(4);
  });
});

describe('TEAM_TIER_IDS', () => {
  it('contains team, business, and enterprise', () => {
    expect(TEAM_TIER_IDS).toContain('team');
    expect(TEAM_TIER_IDS).toContain('business');
    expect(TEAM_TIER_IDS).toContain('enterprise');
    expect(TEAM_TIER_IDS).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Helper: minimal valid fixtures
// ---------------------------------------------------------------------------

const uuid = '00000000-0000-0000-0000-000000000001';
const uuid2 = '00000000-0000-0000-0000-000000000002';
const ts = '2026-04-21T00:00:00.000Z';

// ---------------------------------------------------------------------------
// TeamSchema
// ---------------------------------------------------------------------------

describe('TeamSchema', () => {
  const valid = {
    id: uuid,
    name: 'Acme Corp',
    slug: 'acme-corp',
    ownerId: uuid2,
    createdAt: ts,
    updatedAt: ts,
    tier: 'team' as const,
    seatCount: 3,
    billingOrgId: null,
  };

  it('accepts a valid team object', () => {
    expect(() => TeamSchema.parse(valid)).not.toThrow();
  });

  it('accepts billingOrgId as a string', () => {
    expect(() => TeamSchema.parse({ ...valid, billingOrgId: 'org_123' })).not.toThrow();
  });

  it('accepts tier = business', () => {
    expect(() => TeamSchema.parse({ ...valid, tier: 'business' })).not.toThrow();
  });

  it('accepts tier = enterprise', () => {
    expect(() => TeamSchema.parse({ ...valid, tier: 'enterprise' })).not.toThrow();
  });

  it('rejects tier = free (not a team tier)', () => {
    expect(() => TeamSchema.parse({ ...valid, tier: 'free' })).toThrow();
  });

  it('rejects invalid slug (uppercase)', () => {
    expect(() => TeamSchema.parse({ ...valid, slug: 'Acme-Corp' })).toThrow();
  });

  it('rejects empty name', () => {
    expect(() => TeamSchema.parse({ ...valid, name: '' })).toThrow();
  });

  it('rejects non-integer seatCount', () => {
    expect(() => TeamSchema.parse({ ...valid, seatCount: 1.5 })).toThrow();
  });

  it('rejects seatCount < 1', () => {
    expect(() => TeamSchema.parse({ ...valid, seatCount: 0 })).toThrow();
  });

  it('rejects non-UUID id', () => {
    expect(() => TeamSchema.parse({ ...valid, id: 'not-a-uuid' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// TeamMemberSchema
// ---------------------------------------------------------------------------

describe('TeamMemberSchema', () => {
  const valid = {
    id: uuid,
    teamId: uuid,
    userId: uuid2,
    role: 'member' as const,
    invitedBy: uuid2,
    joinedAt: ts,
  };

  it('accepts a valid member row', () => {
    expect(() => TeamMemberSchema.parse(valid)).not.toThrow();
  });

  it('accepts invitedBy = null (founding owner)', () => {
    expect(() => TeamMemberSchema.parse({ ...valid, invitedBy: null })).not.toThrow();
  });

  it('accepts role = owner', () => {
    expect(() => TeamMemberSchema.parse({ ...valid, role: 'owner' })).not.toThrow();
  });

  it('accepts role = admin', () => {
    expect(() => TeamMemberSchema.parse({ ...valid, role: 'admin' })).not.toThrow();
  });

  it('rejects unknown role', () => {
    expect(() => TeamMemberSchema.parse({ ...valid, role: 'superadmin' })).toThrow();
  });

  it('rejects non-UUID invitedBy', () => {
    expect(() => TeamMemberSchema.parse({ ...valid, invitedBy: 'not-a-uuid' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// TeamInvitationSchema
// ---------------------------------------------------------------------------

describe('TeamInvitationSchema', () => {
  const valid = {
    id: uuid,
    teamId: uuid,
    email: 'alice@example.com',
    role: 'member' as const,
    invitedBy: uuid2,
    token: 'tok_abc123',
    expiresAt: ts,
    acceptedAt: null,
  };

  it('accepts a valid pending invitation', () => {
    expect(() => TeamInvitationSchema.parse(valid)).not.toThrow();
  });

  it('accepts acceptedAt as a datetime string', () => {
    expect(() => TeamInvitationSchema.parse({ ...valid, acceptedAt: ts })).not.toThrow();
  });

  it('rejects invalid email', () => {
    expect(() => TeamInvitationSchema.parse({ ...valid, email: 'not-an-email' })).toThrow();
  });

  it('rejects empty token', () => {
    expect(() => TeamInvitationSchema.parse({ ...valid, token: '' })).toThrow();
  });

  it('rejects unknown role', () => {
    expect(() => TeamInvitationSchema.parse({ ...valid, role: 'viewer' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// DbTeamPolicySchema
// ---------------------------------------------------------------------------

describe('DbTeamPolicySchema', () => {
  const valid = {
    id: uuid,
    teamId: uuid,
    policyType: 'cost_cap' as const,
    value: { limitUsd: 100, period: 'daily' },
    enabledAt: ts,
  };

  it('accepts a valid policy row', () => {
    expect(() => DbTeamPolicySchema.parse(valid)).not.toThrow();
  });

  it('accepts all policyType values', () => {
    for (const pt of POLICY_TYPES) {
      expect(() => DbTeamPolicySchema.parse({ ...valid, policyType: pt })).not.toThrow();
    }
  });

  it('accepts arbitrary value shapes (unknown)', () => {
    expect(() => DbTeamPolicySchema.parse({ ...valid, value: [1, 2, 3] })).not.toThrow();
    expect(() => DbTeamPolicySchema.parse({ ...valid, value: 'string' })).not.toThrow();
    expect(() => DbTeamPolicySchema.parse({ ...valid, value: null })).not.toThrow();
  });

  it('rejects unknown policyType', () => {
    expect(() => DbTeamPolicySchema.parse({ ...valid, policyType: 'unknown_policy' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// TeamApprovalRequestSchema
// ---------------------------------------------------------------------------

describe('TeamApprovalRequestSchema', () => {
  const valid = {
    id: uuid,
    teamId: uuid,
    requesterId: uuid,
    approverId: null,
    command: 'rm -rf /tmp/build',
    status: 'pending' as const,
    createdAt: ts,
    resolvedAt: null,
  };

  it('accepts a valid pending approval request', () => {
    expect(() => TeamApprovalRequestSchema.parse(valid)).not.toThrow();
  });

  it('accepts all status values', () => {
    for (const st of DB_APPROVAL_STATUSES) {
      expect(() => TeamApprovalRequestSchema.parse({ ...valid, status: st })).not.toThrow();
    }
  });

  it('accepts approverId as uuid when resolved', () => {
    expect(() =>
      TeamApprovalRequestSchema.parse({
        ...valid,
        approverId: uuid2,
        status: 'approved',
        resolvedAt: ts,
      })
    ).not.toThrow();
  });

  it('rejects empty command', () => {
    expect(() => TeamApprovalRequestSchema.parse({ ...valid, command: '' })).toThrow();
  });

  it('rejects unknown status', () => {
    expect(() => TeamApprovalRequestSchema.parse({ ...valid, status: 'waiting' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// SharedSessionSchema
// ---------------------------------------------------------------------------

describe('SharedSessionSchema', () => {
  const valid = {
    id: uuid,
    teamId: uuid,
    sessionId: uuid2,
    sharedByUserId: uuid,
    visibility: 'team' as const,
    createdAt: ts,
  };

  it('accepts team visibility', () => {
    expect(() => SharedSessionSchema.parse(valid)).not.toThrow();
  });

  it('accepts public_in_team visibility', () => {
    expect(() => SharedSessionSchema.parse({ ...valid, visibility: 'public_in_team' })).not.toThrow();
  });

  it('rejects unknown visibility', () => {
    expect(() => SharedSessionSchema.parse({ ...valid, visibility: 'private' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// TeamExportSchema
// ---------------------------------------------------------------------------

describe('TeamExportSchema', () => {
  const valid = {
    id: uuid,
    teamId: uuid,
    requesterId: uuid2,
    format: 'csv' as const,
    status: 'pending' as const,
    downloadUrl: null,
    expiresAt: null,
  };

  it('accepts a pending csv export', () => {
    expect(() => TeamExportSchema.parse(valid)).not.toThrow();
  });

  it('accepts format = json', () => {
    expect(() => TeamExportSchema.parse({ ...valid, format: 'json' })).not.toThrow();
  });

  it('accepts a ready export with downloadUrl', () => {
    expect(() =>
      TeamExportSchema.parse({
        ...valid,
        status: 'ready',
        downloadUrl: 'https://storage.supabase.co/team-exports/file.csv',
        expiresAt: ts,
      })
    ).not.toThrow();
  });

  it('accepts all status values', () => {
    for (const st of ['pending', 'processing', 'ready', 'failed'] as const) {
      expect(() => TeamExportSchema.parse({ ...valid, status: st })).not.toThrow();
    }
  });

  it('rejects unknown format', () => {
    expect(() => TeamExportSchema.parse({ ...valid, format: 'xml' })).toThrow();
  });

  it('rejects invalid downloadUrl', () => {
    expect(() =>
      TeamExportSchema.parse({ ...valid, status: 'ready', downloadUrl: 'not-a-url', expiresAt: ts })
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// TeamBillingEventSchema
// ---------------------------------------------------------------------------

describe('TeamBillingEventSchema', () => {
  const valid = {
    id: uuid,
    teamId: uuid,
    eventType: 'subscription.created',
    polarEventId: 'pol_evt_abc123',
    amountUsd: 5700, // $57.00 in cents
    occurredAt: ts,
  };

  it('accepts a valid billing event', () => {
    expect(() => TeamBillingEventSchema.parse(valid)).not.toThrow();
  });

  it('accepts amountUsd = 0 (non-monetary events)', () => {
    expect(() => TeamBillingEventSchema.parse({ ...valid, amountUsd: 0 })).not.toThrow();
  });

  it('rejects amountUsd < 0', () => {
    expect(() => TeamBillingEventSchema.parse({ ...valid, amountUsd: -1 })).toThrow();
  });

  it('rejects non-integer amountUsd', () => {
    expect(() => TeamBillingEventSchema.parse({ ...valid, amountUsd: 57.5 })).toThrow();
  });

  it('rejects empty eventType', () => {
    expect(() => TeamBillingEventSchema.parse({ ...valid, eventType: '' })).toThrow();
  });

  it('rejects empty polarEventId', () => {
    expect(() => TeamBillingEventSchema.parse({ ...valid, polarEventId: '' })).toThrow();
  });
});
